import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RunnerConfigSchema } from "../config/index.js";
import { MemoryRunnerStateStore } from "../state/index.js";
import {
  HarnessSessionManager, HarnessAdapterRegistry, HarnessAdapterError,
  type HarnessAdapter, type HarnessAdapterConversationInput,
} from "./index.js";
import type { HcpConversationResultPayload, HcpSessionStartPayload } from "@harness-control/protocol";

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "hcp-custom-conversation-"));
  const state = new MemoryRunnerStateStore();
  const config = RunnerConfigSchema.parse({runner_id: "runner", control_plane_url: "ws://localhost:8787",
    workspaces: [{id: "workspace", path: cwd}], provider_instances: [{id: "custom", driver_kind: "example.chat"}]});
  const calls: HarnessAdapterConversationInput[] = [];
  let operation = async (input: HarnessAdapterConversationInput): Promise<HcpConversationResultPayload> => {
    calls.push(input);
    return {command_id: input.commandId, session_id: input.request.session_id, operation: input.request.operation.kind,
      filesystem_undo: false, history: {history_hash: "a".repeat(64), turn_count: 1, truncated: false,
        turns: [{id: "turn", status: "completed", items: [{id: "answer", type: "text", text: "retained"}]}]}};
  };
  const adapter: HarnessAdapter = {
    driverKind: "example.chat", conversationOperations: ["read", "rollback"],
    conversationOperation: input => operation(input),
    async probe() {return {driver_kind: "example.chat", installed: true, available: true, models: []};},
    async validateStart() {},
    async startSession() {return {adapter_session_id: "native-session"};},
    async sendTurn(input) {
      input.persistNativeThread?.("native-conversation");
      return [{event_type: "turn.completed", turn_id: input.payload.turn_id, data: {final_output: {final_text: "retained"}}}];
    },
    async cancelTurn() {return [];}, async stopSession() {return [];},
  };
  const manager = () => new HarnessSessionManager(config, {stateStore: state, adapterRegistry: new HarnessAdapterRegistry([adapter])});
  const start: HcpSessionStartPayload = {session_id: "session", workspace_id: "workspace", provider_instance_id: "custom",
    driver_kind: "example.chat", cwd, sandbox_mode: "read_only", approval_policy: "full_access", continue_session: false,
    continuation_group_key: "conversation", model_selection: {model: "custom"}, mcp_servers: []};
  const first = manager();
  await first.startSession(start);
  await first.sendTurn({session_id: "session", turn_id: "turn", input: "hello"});
  return {adapter, state, calls, config, first, manager, start, setOperation: (next: typeof operation) => {operation = next;},
    cleanup: () => rm(cwd, {recursive: true, force: true})};
}

test("context injection confirms its exact payload once and retains multiple receipts across manager restart", async () => {
  const f = await fixture();
  try {
    await f.first.stopSession("session", "idle");
    Object.assign(f.adapter, {conversationOperations: ["read", "inject"]});
    let dispatches = 0;
    f.setOperation(async input => {
      if (input.request.operation.kind !== "inject") throw new Error("expected injection");
      input.beginMutation!(); dispatches++;
      return {command_id: input.commandId, session_id: input.request.session_id, operation: "inject", filesystem_undo: false,
        injection: {outcome: "applied", message_count: input.request.operation.messages.length}};
    });
    const request = {session_id: "session", operation: {kind: "inject" as const, expected_history_hash: "a".repeat(64),
      messages: [{role: "user" as const, content: "Context supplied by the app"}, {role: "assistant" as const, content: "Earlier answer"}]}};
    const first = await f.first.conversationOperation("inject-1", request);
    await f.first.conversationOperation("__proto__", request);
    assert.deepEqual(await f.manager().conversationOperation("inject-1", request), first);
    assert.deepEqual(await f.manager().conversationOperation("inject-1", {session_id: "session", operation: {
      messages: request.operation.messages.map(message => ({content: message.content, role: message.role})),
      expected_history_hash: request.operation.expected_history_hash, kind: "inject"}}), first);
    assert.equal(dispatches, 2);
    await assert.rejects(f.manager().conversationOperation("inject-1", {...request, operation: {...request.operation, messages: [{role: "user", content: "Changed"}]}}), /different parameters/);
    await f.first.startSession({...f.start, session_id: "resumed", continue_session: true});
    await f.first.sendTurn({session_id: "resumed", turn_id: "followup", input: "hello"});
    await assert.rejects(f.first.conversationOperation("inject-1", {...request, session_id: "resumed"}), /different parameters/);
    assert.equal(f.state.getNativeConversation("conversation")!.injections!.length, 2);
    await f.first.stopSession("resumed", "done");
  } finally {await f.cleanup();}
});

