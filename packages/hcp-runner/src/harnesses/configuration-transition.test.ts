import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {hcpSessionStartPayloadSchema, type HcpSessionStartPayload} from "@harness-control/protocol";
import {HarnessSessionManager, HarnessAdapterRegistry, type HarnessAdapter} from "./index.js";
import {RunnerConfigSchema} from "../config/index.js";
import {JsonRunnerStateStore} from "../state/index.js";

async function fixture(mode: "confirmed" | "missing" | "wrong-policy" | "history-changed" | "lost-start" = "confirmed", emptyConversation = true) {
  const cwd = await mkdtemp(join(tmpdir(), "hcp-idle-transition-"));
  const store = new JsonRunnerStateStore(join(cwd, "state.json"));
  let history = {history_hash: "a".repeat(64), turn_count: 1, truncated: false,
    turns: [{id: "native-root", status: "completed", items: [{type: "text", text: "Retained native context"}]}]};
  let transitions = 0;
  const profiles = [{id: "interactive", runtime_lifetime: "session" as const, native_work: false, session_events: false,
    empty_conversation: emptyConversation, idle_configuration_transition: true}];
  const adapter: HarnessAdapter = {driverKind: "example", ...(emptyConversation ? {emptyConversation: true as const} : {}), liveHistoryRead: true, executionProfiles: profiles,
    instructionRoles: ["system"], configurationInheritance: {hooks: false}, conversationOperations: ["read"],
    async probe() {return {driver_kind: "example", installed: true, available: true, models: []};}, async validateStart() {},
    async startSession(input) {
      if (input.payload.conversation_transition) {
        transitions++;
        assert.equal(store.getNativeConversation("conversation")!.configuration_transitions!.at(-1)!.phase, "pending");
        if (mode === "lost-start") throw new Error("Native startup acknowledgement lost");
        if (mode === "history-changed") history = {...history, history_hash: "b".repeat(64)};
      }
      return {adapter_session_id: input.payload.session_id, native_thread_id: "native",
        ...(mode === "missing" && input.payload.conversation_transition ? {} : {native_policy_readback: {source: "native" as const,
          execution_profile: "interactive", approval_policy: input.payload.approval_policy,
          sandbox_mode: mode === "wrong-policy" && input.payload.conversation_transition ? "danger_full_access" as const : input.payload.sandbox_mode}})};
    },
    async conversationOperation(input) {return {command_id: input.commandId, session_id: input.request.session_id,
      operation: "read", filesystem_undo: false, history};},
    async sendTurn(input) {input.persistNativeThread?.("native"); return [{event_type: "turn.completed", turn_id: input.payload.turn_id,
      data: {final_output: {final_text: "done"}}}];}, async cancelTurn() {return [];}, async stopSession() {return [];},
  };
  const config = RunnerConfigSchema.parse({runner_id: "runner", control_plane_url: "ws://localhost:1", workspaces: [{id: "workspace", path: cwd}],
    provider_instances: [{id: "provider", driver_kind: "example"}]});
  const manager = new HarnessSessionManager(config, {stateStore: store, adapterRegistry: new HarnessAdapterRegistry([adapter])});
  const source: HcpSessionStartPayload = {session_id: "source", workspace_id: "workspace", cwd, provider_instance_id: "provider", driver_kind: "example",
    model_selection: {model: "fixture"}, approval_policy: "ask", sandbox_mode: "read_only", continue_session: false,
    execution_profile: "interactive", continuation_group_key: "conversation", mcp_servers: [], instructions: {system: "Application instructions"}};
  await manager.startSession(source);
  if (!emptyConversation) await manager.sendTurn({session_id: "source", turn_id: "seed", input: "Establish retained conversation"});
  const target: HcpSessionStartPayload = {...source, session_id: "target", continue_session: true, approval_policy: "auto_edits", sandbox_mode: "workspace_write",
    conversation_transition: {transition_id: "transition", expected_history_hash: history.history_hash}};
  return {manager, source, target, store, get transitions() {return transitions;}, async close() {
    for (const id of ["source", "target", "reopen"]) try {await manager.stopSession(id, "fixture-cleanup");} catch (error) {if ((error as {code?: string}).code !== "session_not_found") throw error;}
    await rm(cwd, {recursive: true, force: true});
  }};
}

