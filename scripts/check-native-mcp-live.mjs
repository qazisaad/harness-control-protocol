import assert from "node:assert/strict";
import {mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {HarnessSessionManager} from "@harness-control/runner/harnesses";
import {RunnerConfigSchema} from "@harness-control/runner/config";
import {JsonRunnerStateStore} from "@harness-control/runner/state";
import {McpProxyServer} from "@harness-control/runner/mcp";
import {hcpHarnessEventPayloadSchema} from "@harness-control/protocol";

if (process.env.HCP_NATIVE_LIVE !== "1") throw new Error("Set HCP_NATIVE_LIVE=1 for authenticated native acceptance.");
for (const driver of (process.env.HCP_LIVE_PROVIDERS ?? "codex,claude,opencode").split(",")) {
  assert.ok(["codex", "claude", "opencode"].includes(driver));
  const cwd = await mkdtemp(join(tmpdir(), `hcp-live-mcp-${driver}-`));
  const marker = randomUUID(), passed = [], proxies = [];
  let calls = 0, closures = 0;
  const tool = {name: "get_marker", description: "Return the safe local acceptance marker. Invoke once when asked.", input_schema: {type: "object", properties: {}, additionalProperties: false}};
  const backend = {async connect() {}, async close() {}, async listTools() {return [tool];},
    async callTool(name, args) {assert.equal(name, "get_marker"); assert.deepEqual(args, {}); calls++;
      return {is_error: false, content: [{type: "text", text: marker}], structured_content: {marker}};}};
  const config = RunnerConfigSchema.parse({runner_id: "mcp-acceptance", control_plane_url: "ws://localhost:1",
    workspaces: [{id: "workspace", path: cwd}], provider_instances: [{id: driver, driver_kind: driver}]});
  const state = new JsonRunnerStateStore(join(cwd, "state.json"));
  // Only this controlled local fixture is authorized. The descriptor is never fetched remotely.
  const manager = new HarnessSessionManager(config, {stateStore: state, mcpClientFactory: () => {
    const proxy = new McpProxyServer({attachment: {name: "selected", allowed_tools: ["get_marker"]}, upstream: backend}); proxies.push(proxy);
    return {async connect() {await proxy.connect();}, get adapterAttachment() {return proxy.adapterAttachment;},
      async listTools() {return [tool];}, async callTool(...args) {return backend.callTool(...args);},
      async close() {closures++; await proxy.close();}};
  }});
  const events = [];
  const unsubscribe = manager.subscribeEvents(event => {hcpHarnessEventPayloadSchema.parse(event); events.push(event);});
  const descriptor = {name: "selected", transport: "streamable_http", url: "https://example.invalid/local-acceptance-only", headers: {}, allowed_tools: ["get_marker"], lease_id: "local-fixture",
    proof_of_possession: {scheme: "runner_signed_request", key_id: "local-fixture", required_headers: ["x-hcp-session-id", "x-hcp-host-id", "x-hcp-proof-signature", "x-hcp-proof-nonce"]}};
  let active = "first", nativeReference, stage = "model-selection";
  try {
    const model = driver === "codex" ? process.env.HCP_LIVE_CODEX_MODEL ?? (await manager.providerDriverStatuses()).find(provider => provider.driver_kind === "codex")?.models.find(model => model.is_default)?.id
      : driver === "claude" ? process.env.HCP_LIVE_CLAUDE_MODEL ?? "sonnet" : process.env.HCP_LIVE_OPENCODE_MODEL ?? "opencode-go/glm-5.3-flash";
    assert.ok(model);
    const start = {session_id: active, workspace_id: "workspace", cwd, provider_instance_id: driver, driver_kind: driver, execution_profile: "interactive",
      model_selection: {model}, sandbox_mode: "danger_full_access", approval_policy: "full_access", continue_session: false,
      continuation_group_key: "mcp-conversation", mcp_servers: [descriptor],
      ...(driver === "opencode" ? {configuration_inheritance: {user_settings: false, project_settings: false, hooks: false, mcp_servers: false, plugins: false}} : {})};
    for (const phase of ["first", "resumed"]) {
      active = phase;
      stage = `${phase}-startup`;
      await manager.startSession({...start, session_id: active, continue_session: phase === "resumed"});
      const before = calls;
      stage = `${phase}-turn`;
      await manager.sendTurn({session_id: active, turn_id: phase, input:
        "Call the selected MCP server's get_marker tool exactly once with empty arguments. Reply only with its returned marker. Use no other tool or command."});
      stage = `${phase}-terminal`;
      assert.equal(events.findLast(event => event.session_id === active && event.turn_id === phase && ["turn.completed", "turn.failed", "turn.cancelled"].includes(event.event_type))?.event_type, "turn.completed");
      stage = `${phase}-invocation-count`;
      assert.equal(calls, before + 1);
      stage = `${phase}-result`;
      assert.ok(events.some(event => event.session_id === active && event.event_type === "turn.completed" && JSON.stringify(event.data).includes(marker)));
      passed.push(`${phase}-native-tool-invocation`, `${phase}-tool-result`);
      const native = state.getNativeConversation("mcp-conversation").native_thread_id;
      if (phase === "first") nativeReference = native;
      else {assert.equal(native, nativeReference); passed.push("same-conversation-resumed");}
      await manager.stopSession(active, "mcp-acceptance-unload");
      assert.equal(closures, phase === "first" ? 1 : 2); passed.push(`${phase}-owned-proxy-detach`);
    }
    console.log(JSON.stringify({driver, cwd, passed}));
  } catch (error) {console.log(JSON.stringify({driver, cwd, passed, stage, calls, failed: true, code: error?.code ?? "acceptance_failure"})); process.exitCode = 1;}
  finally {unsubscribe(); try {await manager.stopSession(active, "mcp-acceptance-cleanup");} catch {process.exitCode = 1;}
    for (const proxy of proxies) try {await proxy.close();} catch {process.exitCode = 1;}}
}