test("unknown context injection dispatch fences retries, other mutations, retirement and resume", async () => {
  const f = await fixture();
  try {
    await f.first.stopSession("session", "idle");
    Object.assign(f.adapter, {conversationOperations: ["read", "inject"]});
    const request = {session_id: "session", operation: {kind: "inject" as const, expected_history_hash: "a".repeat(64), messages: [{role: "user" as const, content: "Context"}]}};
    let dispatches = 0;
    f.setOperation(async input => {input.beginMutation!(); dispatches++; throw new Error("lost native acknowledgement");});
    await assert.rejects(f.first.conversationOperation("lost", request), /lost native/);
    await assert.rejects(f.manager().conversationOperation("lost", request), /automatic repetition/);
    await assert.rejects(f.manager().conversationOperation("another", request), /automatic repetition/);
    await assert.rejects(f.manager().conversationOperation("retire", {session_id: "session", operation: {kind: "retire"}}), /automatic repetition/);
    await assert.rejects(f.manager().startSession({...f.start, session_id: "resumed", continue_session: true}), /cannot redeliver/);
    assert.equal(dispatches, 1);
  } finally {await f.cleanup();}
});

test("a context injection cannot dispatch when its durable store fails to retain the fence", async () => {
  const f = await fixture();
  try {
    await f.first.stopSession("session", "idle");
    Object.assign(f.adapter, {conversationOperations: ["inject"]});
    const save = f.state.saveNativeConversation.bind(f.state);
    f.state.saveNativeConversation = (key, value) => {if (!value.injections) save(key, value);};
    let effects = 0;
    f.setOperation(async input => {
      input.beginMutation!(); effects++;
      return {command_id: input.commandId, session_id: input.request.session_id, operation: "inject", filesystem_undo: false,
        injection: {outcome: "applied", message_count: 1}};
    });
    await assert.rejects(f.first.conversationOperation("inject", {session_id: "session", operation: {kind: "inject",
      expected_history_hash: "a".repeat(64), messages: [{role: "user", content: "Context"}]}}), /dispatch fence was not retained/);
    assert.equal(effects, 0);
  } finally {await f.cleanup();}
});

test("configuration inheritance requirements fail before native launch when support is unknown or differs", async () => {
  const f = await fixture();
  let launches = 0;
  const launch = f.adapter.startSession;
  f.adapter.startSession = async input => {launches++; return launch(input);};
  try {
    await f.first.stopSession("session", "idle");
    const payload = {...f.start, session_id: "isolated", continuation_group_key: "new-conversation", configuration_inheritance: {hooks: false}};
    await assert.rejects(f.first.startSession(payload), /cannot enforce.*hooks/);
    assert.equal(launches, 0);
    Object.assign(f.adapter, {configurationInheritance: {hooks: true}});
    await assert.rejects(f.first.startSession(payload), /cannot enforce.*hooks/);
    assert.equal(launches, 0);
    Object.assign(f.adapter, {configurationInheritanceOptions: [{hooks: false, plugins: false}]});
    await assert.rejects(f.first.startSession({...payload, configuration_inheritance: {hooks: false, plugins: true}}), /cannot enforce/);
    assert.equal(launches, 0);
    const selected = await f.first.startSession(payload);
    assert.deepEqual((selected.find(event => event.event_type === "session.configured")!.data as Record<string, unknown>).configuration_inheritance,
      {hooks: false, plugins: false});
    await f.first.stopSession("isolated", "done");
    Object.assign(f.adapter, {configurationInheritance: {hooks: false}});
    const configured = await f.first.startSession({...payload, session_id: "isolated-default"});
    assert.equal(launches, 2);
    assert.deepEqual((configured.find(event => event.event_type === "session.configured")!.data as Record<string, unknown>).configuration_inheritance, {hooks: false});
    await f.first.stopSession("isolated-default", "done");
  } finally {await f.cleanup();}
});

test("declared portable history cannot silently return only opaque native items", async () => {
  const f = await fixture();
  try {
    await f.first.stopSession("session", "idle");
    Object.assign(f.adapter, {portableHistory: true});
    await assert.rejects(f.first.conversationOperation("read", {session_id: "session", operation: {kind: "read"}}), /declared portable history contract/);
  } finally {await f.first.stopSession("session", "done"); await f.cleanup();}
});

