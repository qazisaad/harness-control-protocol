import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import type {Query, SDKMessage, SDKUserMessage, Options} from "@anthropic-ai/claude-agent-sdk";
import type {HcpSessionStartPayload, HarnessNativePolicyReadback} from "@harness-control/protocol";
import {PersistentClaudeSession} from "./adapters/providers/claude-session.js";
import type {ClaudeQueryFactory} from "./adapters/providers/claude-runtime.js";
import {RunnerConfigSchema} from "../config/index.js";

async function fixture(policy: HcpSessionStartPayload["approval_policy"] = "ask", authority?: HcpSessionStartPayload["policy_control_authority"]) {
  const cwd = await mkdtemp(join(tmpdir(), "hcp-idle-policy-"));
  const initial: HcpSessionStartPayload = {session_id: "session", workspace_id: "workspace", provider_instance_id: "provider",
    driver_kind: "claude", execution_profile: "interactive", cwd, model_selection: {model: "sonnet"}, approval_policy: policy,
    sandbox_mode: "danger_full_access", continue_session: false, mcp_servers: [],
    ...(authority ? {continuation_group_key: "fixture", policy_control_authority: authority} : {})};
  const provider = RunnerConfigSchema.parse({runner_id: "fixture", control_plane_url: "ws://localhost:1",
    workspaces: [{id: "workspace", path: cwd}], provider_instances: [{id: "provider", driver_kind: "claude"}]}).provider_instances[0]!;
  const queue: SDKMessage[] = [], options: Options[] = [], controls: string[] = [], prompts: SDKUserMessage[] = [];
  let wake: (() => void) | undefined, closed = false, nativeId = "", hold = false, holdRoot = false, holdModel = false;
  let acknowledge: (() => void) | undefined;
  let acknowledgeModel: (() => void) | undefined;
  const emit = (message: Record<string, unknown>) => {queue.push({session_id: nativeId, ...message} as SDKMessage); wake?.(); wake = undefined;};
  const finish = (message: SDKUserMessage) => emit({type: "result", subtype: "success", is_error: false,
    user_message_uuid: message.uuid, result: "fixture", usage: {input_tokens: 0, output_tokens: 0}});
  const factory: ClaudeQueryFactory = ({prompt, options: selected}) => {
    options.push(selected!); nativeId = selected!.sessionId!;
    void (async () => {for await (const message of prompt as AsyncIterable<SDKUserMessage>) {
      prompts.push(message);
      if (prompts.length === 1) emit({type: "system", subtype: "init", cwd, permissionMode: selected!.permissionMode,
        tools: [], mcp_servers: [], plugins: []});
      if (!holdRoot) finish(message);
    }})();
    const messages = (async function* () {while (!closed || queue.length) {
      const message = queue.shift(); if (message) yield message;
      else await new Promise<void>(resolve => {wake = resolve;});
    }})();
    return Object.assign(messages, {close() {closed = true; wake?.();}, async initializationResult() {return {};},
      async setModel(model: string) {controls.push(`model:${model}`); if (holdModel) await new Promise<void>(resolve => {acknowledgeModel = resolve;});},
      async setPermissionMode(mode: string) {controls.push(mode);
        if (hold) await new Promise<void>(resolve => {acknowledge = resolve;});
        else emit({type: "system", subtype: "status", status: null, permissionMode: mode});
      }}) as unknown as Query;
  };
  const runtime = new PersistentClaudeSession({payload: structuredClone(initial), provider, emitSessionEvent() {}, registerSessionInteractions() {}}, factory);
  const run = (payload = runtime.start.payload, model?: string) => runtime.run({startPayload: payload, provider,
    session: {adapter_session_id: "session", native_thread_id: runtime.nativeId},
    payload: {session_id: "session", turn_id: `turn-${prompts.length}`, input: "fixture", ...(model ? {model_selection: {model}} : {})}}, new AbortController().signal, () => {});
  await run();
  const next = (policy: HcpSessionStartPayload["approval_policy"]) => ({...structuredClone(runtime.start.payload), approval_policy: policy});
  const update = (payload: HcpSessionStartPayload, beginMutation = () => {}, commit = (_: HarnessNativePolicyReadback) => {}, signal = new AbortController().signal) =>
    runtime.updateIdlePolicy({sessionId: "session", nextPayload: payload, beginMutation, commit, signal});
  return {runtime, initial, options, controls, prompts, emit, run, next, update,
    hold: () => {hold = true;}, holdRoot: () => {holdRoot = true;}, finish,
    holdModel: () => {holdModel = true;}, acknowledgeModel: () => {assert.ok(acknowledgeModel); acknowledgeModel();},
    acknowledge: () => {assert.ok(acknowledge); acknowledge();},
    cleanup: async (expectUnknownClosure = false) => {
      try {
        if (expectUnknownClosure) await assert.rejects(runtime.stop(), {code: "native_work_closure_unknown"});
        else await runtime.stop();
      } finally {await rm(cwd, {recursive: true, force: true});}
    }};
}
async function until(predicate: () => boolean) {
  for (let n = 0; n < 500; n++) {if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 2));}
  throw new Error("Policy fixture did not reach the expected observation.");
}

