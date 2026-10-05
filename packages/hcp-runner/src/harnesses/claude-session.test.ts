import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtemp, rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import type {Options, Query, SDKMessage, SDKUserMessage} from "@anthropic-ai/claude-agent-sdk";
import {hcpHarnessEventPayloadSchema, type HcpHarnessEventPayload, type HcpSessionStartPayload} from "@harness-control/protocol";
import {HarnessSessionManager, HarnessAdapterRegistry} from "./index.js";
import {ClaudeHarnessAdapter} from "./adapters.js";
import {RunnerConfigSchema} from "../config/index.js";
import {JsonRunnerStateStore} from "../state/index.js";
import type {ClaudeQueryFactory} from "./adapters/providers/claude-runtime.js";

class Messages implements AsyncIterable<SDKMessage> {
  readonly items: SDKMessage[] = [];
  wake: (() => void) | undefined;
  closed = false;
  offer(value: unknown) {this.items.push(value as SDKMessage); this.wake?.(); this.wake = undefined;}
  close() {this.closed = true; this.wake?.(); this.wake = undefined;}
  async *[Symbol.asyncIterator]() {while (!this.closed || this.items.length) {
    const message = this.items.shift(); if (message) yield message;
    else await new Promise<void>(resolve => {this.wake = resolve;});
  }}
}
async function until(predicate: () => boolean) {
  for (let n = 0; n < 500; n++) {if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 2));}
  throw new Error("Native fixture did not reach the expected observation.");
}
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "hcp-claude-persistent-"));
  const options: Options[] = [];
  const prompts: SDKUserMessage[] = [];
  const controls: string[] = [];
  const output = new Messages();
  let nativeId = "";
  let current: SDKUserMessage | undefined;
  let closes = 0;
  let echo = true;
  let completeOnStop = false;
  let failOpen = false, factoryCalls = 0;
  let confirmCompact = true;
  let effectiveEffort = "medium";
  const emit = (message: Record<string, unknown>) => output.offer({session_id: nativeId, ...message});
  const assistant = (uuid: string, blocks: unknown[] = []) => emit({type: "assistant", user_message_uuid: uuid, parent_tool_use_id: null,
    message: {content: blocks, usage: {input_tokens: 10, output_tokens: 2}}});
  const result = (message: SDKUserMessage, text = "done") => emit({type: "result", subtype: "success", is_error: false,
    ...(echo ? {user_message_uuid: message.uuid} : {}), ...(message.message.content === "/compact" && confirmCompact ? {local_command: "compact"} : {}), result: text, modelUsage: {sonnet: {inputTokens: prompts.length * 10, outputTokens: prompts.length * 2,
      cacheReadInputTokens: 0, cacheCreationInputTokens: 0}}});
  const factory: ClaudeQueryFactory = ({prompt, options: value}) => {
    factoryCalls++;
    if (failOpen) throw new Error("Native query initialization failed");
    options.push(value!); nativeId = value!.resume ?? value!.sessionId!;
    void (async () => {
      let initialized = false;
      for await (const message of prompt as AsyncIterable<SDKUserMessage>) {
        prompts.push(message); current = message;
        emit({type: "command_lifecycle", command_uuid: message.uuid, state: "queued"});
        emit({type: "command_lifecycle", command_uuid: message.uuid, state: "started"});
        if (!initialized) emit({type: "system", subtype: "session_title_changed", title: "Restored conversation"});
        if (!initialized) {initialized = true; emit({type: "system", subtype: "init", cwd: value!.cwd, permissionMode: value!.permissionMode,
          mcp_servers: [], plugins: []});}
        const text = message.message.content as string;
        if (text === "spawn" || text === "spawn-wait") {
          assistant(message.uuid!, [{type: "tool_use", id: "launch", name: "Agent", input: {prompt: "work", run_in_background: true}}]);
          emit({type: "system", subtype: "task_started", task_id: "agent", task_type: "local_agent", tool_use_id: "launch", description: "Background agent", is_backgrounded: true});
          if (text !== "spawn-wait") result(message);
        } else if (text === "wait") {assistant(message.uuid!);}
        else if (text === "/compact") {emit({type: "system", subtype: "compact_boundary", compact_metadata: {trigger: "manual", post_tokens: 5}}); result(message);}
        else {assistant(message.uuid!); result(message, text);}
      }
    })().catch(() => output.close());
    const stream = output[Symbol.asyncIterator]() as AsyncGenerator<SDKMessage, void>;
    return Object.assign(stream, {
      close() {closes++; output.close();},
      async setModel(model: string) {controls.push(`model:${model}`);},
      async setPermissionMode(mode: string) {controls.push(`mode:${mode}`);},
      async applyFlagSettings(settings: {effortLevel: string}) {controls.push(`effort:${settings.effortLevel}`); effectiveEffort = settings.effortLevel;},
      async getSettings() {controls.push("settings:read"); return {applied: {effort: effectiveEffort}};},
      async stopTask(id: string) {controls.push(`stop:${id}`); if (completeOnStop) emit({type: "system", subtype: "task_notification", task_id: id, status: "stopped", summary: "Stopped"});},
      async interrupt() {controls.push("interrupt"); emit({type: "result", subtype: "error_during_execution", is_error: true, user_message_uuid: current?.uuid});},
    }) as unknown as Query;
  };
  const config = RunnerConfigSchema.parse({runner_id: "runner", control_plane_url: "ws://localhost:1", workspaces: [{id: "workspace", path: cwd}],
    provider_instances: [{id: "provider", driver_kind: "claude"}]});
  const state = new JsonRunnerStateStore(join(cwd, "state.json"));
  const adapter = new ClaudeHarnessAdapter({queryFactory: factory});
  const manager = new HarnessSessionManager(config, {stateStore: state, adapterRegistry: new HarnessAdapterRegistry([adapter])});
  const events: HcpHarnessEventPayload[] = [];
  manager.subscribeEvents(event => {hcpHarnessEventPayloadSchema.parse(event); events.push(event);});
  const start: HcpSessionStartPayload = {session_id: "session", workspace_id: "workspace", cwd, provider_instance_id: "provider", driver_kind: "claude",
    execution_profile: "interactive", model_selection: {model: "sonnet"}, approval_policy: "ask", sandbox_mode: "danger_full_access", continue_session: false,
    continuation_group_key: "conversation", mcp_servers: []};
  await manager.startSession(start);
  const read = async () => {
    const receipt = await manager.conversationOperation("read", {session_id: "session", operation: {kind: "work", action: "read"}});
    if (receipt.work?.action !== "read") throw new Error("Expected work inventory");
    return receipt.work;
  };
  const send = (id: string, input: string) => manager.sendTurn({session_id: "session", turn_id: id, input});
  const cleanup = async () => {completeOnStop = true; try {await manager.stopSession("session", "cleanup");} catch {} await rm(cwd, {recursive: true, force: true});};
  return {cwd, config, adapter, manager, options, prompts, controls, events, start, state, emit, send, read, assistant, result,
    noEcho: () => {echo = false;}, failFactory: () => {failOpen = true;}, get factoryCalls() {return factoryCalls;},
    omitCompactConfirmation: () => {confirmCompact = false;},
    closeNative: () => output.close(), get closes() {return closes;}, cleanup};
}

