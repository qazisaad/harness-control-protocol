import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import type {HcpConversationRequestPayload, HcpSessionStartPayload} from "@harness-control/protocol";
import {HarnessSessionManager, HarnessAdapterRegistry, type HarnessAdapter} from "./index.js";
import {RunnerConfigSchema} from "../config/index.js";
import {JsonRunnerStateStore} from "../state/index.js";

async function fixture(lost = false, diagnostics = true) {
  const cwd = await mkdtemp(join(tmpdir(), "hcp-feedback-fixture-"));
  const statePath = join(cwd, "state.json"); let store = new JsonRunnerStateStore(statePath), calls = 0, modelCalls = 0;
  const adapter: HarnessAdapter = {driverKind: "example", emptyConversation: true, executionProfiles: [{id: "interactive", runtime_lifetime: "session",
    native_work: false, session_events: false, native_feedback: {owner: "live_conversation", classifications: ["bug"], diagnostics}}],
    async probe() {return {driver_kind: "example", available: true, installed: true, models: []};}, async validateStart() {},
    async startSession(input) {return {adapter_session_id: input.payload.session_id, native_thread_id: "native"};},
    async submitNativeFeedback(input) {
      calls++; assert.equal(store.getNativeConversation("conversation")!.feedback_submissions!.at(-1)!.phase, "pending");
      assert.equal(input.nativeThreadId, "native"); assert.equal(input.signal.aborted, false);
      if (lost) throw new Error("Native acknowledgement lost");
      return {feedback_id: "native-feedback-receipt"};
    }, async sendTurn(input) {modelCalls++; input.persistNativeThread?.("native");
      return [{event_type: "turn.completed", turn_id: input.payload.turn_id, data: {final_output: {final_text: "done"}}}];},
    async cancelTurn() {return [];}, async stopSession() {return [];},
  };
  const config = RunnerConfigSchema.parse({runner_id: "runner", control_plane_url: "ws://localhost:1", workspaces: [{id: "workspace", path: cwd}],
    provider_instances: [{id: "provider", driver_kind: "example"}]});
  const make = () => new HarnessSessionManager(config, {stateStore: store, adapterRegistry: new HarnessAdapterRegistry([adapter])});
  const manager = make();
  const start: HcpSessionStartPayload = {session_id: "source", workspace_id: "workspace", cwd, provider_instance_id: "provider", driver_kind: "example",
    model_selection: {model: "fixture"}, approval_policy: "ask", sandbox_mode: "read_only", continue_session: false,
    execution_profile: "interactive", continuation_group_key: "conversation", mcp_servers: []};
  await manager.startSession(start);
  const request: HcpConversationRequestPayload = {session_id: "source", operation: {kind: "feedback", classification: "bug",
    include_diagnostics: false, reason: "Explicit app bug report"}};
  return {manager, store, config, start, request, adapter, get calls() {return calls;}, get modelCalls() {return modelCalls;},
    reopen() {store = new JsonRunnerStateStore(statePath); return make();},
    async close() {await manager.stopSession("source", "cleanup"); await rm(cwd, {recursive: true, force: true});}};
}

test("native feedback dispatch is fenced once and survives root turns and runner recreation", async () => {
  const f = await fixture();
  try {
    const result = await f.manager.conversationOperation("feedback", f.request);
    assert.deepEqual(result.feedback, {source: "native", feedback_id: "native-feedback-receipt", classification: "bug", diagnostics_requested: false});
    assert.equal(f.calls, 1); assert.equal(f.modelCalls, 0);
    assert.deepEqual(await f.manager.conversationOperation("feedback", f.request), result); assert.equal(f.calls, 1);
    await f.manager.sendTurn({session_id: "source", turn_id: "followup", input: "Continue"});
    assert.equal(f.store.getNativeConversation("conversation")!.feedback_submissions![0]!.phase, "completed");
    await assert.rejects(f.manager.conversationOperation("feedback", {...f.request,
      operation: {kind: "feedback", classification: "bug", include_diagnostics: true}}), {code: "command_conflict"});
    await f.manager.stopSession("source", "recreate");
    assert.deepEqual(await f.reopen().conversationOperation("feedback", f.request), result); assert.equal(f.calls, 1);
  } finally {await f.close();}
});
test("lost feedback acknowledgement remains unknown across restart and cannot be replayed", async () => {
  const f = await fixture(true);
  try {
    await assert.rejects(f.manager.conversationOperation("feedback", f.request), {code: "native_feedback_unknown"});
    assert.equal(f.store.getNativeConversation("conversation")!.feedback_submissions![0]!.phase, "pending");
    await assert.rejects(f.manager.conversationOperation("feedback", f.request), {code: "native_feedback_unknown"});
    await assert.rejects(f.reopen().conversationOperation("feedback", f.request), {code: "native_feedback_unknown"});
    assert.equal(f.calls, 1); assert.equal(f.modelCalls, 0);
    const prior = f.store.getNativeConversation("conversation")!;
    const {feedback_submissions: ignored, ...erased} = prior;
    assert.throws(() => f.store.saveNativeConversation("conversation", erased), /cannot be erased/);
  } finally {await f.close();}
});
test("feedback capability, exact native owner and diagnostics selection are checked before dispatch", async () => {
  const f = await fixture(false, false);
  try {
    await assert.rejects(f.manager.conversationOperation("unsupported", {...f.request,
      operation: {kind: "feedback", classification: "quality", include_diagnostics: false}}), {code: "native_feedback_unsupported"});
    await assert.rejects(f.manager.conversationOperation("diagnostics", {...f.request,
      operation: {kind: "feedback", classification: "bug", include_diagnostics: true}}), {code: "native_feedback_unsupported"});
    const prior = f.store.getNativeConversation("conversation")!;
    assert.throws(() => f.store.saveNativeConversation("conversation", {...prior, feedback_submissions: [{command_id: "invented",
      request_hash: "a".repeat(64), source_session_id: "source", native_thread_id: "native", classification: "bug", include_diagnostics: false,
      phase: "completed", result: {source: "native", feedback_id: "invented", classification: "bug", diagnostics_requested: false}}]}), /prior durable dispatch fence/);
    await f.manager.stopSession("source", "closed");
    await assert.rejects(f.manager.conversationOperation("closed", f.request), {code: "native_feedback_owner_unavailable"});
    assert.equal(f.calls, 0); assert.equal(f.modelCalls, 0);
  } finally {await f.close();}
});