test("in-place Claude policy waits for both native acknowledgement and fresh exact mode, retaining its query", async () => {
  const f = await fixture();
  try {
    f.hold(); let dispatched = 0, commits = 0;
    const update = f.update(f.next("auto_edits"), () => {dispatched++;}, readback => {assert.equal(readback.approval_policy, "auto_edits"); commits++;});
    await until(() => f.controls.length === 1);
    assert.equal(dispatched, 1); assert.equal(commits, 0);
    await assert.rejects(f.run(), {code: "native_policy_busy"});
    await assert.rejects(f.update(f.next("auto_edits")), {code: "native_policy_busy"});
    await assert.rejects(f.runtime.detachMcp([], new AbortController().signal), {code: "native_mcp_detach_busy"});
    f.emit({type: "system", subtype: "status", status: null, permissionMode: "acceptEdits"});
    await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(commits, 0);
    f.acknowledge(); await update; assert.equal(commits, 1);
    await f.run(); assert.equal(f.options.length, 1); assert.equal(f.prompts.length, 2);
    await assert.rejects(f.run(f.initial), {code: "native_continuation_binding"});
    await assert.rejects(f.update(f.next("auto_edits")), {code: "native_policy_unchanged"});
  } finally {await f.cleanup();}
});

test("in-place Claude policy refuses absent bypass authority, changed binding and active roots before dispatch", async () => {
  const f = await fixture();
  try {
    let dispatched = 0; const begin = () => {dispatched++;};
    await assert.rejects(f.update(f.next("full_access"), begin), {code: "native_policy_launch_authority"});
    await assert.rejects(f.update({...f.next("ask"), approval_reviewer: "native_auto"}, begin), {code: "native_approval_review_unsupported"});
    await assert.rejects(f.update({...f.next("auto_edits"), cwd: tmpdir()}, begin), {code: "native_policy_binding"});
    f.holdRoot(); const root = f.run(); await until(() => f.prompts.length === 2);
    await assert.rejects(f.update(f.next("auto_edits"), begin), {code: "native_policy_busy"});
    assert.equal(dispatched, 0); assert.equal(f.controls.length, 0);
    f.finish(f.prompts[1]!); await root;
  } finally {await f.cleanup();}
});

test("wrong Claude policy status fences the physical owner and never commits requested authority", async () => {
  const f = await fixture();
  try {
    f.hold(); let commits = 0; const update = f.update(f.next("auto_edits"), () => {}, () => {commits++;});
    f.emit({type: "system", subtype: "status", status: null, permissionMode: "bypassPermissions"});
    f.acknowledge(); await assert.rejects(update, {code: "policy_mismatch"});
    assert.equal(commits, 0); assert.equal(f.runtime.start.payload.approval_policy, "ask");
    await assert.rejects(f.run(), {code: "native_owner_unavailable"});
  } finally {await f.cleanup();}
});

test("a durable policy fence failure prevents native dispatch and leaves the original owner usable", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.update(f.next("auto_edits"), () => {throw new Error("Fixture persistence failure");}), /Fixture persistence failure/);
    assert.equal(f.controls.length, 0); await f.run(); assert.equal(f.options.length, 1);
  } finally {await f.cleanup();}
});

test("a policy confirmation persistence failure fences the owner after native dispatch", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.update(f.next("auto_edits"), () => {}, () => {throw new Error("Fixture commit failure");}), /Fixture commit failure/);
    assert.deepEqual(f.controls, ["acceptEdits"]); assert.equal(f.runtime.start.payload.approval_policy, "ask");
    await assert.rejects(f.run(), {code: "native_owner_unavailable"});
  } finally {await f.cleanup();}
});