test("interactive Claude retains one query, roots and background ownership across follow-ups", async () => {
  const f = await fixture();
  try {
    await f.send("first", "spawn");
    assert.equal(f.closes, 0);
    assert.equal((await f.read()).items[0]!.work.origin_turn_id, "first");
    f.emit({type: "system", subtype: "task_progress", task_id: "agent", description: "Still working"});
    await until(() => f.events.some(event => event.event_type === "native.work.updated" && (event.data as {work: {summary: string}}).work.summary === "Still working"));
    await f.send("second", "followup");
    assert.equal(f.options.length, 1);
    assert.equal(f.closes, 0);
    const finals = f.events.filter(event => event.event_type === "turn.completed");
    assert.deepEqual(finals.map(event => event.turn_id), ["first", "second"]);
    assert.equal((finals[1]!.data as {final_output: {usage: {scope: string; total_tokens: number}}}).final_output.usage.scope, "conversation");
    assert.equal((finals[1]!.data as {final_output: {usage: {total_tokens: number}}}).final_output.usage.total_tokens, 24);
    assert.equal(f.options[0]!.disallowedTools?.includes("Agent") ?? false, false);
  } finally {await f.cleanup();}
});

test("manual Claude compaction waits for its UUID-bound local-command result before accepting an unstamped boundary", async () => {
  const f = await fixture();
  try {
    await f.send("first", "hello");
    const result = await f.manager.sendTurn({session_id: "session", turn_id: "compact", input: "", action: "compact"});
    assert.equal(result.at(-1)?.event_type, "turn.completed");
    const contexts = f.events.filter(event => event.turn_id === "compact" && event.event_type === "context.updated");
    assert.equal((contexts.at(-1)?.data as {used_tokens: number}).used_tokens, 5);
    await f.send("followup", "still here");
    assert.equal(f.factoryCalls, 1);
  } finally {await f.cleanup();}
});

