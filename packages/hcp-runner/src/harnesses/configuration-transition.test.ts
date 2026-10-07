import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {hcpSessionStartPayloadSchema, type HcpSessionStartPayload} from "@harness-control/protocol";
import {HarnessSessionManager, HarnessAdapterRegistry, type HarnessAdapter} from "./index.js";
import {RunnerConfigSchema} from "../config/index.js";
import {JsonRunnerStateStore} from "../state/index.js";

async function fixture(mode: "confirmed" | "missing" | "wrong-policy" | "history-changed" | "lost-start" | "missing-catalog" | "missing-reviewer" | "wrong-reviewer" = "confirmed", emptyConversation = true) {
  const cwd = await mkdtemp(join(tmpdir(), "hcp-idle-transition-"));
  const store = new JsonRunnerStateStore(join(cwd, "state.json"));
  let history = {history_hash: "a".repeat(64), turn_count: 1, truncated: false,
    turns: [{id: "native-root", status: "completed", items: [{type: "text", text: "Retained native context"}]}]};
  let transitions = 0;
  const profiles = [{id: "interactive", runtime_lifetime: "session" as const, native_work: false, session_events: false,
    empty_conversation: emptyConversation, idle_configuration_transition: true, idle_mcp_catalog_transition: true, native_approval_review: true}];
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
        ...(input.payload.conversation_transition?.change === "mcp_catalog" && mode !== "missing-catalog"
          ? {native_mcp_catalog_readback: {source: "native" as const, attachments: input.payload.mcp_servers.map(server => server.name)}} : {}),
        ...(mode === "missing" && input.payload.conversation_transition ? {} : {native_policy_readback: {source: "native" as const,
          execution_profile: "interactive", approval_policy: input.payload.approval_policy,
          ...(input.payload.approval_reviewer && mode !== "missing-reviewer" ? {approval_reviewer: mode === "wrong-reviewer" ? "user" as const : input.payload.approval_reviewer} : {}),
          sandbox_mode: mode === "wrong-policy" && input.payload.conversation_transition ? "danger_full_access" as const : input.payload.sandbox_mode}})};
    },
    async conversationOperation(input) {return {command_id: input.commandId, session_id: input.request.session_id,
      operation: "read", filesystem_undo: false, history};},
    async sendTurn(input) {input.persistNativeThread?.("native"); return [{event_type: "turn.completed", turn_id: input.payload.turn_id,
      data: {final_output: {final_text: "done"}}}];}, async cancelTurn() {return [];}, async stopSession() {return [];},
  };
  const config = RunnerConfigSchema.parse({runner_id: "runner", control_plane_url: "ws://localhost:1", workspaces: [{id: "workspace", path: cwd}],
    provider_instances: [{id: "provider", driver_kind: "example"}]});
  const manager = new HarnessSessionManager(config, {stateStore: store, adapterRegistry: new HarnessAdapterRegistry([adapter]),
    mcpClientFactory: ({attachment}) => ({async connect() {}, async close() {},
      async listTools() {return [{name: "lookup", input_schema: {type: "object"}}];},
      async callTool() {return {is_error: false, content: [{type: "text", text: "fixture"}]};},
      adapterAttachment: {name: attachment.name, transport: "streamable_http", url: attachment.url, headers: {}}})});
  const source: HcpSessionStartPayload = {session_id: "source", workspace_id: "workspace", cwd, provider_instance_id: "provider", driver_kind: "example",
    model_selection: {model: "fixture"}, approval_policy: "ask", sandbox_mode: "read_only", continue_session: false,
    execution_profile: "interactive", continuation_group_key: "conversation", mcp_servers: [], instructions: {system: "Application instructions"}};
  await manager.startSession(source);
  if (!emptyConversation) await manager.sendTurn({session_id: "source", turn_id: "seed", input: "Establish retained conversation"});
  const target: HcpSessionStartPayload = {...source, session_id: "target", continue_session: true, approval_policy: "auto_edits", sandbox_mode: "workspace_write",
    conversation_transition: {transition_id: "transition", expected_history_hash: history.history_hash}};
  return {manager, source, target, store, adapter, get transitions() {return transitions;}, async close() {
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

for (const mode of ["confirmed", "missing-reviewer", "wrong-reviewer"] as const)
test(`native approval reviewer replacement requires declared support and readback (${mode})`, async () => {
  const f = await fixture(mode);
  try {
    await f.manager.stopSession("source", "reviewer-transition");
    const target = {...f.target, approval_reviewer: "native_auto" as const};
    f.adapter.executionProfiles![0]!.native_approval_review = false;
    await assert.rejects(f.manager.startSession(target), /does not declare native automatic approval review/);
    assert.equal(f.transitions, 0);
    f.adapter.executionProfiles![0]!.native_approval_review = true;
    if (mode !== "confirmed") {
      await assert.rejects(f.manager.startSession(target), /differs from the authorized/);
      assert.equal(f.store.getNativeConversation("conversation")!.configuration_transitions![0]!.phase, "pending");
    } else {
      await f.manager.startSession(target);
      assert.equal(f.store.getNativeConversation("conversation")!.approval_reviewer, "native_auto");
      await f.manager.stopSession("target", "reviewer-unload");
      const {conversation_transition: _transition, ...resumed} = target;
      await assert.rejects(f.manager.startSession({...resumed, session_id: "invalid-reviewer", approval_reviewer: "user"}), /policy changed/);
      await f.manager.startSession({...resumed, session_id: "reopen"});
      assert.equal(f.store.getNativeConversation("conversation")!.approval_reviewer, "native_auto");
    }
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

for (const mode of ["confirmed", "missing-catalog"] as const)
test(`MCP catalog replacement preserves authority and quarantines missing native inventory (${mode})`, async () => {
  const f = await fixture(mode);
  const attachment = {name: "selected-tools", transport: "streamable_http" as const, url: "https://example.com/mcp",
    lease_id: "catalog-lease", expires_at: new Date(Date.now() + 60000).toISOString(), headers: {},
    proof_of_possession: {scheme: "runner_signed_request" as const, key_id: "key", required_headers: ["x-hcp-proof-signature"]}};
  const target = {...f.target, mcp_servers: [attachment],
    conversation_transition: {...f.target.conversation_transition!, change: "mcp_catalog" as const}};
  try {
    const authority = f.store.getNativeConversation("conversation")!.configuration_authority_hash;
    const base = f.store.getNativeConversation("conversation")!.configuration_base_hash;
    await f.manager.stopSession("source", "catalog-source-closed");
    await assert.rejects(f.manager.startSession({...target, session_id: "wrong-authority", instructions: {system: "Other instructions"}}), /retain the verified/);
    await assert.rejects(f.manager.startSession({...target, session_id: "implicit-change",
      conversation_transition: {...target.conversation_transition, change: "policy"}}), /Retained instructions, inheritance/);
    assert.equal(f.transitions, 0);
    if (mode === "confirmed") {
      const events = await f.manager.startSession(target);
      assert.equal(events.some(event => event.event_type === "turn.started"), false);
      const current = f.store.getNativeConversation("conversation")!;
      assert.equal(current.configuration_authority_hash, authority);
      assert.notEqual(current.configuration_base_hash, base);
      assert.equal(current.configuration_transitions![0]!.change, "mcp_catalog");
      assert.equal(current.configuration_transitions![0]!.phase, "completed");
      const altered = {...current, configuration_authority_hash: "c".repeat(64)};
      assert.throws(() => f.store.saveNativeConversation("conversation", altered), /authority/);
      await f.manager.stopSession("target", "catalog-target-closed");
      const {conversation_transition: _receipt, ...reopen} = target;
      await f.manager.startSession({...reopen, session_id: "reopen"});
    } else {
      await assert.rejects(f.manager.startSession(target), /exact authorized attachment registry/);
      assert.equal(f.store.getNativeConversation("conversation")!.configuration_transitions![0]!.phase, "pending");
      await assert.rejects(f.manager.startSession({...target, session_id: "reopen"}), /prior configuration transition/);
    }
  } finally {await f.close();}
});