test("launch-authorized bypass can be lowered and restored without changing the native query", async () => {
  const f = await fixture("full_access");
  try {
    await f.update(f.next("ask")); await f.run(); await f.update(f.next("full_access")); await f.run();
    assert.deepEqual(f.controls, ["default", "bypassPermissions"]); assert.equal(f.options.length, 1);
    assert.equal(f.options[0]!.allowDangerouslySkipPermissions, true);
  } finally {await f.cleanup();}
});

test("aborting a dispatched policy control cannot commit or reopen its native owner", async () => {
  const f = await fixture();
  try {
    f.hold(); const abort = new AbortController(); let commits = 0;
    const update = f.update(f.next("auto_edits"), () => {}, () => {commits++;}, abort.signal);
    abort.abort(); f.emit({type: "system", subtype: "status", status: null, permissionMode: "acceptEdits"}); f.acknowledge();
    await assert.rejects(update, {name: "AbortError"}); assert.equal(commits, 0);
    await assert.rejects(f.run(), {code: "native_owner_unavailable"});
  } finally {await f.cleanup();}
});

test("asynchronous root settings preparation excludes native policy and MCP controls before root creation", async () => {
  const f = await fixture();
  try {
    f.holdModel(); const root = f.run(undefined, "other-model");
    await until(() => f.controls.includes("model:other-model"));
    let dispatched = 0;
    await assert.rejects(f.update(f.next("auto_edits"), () => {dispatched++;}), {code: "native_policy_busy"});
    await assert.rejects(f.runtime.detachMcp([], new AbortController().signal), {code: "native_mcp_detach_busy"});
    await assert.rejects(f.run(), {code: "native_turn_busy"});
    assert.equal(dispatched, 0); f.acknowledgeModel(); await root;
  } finally {await f.cleanup();}
});

test("late native background work prevents policy confirmation from committing", async () => {
  const f = await fixture();
  try {
    f.hold(); let commits = 0; const update = f.update(f.next("auto_edits"), () => {}, () => {commits++;});
    f.emit({type: "system", subtype: "status", status: null, permissionMode: "acceptEdits"});
    f.emit({type: "system", subtype: "background_tasks_changed", tasks: [{task_id: "late-native-task"}]});
    await new Promise(resolve => setTimeout(resolve, 5)); f.acknowledge();
    await assert.rejects(update, {code: "native_policy_unknown"}); assert.equal(commits, 0);
    await assert.rejects(f.run(), {code: "native_owner_unavailable"});
  } finally {await f.cleanup(true);}
});

test("explicit future bypass authority retains initial ask mode and refuses selections outside its envelope", async () => {
  const f = await fixture("ask", {allowed_selections: [{approval_policy: "ask", approval_reviewer: "user"},
    {approval_policy: "full_access", approval_reviewer: "user"}]});
  try {
    assert.equal(f.options[0]!.permissionMode, "default"); assert.equal(f.options[0]!.allowDangerouslySkipPermissions, true);
    let dispatched = 0;
    await assert.rejects(f.update(f.next("auto_edits"), () => {dispatched++;}), {code: "native_policy_authority"});
    assert.equal(dispatched, 0); await f.update(f.next("full_access")); await f.run();
    assert.deepEqual(f.controls, ["bypassPermissions"]); assert.equal(f.options.length, 1);
  } finally {await f.cleanup();}
});

test("observed active native goals exclude idle policy control until an observed clear", async () => {
  const f = await fixture();
  try {
    f.holdRoot(); const root = f.run(); await until(() => f.prompts.length === 2);
    f.emit({type: "assistant", uuid: "goal-set-observation", user_message_uuid: f.prompts[1]!.uuid, parent_tool_use_id: null,
      message: {model: "<synthetic>", content: [{type: "text", text: "Goal set: Fixture objective"}]}});
    f.finish(f.prompts[1]!); await root;
    await assert.rejects(f.update(f.next("auto_edits")), {code: "native_policy_busy"}); assert.equal(f.controls.length, 0);
    const clear = f.run(); await until(() => f.prompts.length === 3);
    f.emit({type: "assistant", uuid: "goal-clear-observation", user_message_uuid: f.prompts[2]!.uuid, parent_tool_use_id: null,
      message: {model: "<synthetic>", content: [{type: "text", text: "Goal cleared: Fixture objective"}]}});
    f.finish(f.prompts[2]!); await clear;
    await f.update(f.next("auto_edits")); assert.deepEqual(f.controls, ["acceptEdits"]);
  } finally {await f.cleanup();}
});