test("an unstamped compact boundary without local-command confirmation cannot complete manual compaction", async () => {
  const f = await fixture();
  try {
    await f.send("first", "hello"); f.omitCompactConfirmation();
    const result = await f.manager.sendTurn({session_id: "session", turn_id: "compact", input: "", action: "compact"});
    assert.equal(result.at(-1)?.event_type, "turn.failed");
    assert.equal(f.events.some(event => event.turn_id === "compact" && event.event_type === "context.updated" && (event.data as {status: string}).status === "measured"), false);
  } finally {await f.cleanup();}
});

test("late child approvals route to their original root after another root completes", async () => {
  const f = await fixture();
  try {
    await f.send("first", "spawn"); await f.send("second", "followup");
    const pending = f.options[0]!.canUseTool!("Bash", {command: "echo child"}, {agentID: "agent", toolUseID: "child-bash", requestId: "child-native-request", signal: new AbortController().signal});
    await until(() => f.events.some(event => event.event_type === "approval.requested"));
    const request = f.events.find(event => event.event_type === "approval.requested")!;
    const data = request.data as {request_id: string; action_hash: string};
    assert.equal(request.turn_id, "first");
    await assert.rejects(f.manager.respondToMcpReview({session_id: "session", turn_id: "second", request_id: data.request_id, action_hash: data.action_hash, decision: "accept", actor_id: "actor"}, () => {}), /another active session or turn/);
    await f.manager.respondToMcpReview({session_id: "session", turn_id: "first", request_id: data.request_id, action_hash: data.action_hash, decision: "accept", actor_id: "actor"}, () => {});
    assert.equal((await pending)?.behavior, "allow");
    const unknown = await f.options[0]!.canUseTool!("Bash", {}, {agentID: "foreign-agent", toolUseID: "foreign", requestId: "foreign", signal: new AbortController().signal});
    assert.equal(unknown?.behavior, "deny");
  } finally {await f.cleanup();}
});

test("settled roots retire while a long-running child's original interaction owner survives", async () => {
  const f = await fixture();
  try {
    await f.send("first", "spawn");
    for (let n = 0; n < 130; n++) {
      const result = await f.send(`followup-${n}`, "hello");
      assert.equal(result.at(-1)?.event_type, "turn.completed");
    }
    const pending = f.options[0]!.canUseTool!("Bash", {command: "echo child"}, {agentID: "agent", toolUseID: "child-bash", requestId: "request", signal: new AbortController().signal});
    await until(() => f.events.some(event => event.event_type === "approval.requested"));
    const data = f.events.find(event => event.event_type === "approval.requested")!.data as {request_id: string; action_hash: string};
    await f.manager.respondToMcpReview({session_id: "session", turn_id: "first", request_id: data.request_id, action_hash: data.action_hash, decision: "accept", actor_id: "actor"}, () => {});
    assert.equal((await pending)?.behavior, "allow");
    assert.equal(f.options.length, 1);
  } finally {await f.cleanup();}
});

