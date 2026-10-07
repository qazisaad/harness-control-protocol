import assert from "node:assert/strict";
import {test} from "node:test";
import type {Query, SDKMessage, Options} from "@anthropic-ai/claude-agent-sdk";
import {PersistentClaudeSession} from "./claude-session.js";
import type {HarnessAdapterStartInput} from "../types.js";
import {RunnerConfigSchema} from "../../../config/index.js";

for (const scenario of ["confirmed", "foreign-session", "wrong-mode", "lost-control", "mcp-confirmed", "mcp-unconfirmed", "catalog-empty", "catalog-added", "auto-fresh", "auto-retained", "reject-fresh", "reject-retained", "reject-wrong-mode", "reject-lost-control"] as const)
test(`Claude idle replacement requires observed native policy without a user prompt (${scenario})`, async () => {
  const messages: SDKMessage[] = [], controls: string[] = [];
  const permissionChecks: Promise<void>[] = [];
  const withMcp = scenario.startsWith("mcp-") || scenario === "catalog-added";
  let servers: Record<string, {type: "http"; url: string}> = {}, registrations = 0;
  let wake: (() => void) | undefined, closed = false, promptCount = 0;
  const output = async function* () {
    while (!closed) {
      const message = messages.shift();
      if (message) yield message;
      else await new Promise<void>(resolve => {wake = resolve;});
    }
  };
  const config = RunnerConfigSchema.parse({runner_id: "runner", control_plane_url: "ws://localhost:1",
    workspaces: [{id: "workspace", path: process.cwd()}], provider_instances: [{id: "claude", driver_kind: "claude"}]});
  const start: HarnessAdapterStartInput = {provider: config.provider_instances[0]!,
    payload: {session_id: "target", workspace_id: "workspace", cwd: process.cwd(), provider_instance_id: "claude", driver_kind: "claude",
      model_selection: {model: "sonnet"}, approval_policy: "ask", sandbox_mode: "danger_full_access", execution_profile: "interactive",
      continue_session: true, continuation_group_key: "conversation", mcp_servers: []},
    nativeConversation: {native_thread_id: "native", binding_hash: "a".repeat(64), updated_at: new Date().toISOString(),
      last_session_id: "source", provider_instance_id: "claude", provider_binding_hash: "b".repeat(64), workspace_id: "workspace", cwd: process.cwd()},
    emitSessionEvent() {}, registerSessionInteractions() {}};
  if (scenario.startsWith("catalog-")) start.payload.conversation_transition = {transition_id: "catalog", expected_history_hash: "a".repeat(64), change: "mcp_catalog"};
  if (scenario.startsWith("auto-")) {start.payload.approval_policy = "auto_edits"; start.payload.approval_reviewer = "native_auto";
    if (scenario === "auto-fresh") delete start.nativeConversation;}
  if (scenario.startsWith("reject-")) {start.payload.approval_options = {permission_prompting: "reject_unapproved"};
    if (scenario === "reject-fresh") delete start.nativeConversation;}
  if (withMcp) start.mcpServers = [{name: "selected", transport: "streamable_http", url: "http://localhost:4321/owned", headers: {}}];
  const runtime = new PersistentClaudeSession(start, ({prompt, options}) => {
    if (scenario.startsWith("reject-")) {
      assert.ok(options);
      assert.equal(options.permissionMode, "dontAsk");
      permissionChecks.push(options.canUseTool!("Bash", {command: "do not run"}, {signal: new AbortController().signal, toolUseID: "native-call", requestId: "native-request"})
        .then(response => {assert.ok(response);assert.equal(response.behavior, "deny");}));
    }
    void (async () => {for await (const _message of prompt) promptCount++;})();
    return Object.assign(output(), {
      async initializationResult() {return {};},
      async mcpServerStatus() {return Object.entries(servers).map(([name, config]) => ({name, status: "connected", config}));},
      async setMcpServers(next: typeof servers) {
        assert.deepEqual(controls, ["acceptEdits", "default"]);
        assert.equal(promptCount, 0);
        registrations++; servers = next;
        return {added: scenario === "mcp-unconfirmed" ? [] : Object.keys(next), removed: [], errors: {}};
      },
      async setPermissionMode(mode: NonNullable<Options["permissionMode"]>) {
        controls.push(mode);
        if (scenario === "lost-control" || scenario === "reject-lost-control") throw new Error("Native acknowledgement lost");
        messages.push({type: "system", subtype: "status", status: null, uuid: "00000000-0000-4000-8000-000000000001",
          session_id: scenario === "foreign-session" ? "foreign" : runtime.nativeId,
          permissionMode: scenario === "wrong-mode" || scenario === "reject-wrong-mode" ? "bypassPermissions" : mode});
        wake?.(); wake = undefined;
      },
      close() {closed = true; wake?.();},
    }) as unknown as Query;
  });
  try {
    if (scenario === "confirmed" || scenario === "mcp-confirmed" || scenario.startsWith("catalog-") || scenario.startsWith("auto-") || ["reject-fresh", "reject-retained"].includes(scenario)) {
      assert.deepEqual(await runtime.confirmIdlePolicy(), {source: "native", execution_profile: "interactive",
        approval_policy: scenario.startsWith("auto-") ? "auto_edits" : "ask", sandbox_mode: "danger_full_access",
        ...(scenario.startsWith("auto-") ? {approval_reviewer: "native_auto"} : {}),
        ...(scenario.startsWith("reject-") ? {approval_options: {permission_prompting: "reject_unapproved"}} : {})});
      assert.deepEqual(controls, ["acceptEdits", scenario.startsWith("auto-") ? "auto" : scenario.startsWith("reject-") ? "dontAsk" : "default"]);
    } else await assert.rejects(runtime.confirmIdlePolicy());
    assert.equal(registrations, withMcp || scenario === "catalog-empty" ? 1 : 0);
    if (scenario === "mcp-confirmed" || scenario.startsWith("catalog-"))
      assert.deepEqual(runtime.nativeCatalogReadback, {source: "native", attachments: withMcp ? ["selected"] : []});
    if (scenario === "mcp-unconfirmed") await assert.rejects(runtime.confirmIdlePolicy());
    assert.equal(promptCount, 0);
    await Promise.all(permissionChecks);
  } finally {await runtime.stop();}
});
