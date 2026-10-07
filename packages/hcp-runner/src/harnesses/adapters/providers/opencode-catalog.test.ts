import assert from "node:assert/strict";
import {test} from "node:test";
import {OpenCodeHarnessAdapter, type OpenCodeRuntime} from "./opencode.js";
import {controlledOpenCodeReference, controlledOpenCodeInheritance} from "./opencode-controlled.js";
import {RunnerConfigSchema} from "../../../config/index.js";
import type {HarnessAdapterStartInput} from "../types.js";

for (const scenario of ["confirmed", "lost-readback"] as const)
test(`OpenCode catalog transition requires native registry inspection before admission (${scenario})`, async () => {
  const binding = "a".repeat(64);
  const provider = RunnerConfigSchema.parse({runner_id: "runner", control_plane_url: "ws://localhost:1",
    provider_instances: [{id: "opencode", driver_kind: "opencode"}]}).provider_instances[0]!;
  let reads = 0, closes = 0, starts = 0;
  const runtime: OpenCodeRuntime = {sessionId: "native", sessionPermissions: true, confirmedApprovalPolicy: "ask",
    ownedAccount: {providerId: "anthropic", binding},
    async readMcpInventory() {reads++; if (scenario === "lost-readback") throw new Error("Native registry lost");
      return {source: "native", attachments: ["selected"]};},
    async close() {closes++;}, async sendTurn() {assert.fail("Catalog startup cannot dispatch a model prompt");}, async cancelTurn() {assert.fail("No root may be cancelled");}};
  const adapter = new OpenCodeHarnessAdapter({runtimeFactory: async input => {
    starts++; assert.equal(input.nativeThreadId, "native");
    assert.deepEqual(input.mcpServers, {selected: {type: "remote", url: "http://localhost:4321/owned", enabled: true}});
    return runtime;
  }});
  const input: HarnessAdapterStartInput = {provider, payload: {session_id: "target", continuation_group_key: "conversation",
    workspace_id: "workspace", cwd: process.cwd(), provider_instance_id: "opencode", driver_kind: "opencode",
    model_selection: {model: "anthropic/claude"}, sandbox_mode: "danger_full_access", approval_policy: "ask", execution_profile: "interactive",
    configuration_inheritance: controlledOpenCodeInheritance, continue_session: true, mcp_servers: [],
    conversation_transition: {transition_id: "catalog", change: "mcp_catalog", expected_history_hash: "b".repeat(64)}},
    mcpServers: [{name: "selected", transport: "streamable_http", url: "http://localhost:4321/owned", headers: {}}],
    nativeConversation: {native_thread_id: controlledOpenCodeReference({session_id: "native", provider_id: "anthropic", account_binding: binding}),
      binding_hash: "b".repeat(64), approval_policy: "ask", updated_at: new Date().toISOString(), last_session_id: "source",
      provider_instance_id: "opencode", provider_binding_hash: "c".repeat(64), workspace_id: "workspace", cwd: process.cwd()}};
  try {
    if (scenario === "confirmed") {
      const session = await adapter.startSession(input);
      assert.deepEqual(session.native_mcp_catalog_readback, {source: "native", attachments: ["selected"]});
      assert.equal(closes, 0); await adapter.stopSession({sessionId: "target"});
    } else await assert.rejects(adapter.startSession(input), /registry lost/);
    assert.equal(starts, 1); assert.equal(reads, 1); assert.equal(closes, 1);
  } finally {await adapter.close();}
});

test("background preflight precedes discovery and launch requires exact owned catalogs without plain native MCP", async () => {
  const provider = RunnerConfigSchema.parse({runner_id: "runner", control_plane_url: "ws://localhost:1",
    provider_instances: [{id: "opencode", driver_kind: "opencode"}]}).provider_instances[0]!;
  const payload: HarnessAdapterStartInput["payload"] = {session_id: "background", workspace_id: "workspace", cwd: process.cwd(),
    provider_instance_id: "opencode", driver_kind: "opencode", model_selection: {model: "opencode/public"},
    sandbox_mode: "danger_full_access", approval_policy: "full_access", execution_profile: "background",
    configuration_inheritance: controlledOpenCodeInheritance, continue_session: false, mcp_servers: []};
  let launches = 0;
  const adapter = new OpenCodeHarnessAdapter({runtimeFactory: async input => {
    launches++;assert.deepEqual(input.mcpServers, {});assert.deepEqual(input.workOwner!.mcpToolsets!.map(set => set.name), ["selected"]);
    throw new Error("Verified candidate factory boundary");
  }});
  const selected = {name: "selected", transport: "streamable_http" as const, url: "http://localhost:4321/owned", headers: {}};
  try {
    await adapter.validateStart({provider, payload, mcpServers: [selected]});
    const start = {provider, payload, mcpServers: [selected], emitSessionEvent() {}, registerSessionInteractions() {}};
    await assert.rejects(adapter.startSession(start), /exact authorized tool catalogs/);assert.equal(launches, 0);
    const set = {name: "selected", tools: [{name: "tool", input_schema: {type: "object"}}], async callTool() {return {is_error: false};}};
    await assert.rejects(adapter.startSession({...start, mcpToolsets: [{...set, name: "foreign"}]}), /exact authorized tool catalogs/);
    await assert.rejects(adapter.startSession({...start, mcpToolsets: [set, set]}), /exact authorized tool catalogs/);
    assert.equal(launches, 0);
    await assert.rejects(adapter.startSession({...start, mcpToolsets: [set]}), /Verified candidate factory boundary/);assert.equal(launches, 1);
    assert.equal(adapter.executionProfiles.find(profile => profile.id === "background")!.mcp_attachments, true);
  } finally {await adapter.close();}
});