test("persistent settings changes preserve the query, but never destroy outstanding work", async () => {
  const f = await fixture();
  try {
    await f.send("first", "spawn");
    const refused = await f.manager.sendTurn({session_id: "session", turn_id: "blocked", input: "change", model_selection: {model: "opus"}, mode: "plan"});
    assert.equal(refused.at(-1)?.event_type, "turn.failed");
    assert.deepEqual(f.controls, []); assert.equal(f.closes, 0);
    f.emit({type: "system", subtype: "task_notification", task_id: "agent", status: "completed", summary: "Done"});
    await until(() => f.events.some(event => event.event_type === "native.work.updated" && (event.data as {work: {status: string}}).work.status === "completed"));
    await f.manager.sendTurn({session_id: "session", turn_id: "changed", input: "change", model_selection: {model: "opus"}, mode: "plan"});
    assert.deepEqual(f.controls, ["model:opus", "mode:plan"]);
    assert.equal(f.options.length, 1);
    const configured = f.events.filter(event => event.event_type === "session.configured").at(-1)!;
    assert.equal((configured.data as {mode: string}).mode, "plan");
  } finally {await f.cleanup();}
});

test("persistent effort changes preserve the runtime and confirm effective settings", async () => {
  const f = await fixture();
  try {
    await f.send("first", "hello");
    const result = await f.manager.sendTurn({session_id: "session", turn_id: "changed", input: "change",
      model_selection: {model: "sonnet", options: [{id: "effort", value: "low"}]}});
    assert.equal(result.at(-1)?.event_type, "turn.completed");
    assert.deepEqual(f.controls, ["effort:low", "settings:read"]);
    assert.equal(f.factoryCalls, 1); assert.equal(f.closes, 0);
    const configured = f.events.filter(event => event.event_type === "session.configured").at(-1)!;
    assert.deepEqual((configured.data as {model_selection: unknown}).model_selection, {model: "sonnet", options: [{id: "effort", value: "low"}]});
  } finally {await f.cleanup();}
});

test("background roster precedes ownership bookends and fences settings and unload without inventing closure", async () => {
  const f = await fixture();
  try {
    await f.send("first", "followup");
    f.emit({type: "system", subtype: "background_tasks_changed", tasks: [{task_id: "unbound", task_type: "local_agent", description: "Pending origin"}]});
    await new Promise(resolve => setTimeout(resolve, 20));
    const refused = await f.manager.sendTurn({session_id: "session", turn_id: "blocked", input: "change", model_selection: {model: "opus"}});
    assert.equal(refused.at(-1)?.event_type, "turn.failed");
    await assert.rejects(f.manager.stopSession("session", "unload"), /ownership|owner|closure/i);
    assert.equal(f.closes, 0);
    assert.deepEqual(f.controls, []);
    assert.equal((await f.read()).items.length, 0);
    f.emit({type: "system", subtype: "background_tasks_changed", tasks: []});
    await new Promise(resolve => setTimeout(resolve, 20));
    await f.manager.stopSession("session", "retry-unload");
    assert.equal(f.closes, 1);
  } finally {await f.cleanup();}
});

test("late foreign results cannot complete or project into the current root", async () => {
  const f = await fixture();
  try {
    await f.send("first", "followup");
    const running = f.send("second", "wait");
    await until(() => f.prompts.length === 2);
    f.result(f.prompts[0]!, "foreign output");
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(f.events.some(event => event.turn_id === "second" && event.event_type === "turn.completed"), false);
    f.result(f.prompts[1]!, "owned output");
    await running;
    assert.equal(f.events.some(event => event.turn_id === "second" && event.event_type === "content.delta" && (event.data as {delta: string}).delta === "foreign output"), false);
  } finally {await f.cleanup();}
});