for (const emptyConversation of [false, true]) test(`idle configuration replacement preserves native history without requiring fresh empty support (${emptyConversation})`, async () => {
  const f = await fixture("confirmed", emptyConversation);
  try {
    await assert.rejects(f.manager.startSession(f.target), /already has an active session/);
    assert.equal(f.transitions, 0);
    await f.manager.stopSession("source", "transition-source-closed");
    await assert.rejects(f.manager.startSession({...f.target, session_id: "invalid-instructions", instructions: {system: "Changed instructions"}}), /Retained instructions, inheritance/);
    await assert.rejects(f.manager.startSession({...f.target, session_id: "invalid-history", conversation_transition: {...f.target.conversation_transition!, expected_history_hash: "c".repeat(64)}}), /Read current native history/);
    assert.equal(f.transitions, 0);
    const events = await f.manager.startSession(f.target);
    assert.deepEqual((events.find(event => event.event_type === "session.configured")!.data as {native_policy_readback: unknown}).native_policy_readback,
      {source: "native", execution_profile: "interactive", approval_policy: "auto_edits", sandbox_mode: "workspace_write"});
    assert.equal(events.some(event => event.event_type === "turn.started"), false);
    const binding = f.store.getNativeConversation("conversation")!;
    assert.equal(binding.native_thread_id, "native"); assert.equal(binding.last_session_id, "target");
    assert.equal(binding.configuration_transitions![0]!.phase, "completed"); assert.equal(f.transitions, 1);
    await f.manager.sendTurn({session_id: "target", turn_id: "followup", input: "continue"});
    assert.equal(f.store.getNativeConversation("conversation")!.configuration_transitions![0]!.phase, "completed");
    await f.manager.stopSession("target", "transition-target-closed");
    const {conversation_transition: _transition, ...reopen} = f.target;
    await f.manager.startSession({...reopen, session_id: "reopen"});
    const resumed = await f.manager.conversationOperation("resume-read", {session_id: "reopen", operation: {kind: "read"}});
    assert.equal(resumed.history?.history_hash, "a".repeat(64));
    assert.equal(f.transitions, 1);
  } finally {await f.close();}
});

for (const mode of ["missing", "wrong-policy", "history-changed", "lost-start"] as const)
test(`unconfirmed native configuration replacement retains its durable fence (${mode})`, async () => {
  const f = await fixture(mode);
  try {
    await f.manager.stopSession("source", "transition-source-closed");
    await assert.rejects(f.manager.startSession(f.target));
    const retained = f.store.getNativeConversation("conversation")!;
    assert.equal(retained.last_session_id, "source"); assert.equal(retained.configuration_transitions![0]!.phase, "pending");
    assert.equal(f.transitions, 1);
    const {configuration_transitions: ignored, ...erased} = retained;
    assert.throws(() => f.store.saveNativeConversation("conversation", erased), /cannot be erased/);
    assert.throws(() => f.store.saveNativeConversation("conversation", {...retained, configuration_transitions: [
      ...retained.configuration_transitions!, {...retained.configuration_transitions![0]!, transition_id: "invented", phase: "completed"}]}), /prior durable dispatch fence/);
    await assert.rejects(f.manager.startSession({...f.source, session_id: "reopen", continue_session: true}), /no confirmed outcome/);
    await assert.rejects(f.manager.conversationOperation("retire", {session_id: "source", operation: {kind: "retire"}}), /requires reconciliation/);
    assert.equal(f.transitions, 1);
  } finally {await f.close();}
});

test("configuration transition packets cannot combine model dispatch or omit continuation", () => {
  const base = {session_id: "target", workspace_id: "workspace", cwd: "/tmp", provider_instance_id: "provider", driver_kind: "example",
    model_selection: {model: "fixture"}, approval_policy: "ask", sandbox_mode: "read_only", continue_session: true,
    continuation_group_key: "conversation", mcp_servers: [], conversation_transition: {transition_id: "transition", expected_history_hash: "a".repeat(64)}};
  assert.equal(hcpSessionStartPayloadSchema.safeParse(base).success, true);
  assert.equal(hcpSessionStartPayloadSchema.safeParse({...base, continue_session: false}).success, false);
  assert.equal(hcpSessionStartPayloadSchema.safeParse({...base, continuation_group_key: undefined}).success, false);
  assert.equal(hcpSessionStartPayloadSchema.safeParse({...base, first_turn: {turn_id: "root", input: "execute", not_after: "2999-01-01T00:00:00Z"}}).success, false);
});

for (const closure of ["running", "unconfirmed"] as const)
test(`configuration replacement cannot erase native work closure uncertainty (${closure})`, async () => {
  const f = await fixture();
  try {
    await f.manager.stopSession("source", "fixture-source-exited");
    const binding = f.store.getNativeConversation("conversation")!;
    f.store.saveNativeWorkState("source", {scope: {provider_instance_id: "provider", provider_binding_hash: binding.provider_binding_hash,
      workspace_id: "workspace", cwd: binding.cwd, execution_binding_hash: binding.binding_hash},
      items: closure === "running" ? {agent: {work_id: "agent", native_reference: "child", origin_turn_id: "root", kind: "agent",
        background: true, status: "running", supports_cancel: true, revision: 1}} : {}, retired: {},
      ...(closure === "unconfirmed" ? {closure_unconfirmed: true as const} : {})});
    await assert.rejects(f.manager.startSession(f.target), /unconfirmed closure/);
    assert.equal(f.transitions, 0);
    assert.equal(f.store.getNativeConversation("conversation")!.configuration_transitions, undefined);
  } finally {await f.close();}
});
