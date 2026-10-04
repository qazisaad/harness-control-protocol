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
  return {adapter, state, calls, config, first, manager, setOperation: (next: typeof operation) => {operation = next;},
    cleanup: () => rm(cwd, {recursive: true, force: true})};
}

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