test("remembered Claude approval applies only offered session-local rules", async () => {
  const f = await fixture();
  try {
    await f.send("first", "spawn");
    const offered = {type: "addRules" as const, destination: "session" as const, behavior: "allow" as const, rules: [{toolName: "Bash", ruleContent: "echo:*"}]};
    const pending = f.options[0]!.canUseTool!("Bash", {command: "echo child"}, {agentID: "agent", toolUseID: "child-bash", requestId: "request", signal: new AbortController().signal,
      suggestions: [offered, {...offered, destination: "userSettings"}, {type: "setMode", destination: "session", mode: "bypassPermissions"}]});
    await until(() => f.events.some(event => event.event_type === "approval.requested"));
    const request = f.events.find(event => event.event_type === "approval.requested")!;
    const data = request.data as {request_id: string; action_hash: string; allowed_decisions: string[]; action: string};
    assert.ok(data.allowed_decisions.includes("accept_for_session"));
    assert.deepEqual(JSON.parse(data.action).details.session_permission_updates, [offered]);
    await f.manager.respondToMcpReview({session_id: "session", turn_id: "first", request_id: data.request_id, action_hash: data.action_hash, decision: "accept_for_session", actor_id: "actor"}, () => {});
    const result = await pending;
    assert.equal(result?.behavior, "allow");
    assert.deepEqual(result?.behavior === "allow" && result.updatedPermissions, [offered]);
  } finally {await f.cleanup();}
});

test("provider loss publishes request loss and rejects a retained child callback", async () => {
  const f = await fixture();
  try {
    await f.send("first", "spawn");
    const pending = f.options[0]!.canUseTool!("Bash", {command: "echo child"}, {agentID: "agent", toolUseID: "child-bash", requestId: "request", signal: new AbortController().signal});
    const rejected = assert.rejects(pending, /interrupted|process exited|ended/);
    await until(() => f.events.some(event => event.event_type === "approval.requested"));
    f.closeNative(); await rejected;
    await until(() => f.events.some(event => event.event_type === "native.request.lost"));
    const request = f.events.find(event => event.event_type === "approval.requested")!;
    const lost = f.events.find(event => event.event_type === "native.request.lost")!;
    assert.equal(lost.turn_id, "first");
    assert.equal((lost.data as {request_id: string}).request_id, (request.data as {request_id: string}).request_id);
    assert.ok(lost.sequence < f.events.find(event => event.event_type === "native.work.owner_lost")!.sequence);
  } finally {await f.cleanup();}
});

test("native task cancellation acknowledgement is separate from observed completion and is deduplicated", async () => {
  const f = await fixture();
  try {
    await f.send("first", "spawn");
    const work = (await f.read()).items[0]!.work;
    const request = {session_id: "session", operation: {kind: "work", action: "cancel", work_id: work.work_id, expected_revision: work.revision}} as const;
    const first = await f.manager.conversationOperation("cancel", request);
    assert.deepEqual(await f.manager.conversationOperation("cancel", request), first);
    assert.deepEqual(f.controls, ["stop:agent"]);
    assert.equal((await f.read()).items[0]!.work.status, "running");
    f.emit({type: "system", subtype: "task_notification", task_id: "agent", status: "stopped", summary: "Stopped"});
    await until(() => f.events.some(event => event.event_type === "native.work.updated" && (event.data as {work: {status: string}}).work.status === "cancelled"));
    await f.manager.stopSession("session", "done");
    assert.equal(f.manager.activeSessionCount(), 0);
  } finally {await f.cleanup();}
});