test("instruction roles require explicit adapter support before native launch", async () => {
  const f = await fixture();
  let launches = 0;
  const launch = f.adapter.startSession;
  f.adapter.startSession = async input => {launches++; assert.deepEqual(input.payload.instructions, {system: "App instructions"}); return launch(input);};
  try {
    await f.first.stopSession("session", "idle");
    const payload = {...f.start, session_id: "instructed", continuation_group_key: "new", instructions: {system: "App instructions"}};
    await assert.rejects(f.first.startSession(payload), /requested 'system'.*role/);
    Object.assign(f.adapter, {instructionRoles: ["developer"]});
    await assert.rejects(f.first.startSession(payload), /requested 'system'.*role/);
    assert.equal(launches, 0);
    Object.assign(f.adapter, {instructionRoles: ["system"]});
    await f.first.startSession(payload); assert.equal(launches, 1);
    await f.first.stopSession("instructed", "done");
  } finally {await f.cleanup();}
});

test("a custom public adapter reads and rolls back its retained conversation after manager recreation", async () => {
  const f = await fixture();
  try {
    await f.first.stopSession("session", "idle");
    const manager = f.manager();
    const read = await manager.conversationOperation("read", {session_id: "session", operation: {kind: "read"}});
    assert.equal(read.history?.turns[0]?.items[0]?.text, "retained");
    await manager.conversationOperation("rollback", {session_id: "session", operation: {kind: "rollback", num_turns: 1,
      expected_history_hash: read.history!.history_hash}});
    assert.deepEqual(f.calls.map(input => input.request.operation.kind), ["read", "rollback"]);
    assert.equal(f.calls[0]?.provider.driver_kind, "example.chat");
    assert.equal(f.calls[0]?.conversation.native_thread_id, "native-conversation");
  } finally {await f.cleanup();}
});

test("active conversations are rejected before invoking native history", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.first.conversationOperation("read", {session_id: "session", operation: {kind: "read"}}),
      (error: unknown) => error instanceof HarnessAdapterError && error.code === "native_conversation_unavailable");
    assert.equal(f.calls.length, 0);
  } finally {await f.cleanup();}
});

test("explicit live-history support permits only reads without unloading its session owner", async () => {
  const f = await fixture();
  try {
    Object.assign(f.adapter, {liveHistoryRead: true});
    const read = await f.first.conversationOperation("read", {session_id: "session", operation: {kind: "read"}});
    assert.equal(read.history?.turn_count, 1);
    assert.equal(f.first.activeSessionCount(), 1);
    for (const operation of [{kind: "rollback", num_turns: 1, expected_history_hash: read.history!.history_hash}, {kind: "retire"}] as const)
      await assert.rejects(f.first.conversationOperation("mutation", {session_id: "session", operation}),
        (error: unknown) => error instanceof HarnessAdapterError && error.code === "native_conversation_unavailable");
    assert.deepEqual(f.calls.map(call => call.request.operation.kind), ["read"]);
  } finally {await f.first.stopSession("session", "cleanup"); await f.cleanup();}
});

test("missing adapter operations fail explicitly while retirement stays runner owned", async () => {
  const f = await fixture();
  try {
    await f.first.stopSession("session", "idle");
    Object.assign(f.adapter, {conversationOperations: ["read"]});
    await assert.rejects(f.first.conversationOperation("rollback", {session_id: "session", operation: {kind: "rollback",
      num_turns: 1, expected_history_hash: "a".repeat(64)}}), /does not support 'rollback'/);
    delete f.adapter.conversationOperation;
    await assert.rejects(f.first.conversationOperation("read", {session_id: "session", operation: {kind: "read"}}), /does not support 'read'/);
    const retired = await f.first.conversationOperation("retire", {session_id: "session", operation: {kind: "retire"}});
    assert.equal(retired.filesystem_undo, false);
    assert.equal(f.state.getNativeConversation("conversation"), undefined);
    assert.equal(f.calls.length, 0);
  } finally {await f.cleanup();}
});

for (const field of ["command_id", "session_id", "operation"] as const) test(`conversation results cannot change ${field}`, async () => {
  const f = await fixture();
  try {
    await f.first.stopSession("session", "idle");
    f.setOperation(async input => ({command_id: input.commandId, session_id: input.request.session_id, operation: "read",
      history: {history_hash: "a".repeat(64), turn_count: 0, truncated: false, turns: []},
      filesystem_undo: false, [field]: field === "operation" ? "rollback" : "another"}));
    await assert.rejects(f.first.conversationOperation("read", {session_id: "session", operation: {kind: "read"}}),
      (error: unknown) => error instanceof HarnessAdapterError && error.code === "native_history_binding");
  } finally {await f.cleanup();}
});

