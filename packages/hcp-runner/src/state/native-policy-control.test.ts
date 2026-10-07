import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtemp, rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import type {HcpConversationResultPayload, HcpHarnessEventPayload} from "@harness-control/protocol";
import {MemoryRunnerStateStore, JsonRunnerStateStore, type RunnerStateStore, type NativePolicyControlReceipt} from "./index.js";

const a = "a".repeat(64), b = "b".repeat(64), c = "c".repeat(64);
function initialize(store: RunnerStateStore) {
  store.saveNativeConversation("conversation", {native_thread_id: "native", binding_hash: a, updated_at: "2026-01-01T00:00:00.000Z",
    last_session_id: "session", provider_instance_id: "provider", provider_binding_hash: "provider-hash", workspace_id: "workspace", cwd: "/workspace",
    approval_policy: "ask", configuration_base_hash: a, configuration_authority_hash: a});
  store.saveNativeWorkState("session", {scope: {provider_instance_id: "provider", provider_binding_hash: "provider-hash", workspace_id: "workspace",
    cwd: "/workspace", execution_binding_hash: a, execution_profile: "interactive", conversation_key: "conversation"},
    root_executions: [{admission_id: "old-root", origin_turn_id: "old-turn", native_reference: "native", native_execution_reference: "execution",
      requires_terminal_proof: true, phase_status: "completed"}],
    items: {child: {work_id: "child", native_reference: "native-child", origin_turn_id: "old-turn", kind: "task", background: true,
      status: "completed", supports_cancel: false, revision: 1}}, retired: {}});
}
const receipt = (command_id = "command", source_binding_hash = a, target_binding_hash = b, source_revision = 0): NativePolicyControlReceipt =>
  ({command_id, source_session_id: "session", native_reference: "native", request_hash: a, source_binding_hash, target_binding_hash, source_revision,
    selection: {approval_policy: "auto_edits", approval_reviewer: "user"}, phase: "pending"});
const result = (command_id = "command", revision = 1): HcpConversationResultPayload => ({command_id, session_id: "session", operation: "policy", filesystem_undo: false,
  policy: {source: "native", native_reference: "native", revision, mode: "execute", selection: {approval_policy: "auto_edits", approval_reviewer: "user"},
    observed_at: "2026-01-01T00:00:00.000Z", native_source: "claude.sdk.system.status", native_permission_mode: "acceptEdits"}});

test("atomic in-place policy scopes preserve physical identity and every prior execution binding", () => {
  const store = new MemoryRunnerStateStore(); initialize(store);
  store.beginNativePolicyControl("conversation", receipt());
  store.completeNativePolicyControl("conversation", "session", "command", result());
  const first = store.nativeWorkState("session")!;
  assert.equal(first.scope.execution_binding_hash, b);
  assert.deepEqual(first.execution_bindings, [{kind: "root", admission_id: "old-root", binding_hash: a}, {kind: "work", admission_id: "child", binding_hash: a}]);
  store.saveNativeWorkState("session", {...first, root_executions: [...first.root_executions!, {admission_id: "new-root", origin_turn_id: "new-turn",
    native_reference: "native", native_execution_reference: "new-execution", requires_terminal_proof: true, phase_status: "completed"}]});
  store.beginNativePolicyControl("conversation", receipt("second", b, c, 1));
  store.completeNativePolicyControl("conversation", "session", "second", result("second", 2));
  const conversation = store.getNativeConversation("conversation")!;
  assert.equal(conversation.native_thread_id, "native"); assert.equal(conversation.binding_hash, c);
  assert.equal(conversation.configuration_base_hash, a); assert.equal(conversation.configuration_authority_hash, a);
  assert.equal(conversation.configuration_transitions, undefined);
  assert.deepEqual(store.nativeWorkState("session")!.execution_bindings,
    [...first.execution_bindings!, {kind: "root", admission_id: "new-root", binding_hash: b}]);
});

test("ordinary metadata saves cannot manufacture policy completion, change scope or rewrite execution history", () => {
  const store = new MemoryRunnerStateStore(); initialize(store);
  assert.throws(() => store.saveNativeConversation("conversation", {...store.getNativeConversation("conversation")!, policy_controls: [receipt()]}), /dedicated atomic/);
  store.beginNativePolicyControl("conversation", receipt());
  assert.throws(() => store.saveNativeConversation("conversation", {...store.getNativeConversation("conversation")!, policy_controls: []}), /dedicated atomic/);
  assert.throws(() => store.saveNativeWorkState("session", {...store.nativeWorkState("session")!, scope: {...store.nativeWorkState("session")!.scope,
    execution_binding_hash: b}}), /scope changed/);
  store.completeNativePolicyControl("conversation", "session", "command", result());
  assert.throws(() => store.saveNativeWorkState("session", {...store.nativeWorkState("session")!, execution_bindings: []}), /cannot be erased/);
});

test("policy persistence failures roll back both configuration scopes and events while retaining the pending fence", () => {
  class FailingStore extends MemoryRunnerStateStore {fail = false; override persist() {if (this.fail) throw new Error("Fixture persistence failure");}}
  const store = new FailingStore(); initialize(store);
  store.fail = true; assert.throws(() => store.beginNativePolicyControl("conversation", receipt()), /Fixture persistence failure/);
  assert.equal(store.getNativeConversation("conversation")!.policy_controls, undefined);
  store.fail = false; store.beginNativePolicyControl("conversation", receipt()); store.fail = true;
  const event: HcpHarnessEventPayload = {session_id: "session", sequence: 1, created_at: "2026-01-01T00:00:00.000Z", event_type: "session.configured",
    data: {execution_profile: "interactive", model_selection: {model: "model"}, mode: "execute", native_conversation_ready: true, native_reference: "native"}};
  assert.throws(() => store.completeNativePolicyControl("conversation", "session", "command", result(), event), /Fixture persistence failure/);
  assert.equal(store.getNativeConversation("conversation")!.policy_controls![0]!.phase, "pending");
  assert.equal(store.getNativeConversation("conversation")!.binding_hash, a); assert.equal(store.nativeWorkState("session")!.scope.execution_binding_hash, a);
  assert.equal(store.nextEventSequence("session"), 1);
  store.fail = false; assert.throws(() => store.beginNativePolicyControl("conversation", receipt("another")), /uncertain mutations/);
});

test("policy fences survive restart and reject wrong acknowledgement or changed native inventory", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "hcp-policy-receipt-"));
  try {
    const path = join(cwd, "state.json"), first = new JsonRunnerStateStore(path); initialize(first);
    first.beginNativePolicyControl("conversation", receipt());
    const store = new JsonRunnerStateStore(path);
    assert.equal(store.getNativeConversation("conversation")!.policy_controls![0]!.phase, "pending");
    assert.throws(() => store.completeNativePolicyControl("conversation", "session", "command", result("wrong-command")), /dispatch/);
    const work = store.nativeWorkState("session")!;
    store.saveNativeWorkState("session", {...work, items: {...work.items, child: {...work.items.child!, revision: 2}}});
    assert.throws(() => store.completeNativePolicyControl("conversation", "session", "command", result()), /original dispatch fence/);
    assert.equal(store.getNativeConversation("conversation")!.binding_hash, a);
  } finally {await rm(cwd, {recursive: true, force: true});}
});