test("observed child termination loses its pending callback while the session remains usable", async () => {
  const f = await fixture();
  try {
    await f.send("first", "spawn");
    const pending = f.options[0]!.canUseTool!("Bash", {command: "echo child"}, {agentID: "agent", toolUseID: "child-bash", requestId: "request", signal: new AbortController().signal});
    const rejected = assert.rejects(pending, /interrupted/);
    await until(() => f.events.some(event => event.event_type === "approval.requested"));
    const data = f.events.find(event => event.event_type === "approval.requested")!.data as {request_id: string; action_hash: string};
    f.emit({type: "system", subtype: "task_notification", task_id: "agent", status: "stopped"});
    await rejected;
    await assert.rejects(f.manager.respondToMcpReview({session_id: "session", turn_id: "first", request_id: data.request_id, action_hash: data.action_hash, decision: "accept", actor_id: "actor"}, () => {}));
    assert.equal(f.events.some(event => event.event_type === "native.request.lost" && (event.data as {request_id?: string}).request_id === data.request_id), true);
    assert.equal((await f.send("second", "hello")).at(-1)?.event_type, "turn.completed");
    assert.equal(f.options.length, 1);
  } finally {await f.cleanup();}
});

test("root interruption preserves independently running tasks and permits another root", async () => {
  const f = await fixture();
  try {
    await f.send("first", "spawn");
    assert.equal(f.options[0]!.perTaskStopAffordance, true);
    const running = f.send("waiting", "wait");
    await until(() => f.prompts.length === 2);
    await f.manager.cancelTurn("session", "waiting");
    const result = await running;
    assert.equal(result.at(-1)?.event_type, "turn.cancelled");
    assert.equal((await f.read()).items[0]!.work.status, "running");
    assert.equal(f.closes, 0);
    await f.send("third", "after interruption");
    assert.equal(f.options.length, 1);
    assert.equal(f.events.filter(event => event.turn_id === "waiting" && ["turn.completed", "turn.failed", "turn.cancelled"].includes(event.event_type)).length, 1);
  } finally {await f.cleanup();}
});

test("interrupting a launching root preserves its own independent child's pending approval", async () => {
  const f = await fixture();
  try {
    const running = f.send("first", "spawn-wait");
    await until(() => f.events.some(event => event.event_type === "native.work.updated"));
    const pending = f.options[0]!.canUseTool!("Bash", {command: "echo child"}, {agentID: "agent", toolUseID: "child-bash", requestId: "request", signal: new AbortController().signal});
    await until(() => f.events.some(event => event.event_type === "approval.requested"));
    const data = f.events.find(event => event.event_type === "approval.requested")!.data as {request_id: string; action_hash: string};
    await f.manager.cancelTurn("session", "first"); await running;
    assert.equal((await f.read()).items[0]!.work.status, "running");
    assert.equal(f.events.some(event => event.event_type === "native.request.lost"), false);
    await f.manager.respondToMcpReview({session_id: "session", turn_id: "first", request_id: data.request_id, action_hash: data.action_hash, decision: "accept", actor_id: "actor"}, () => {});
    assert.equal((await pending)?.behavior, "allow");
    await f.send("followup", "hello");
    assert.equal(f.options.length, 1);
  } finally {await f.cleanup();}
});

test("native death loses task control and cannot fabricate task closure or recover callbacks", async () => {
  const f = await fixture();
  try {
    await f.send("first", "spawn"); f.closeNative();
    await until(() => f.events.some(event => event.event_type === "native.work.owner_lost"));
    assert.equal((await f.read()).owner_status, "unavailable");
    assert.equal((await f.read()).items[0]!.work.status, "running");
    await assert.rejects(f.manager.stopSession("session", "stop"), /closure is unconfirmed/);
    assert.equal(f.manager.activeSessionCount(), 1);
    const later = await f.send("later", "do not replay");
    assert.equal(later.at(-1)?.event_type, "turn.failed");
    assert.equal(f.options.length, 1);
  } finally {await f.cleanup();}
});