test("an adapter may persist mutation evidence but cannot change conversation scope", async () => {
  const f = await fixture();
  try {
    await f.first.stopSession("session", "idle");
    const original = f.state.getNativeConversation("conversation")!;
    f.setOperation(async input => {
      input.save({...input.conversation, rollback: {command_id: "read", source_hash: "a", target_hash: "b", phase: "pending"}});
      input.save({...input.conversation, workspace_id: "another"});
      throw new Error("unreachable");
    });
    await assert.rejects(f.first.conversationOperation("read", {session_id: "session", operation: {kind: "read"}}), /cannot replace/);
    assert.equal(f.state.getNativeConversation("conversation")?.workspace_id, original.workspace_id);
    assert.equal(f.state.getNativeConversation("conversation")?.rollback?.phase, "pending");
    f.config.provider_instances[0]!.env = {ANOTHER_ACCOUNT: "true"};
    await assert.rejects(f.manager().conversationOperation("read", {session_id: "session", operation: {kind: "read"}}), /provider identity changed/);
  } finally {await f.cleanup();}
});

test("generic forks persist independent bindings and duplicate commands cannot create another native fork", async () => {
  const f = await fixture();
  try {
    await f.first.stopSession("session", "idle");
    Object.assign(f.adapter, {conversationOperations: ["read", "fork"]});
    let mutations = 0;
    f.setOperation(async input => {
      if (input.request.operation.kind !== "fork") throw new Error("expected fork");
      input.beginMutation!(); mutations++;
      return {command_id: input.commandId, session_id: input.request.session_id, operation: "fork", filesystem_undo: false,
        fork: {session_id: input.request.operation.target_session_id, continuation_group_key: input.request.operation.continuation_group_key, native_reference: "forked-native"}};
    });
    const request = {session_id: "session", operation: {kind: "fork" as const, target_session_id: "fork-session", continuation_group_key: "fork-key", expected_history_hash: "a".repeat(64)}};
    const result = await f.first.conversationOperation("fork-command", request);
    assert.deepEqual(await f.manager().conversationOperation("fork-command", request), result);
    assert.equal(mutations, 1);
    assert.equal(f.state.getNativeConversation("conversation")?.native_thread_id, "native-conversation");
    assert.equal(f.state.getNativeConversation("fork-key")?.native_thread_id, "forked-native");
    await assert.rejects(f.first.conversationOperation("another-command", request), /fresh session/);
  } finally {await f.cleanup();}
});

test("fork preconditions leave no mutation fence, but lost native outcomes are never repeated", async () => {
  const f = await fixture();
  try {
    await f.first.stopSession("session", "idle");
    Object.assign(f.adapter, {conversationOperations: ["fork"]});
    const request = {session_id: "session", operation: {kind: "fork" as const, target_session_id: "fork-session", continuation_group_key: "fork-key", expected_history_hash: "a".repeat(64)}};
    f.setOperation(async () => {throw new Error("stale history before dispatch");});
    await assert.rejects(f.first.conversationOperation("stale", request), /stale history/);
    assert.equal(f.state.getNativeConversation("conversation")?.fork, undefined);
    let mutations = 0;
    f.setOperation(async input => {input.beginMutation!(); mutations++; throw new Error("transport lost after dispatch");});
    await assert.rejects(f.first.conversationOperation("lost", request), /transport lost/);
    await assert.rejects(f.manager().conversationOperation("lost", request), /automatic repetition/);
    await assert.rejects(f.manager().conversationOperation("new", request), /automatic repetition/);
    assert.equal(mutations, 1);
  } finally {await f.cleanup();}
});

test("content references are authorized by their session, workspace and original provider", async () => {
  const f = await fixture();
  try {
    let reference: import("@harness-control/protocol").HarnessContentReference | undefined;
    f.adapter.sendTurn = async input => {
      reference = input.publishContent!("🙂retained output".repeat(10_000));
      return [{event_type: "turn.completed", turn_id: input.payload.turn_id, data: {final_output: {final_text: "preview", content_ref: reference}}}];
    };
    await f.first.sendTurn({session_id: "session", turn_id: "content-turn", input: "get output"});
    await f.first.stopSession("session", "idle");
    const content = await f.first.conversationOperation("read-content", {session_id: "session",
      operation: {kind: "content", content_id: reference!.content_id, offset: 0, limit: 64 * 1024}});
    assert.equal(Buffer.from(content.content!.data_base64, "base64").length, 64 * 1024);
    await assert.rejects(f.first.conversationOperation("wrong", {session_id: "another",
      operation: {kind: "content", content_id: reference!.content_id, offset: 0, limit: 1}}), /another session/);
    f.config.provider_instances[0]!.env = {ANOTHER_ACCOUNT: "true"};
    await assert.rejects(f.first.conversationOperation("changed", {session_id: "session",
      operation: {kind: "content", content_id: reference!.content_id, offset: 0, limit: 1}}), /original provider/);
  } finally {await f.cleanup();}
});