test("persistent root results require explicit prompt identity and never auto-resubmit", async () => {
  const f = await fixture();
  try {
    f.noEcho(); const result = await f.send("first", "hello");
    assert.equal(result.at(-1)?.event_type, "turn.failed");
    assert.ok(f.events.some(event => event.event_type === "native.work.owner_lost"));
    await f.send("second", "hello"); assert.equal(f.prompts.length, 1); assert.equal(f.options.length, 1);
  } finally {await f.cleanup();}
});

test("autonomous Claude messages and unstamped results cannot inherit an active app turn", async () => {
  const f = await fixture();
  try {
    const pending = f.send("waiting", "wait");
    await until(() => f.prompts.length === 1);
    f.emit({type: "stream_event", parent_tool_use_id: null, event: {type: "message_start"}});
    f.emit({type: "stream_event", parent_tool_use_id: null, event: {type: "content_block_delta", delta: {type: "text_delta", text: "autonomous"}}});
    f.emit({type: "assistant", parent_tool_use_id: null, message: {content: [], usage: {input_tokens: 10, output_tokens: 2}}});
    f.emit({type: "result", subtype: "success", is_error: false, result: "autonomous", modelUsage: {}});
    f.assistant(f.prompts[0]!.uuid!); f.result(f.prompts[0]!, "app-owned");
    const result = await pending;
    assert.equal(result.at(-1)?.event_type, "turn.completed");
    assert.doesNotMatch(JSON.stringify(f.events.filter(event => event.turn_id === "waiting")), /autonomous/);
    assert.equal(f.events.some(event => event.event_type === "native.work.owner_lost"), false);
    assert.equal(f.prompts.length, 1);
  } finally {await f.cleanup();}
});

test("query initialization failure fences the runtime without unhandled completion or automatic restart", async () => {
  const f = await fixture();
  try {
    f.failFactory();
    assert.equal((await f.send("first", "hello")).at(-1)?.event_type, "turn.failed");
    assert.ok(f.events.some(event => event.event_type === "native.work.owner_lost"));
    assert.equal((await f.send("second", "hello")).at(-1)?.event_type, "turn.failed");
    assert.equal(f.factoryCalls, 1); assert.equal(f.prompts.length, 0);
  } finally {await f.cleanup();}
});

test("unconfirmed native task origin cannot become a clean unload after process death", async () => {
  const f = await fixture();
  try {
    await f.send("first", "hello");
    f.emit({type: "system", subtype: "task_started", task_id: "unowned", tool_use_id: "unknown-launch", task_type: "local_agent"});
    await until(() => f.events.some(event => event.event_type === "native.work.owner_lost"));
    assert.equal((await f.read()).items.length, 0);
    assert.equal((await f.read()).closure_unconfirmed, true);
    await assert.rejects(f.manager.stopSession("session", "unload"), /ownership|owner|closure/i);
    assert.equal(f.manager.activeSessionCount(), 1);
    const restored = new HarnessSessionManager(f.config, {stateStore: new JsonRunnerStateStore(join(f.cwd, "state.json")), adapterRegistry: new HarnessAdapterRegistry([f.adapter])});
    const retained = await restored.conversationOperation("retained-work", {session_id: "session", operation: {kind: "work", action: "read"}});
    assert.equal(retained.work?.action === "read" && retained.work.closure_unconfirmed, true);
    await assert.rejects(restored.startSession({...f.start, session_id: "resumed", continue_session: true}), /unconfirmed closure|reclaim/);
    await assert.rejects(restored.conversationOperation("unsafe-retire", {session_id: "session", operation: {kind: "retire"}}), /authoritative reconciliation/);
    const quarantine = f.state.nativeWorkState("session")!;
    f.state.removeEmptyNativeWorkState("session");
    assert.equal(f.state.nativeWorkState("session")?.closure_unconfirmed, true);
    const {closure_unconfirmed: _, ...cleared} = quarantine;
    assert.throws(() => f.state.saveNativeWorkState("session", cleared), /authoritative reconciliation/);
  } finally {await f.cleanup();}
});
