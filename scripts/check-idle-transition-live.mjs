import assert from "node:assert/strict";
import {mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {HarnessSessionManager} from "@harness-control/runner/harnesses";
import {RunnerConfigSchema} from "@harness-control/runner/config";
import {JsonRunnerStateStore} from "@harness-control/runner/state";
import {hcpHarnessEventPayloadSchema} from "@harness-control/protocol";
import {McpProxyServer} from "@harness-control/runner/mcp";

if (process.env.HCP_NATIVE_LIVE !== "1") throw new Error("Set HCP_NATIVE_LIVE=1 to run authenticated acceptance.");
const cwd = await mkdtemp(join(tmpdir(), "hcp-live-idle-transition-"));
const driver = process.env.HCP_LIVE_PROVIDER ?? "codex";
assert.ok(["codex", "claude", "opencode"].includes(driver));
const statePath = join(cwd, "state.json");
const config = RunnerConfigSchema.parse({runner_id: "transition-acceptance", control_plane_url: "ws://localhost:8787",
  workspaces: [{id: "workspace", path: cwd}], provider_instances: [{id: driver, driver_kind: driver}]});
const withMcp = process.env.HCP_LIVE_MCP === "1";
assert.ok(!withMcp || ["claude", "opencode"].includes(driver));
let calls = 0, closures = 0;
const toolMarker = randomUUID(), proxies = [];
const tool = {name: "get_marker", description: "Return the controlled local acceptance marker.", input_schema: {type: "object", properties: {}, additionalProperties: false}};
const backend = {async connect() {}, async close() {}, async listTools() {return [tool];},
  async callTool(name, args) {assert.equal(name, "get_marker"); assert.deepEqual(args, {}); calls++;
    return {is_error: false, content: [{type: "text", text: toolMarker}]};}};
const descriptor = {name: "selected", transport: "streamable_http", url: "https://example.invalid/local-acceptance-only", headers: {}, allowed_tools: ["get_marker"], lease_id: "local-fixture",
  proof_of_possession: {scheme: "runner_signed_request", key_id: "local-fixture", required_headers: ["x-hcp-session-id", "x-hcp-host-id", "x-hcp-proof-signature", "x-hcp-proof-nonce"]}};
const make = () => new HarnessSessionManager(config, {stateStore: new JsonRunnerStateStore(statePath), ...(withMcp ? {mcpClientFactory: () => {
  const proxy = new McpProxyServer({attachment: {name: "selected", allowed_tools: ["get_marker"]}, upstream: backend}); proxies.push(proxy);
  return {async connect() {await proxy.connect();}, get adapterAttachment() {return proxy.adapterAttachment;},
    async listTools() {return [tool];}, async callTool(...args) {return backend.callTool(...args);},
    async close() {closures++; await proxy.close();}};
}} : {})});
let manager = make(), active;
const status = (await manager.providerDriverStatuses()).find(value => value.driver_kind === driver);
const model = driver === "codex" ? process.env.HCP_LIVE_CODEX_MODEL ?? "gpt-6.1-sol" : driver === "opencode"
  ? process.env.HCP_LIVE_OPENCODE_MODEL ?? "opencode-go/glm-5.3-flash" : status?.models.find(value => value.is_default)?.id ?? status?.models[0]?.id;
assert.ok(model);
const events = [], passed = [], marker = randomUUID();
const observe = event => {
  hcpHarnessEventPayloadSchema.parse(event); events.push(event);
  if (["approval.requested", "user_input.requested"].includes(event.event_type))
    throw new Error("A no-tool transition acceptance requested unexpected native interaction");
};
const source = {session_id: "source", workspace_id: "workspace", cwd, provider_instance_id: driver, driver_kind: driver,
  model_selection: {model},
  sandbox_mode: driver === "codex" ? "read_only" : "danger_full_access", approval_policy: withMcp ? "full_access" : "ask",
  continue_session: false, continuation_group_key: "conversation", mcp_servers: withMcp ? [descriptor] : [], execution_profile: "isolated",
  ...(driver !== "codex" ? {configuration_inheritance: {user_settings: false, project_settings: false, hooks: false, mcp_servers: false, plugins: false}} : {})};
const send = async (session_id, turn_id, input) => {
  await manager.sendTurn({session_id, turn_id, input}, observe);
  const final = events.findLast(event => event.session_id === session_id && event.turn_id === turn_id
    && ["turn.completed", "turn.failed", "turn.cancelled"].includes(event.event_type));
  assert.equal(final?.event_type, "turn.completed");
  return final.data.final_output.final_text;
};
const read = async session_id => (await manager.conversationOperation(randomUUID(), {session_id, operation: {kind: "read"}})).history;
try {
  await manager.startSession(source); active = source.session_id;
  await send(active, "seed", `Remember this exact marker: ${marker}. Reply SAVED only. Use no tools.`);
  let history = await read(active);
  assert.ok(history.turn_count >= 1);
  await manager.stopSession(active, "source-closed"); active = undefined; manager = make();
  history = await read(source.session_id);
  passed.push("closed-source-and-runner-restart");
  const transitions = driver === "codex" ? [["writable", "workspace_write", "auto_edits"], ["restricted", "read_only", "ask"]]
    : [["writable", "danger_full_access", "auto_edits"], ["restricted", "danger_full_access", withMcp ? "full_access" : "ask"]];
  for (const [id, sandbox_mode, approval_policy] of transitions) {
    const target = {...source, session_id: id, continue_session: true, execution_profile: "interactive", sandbox_mode, approval_policy,
      conversation_transition: {transition_id: randomUUID(), expected_history_hash: history.history_hash}};
    const before = events.length;
    const startup = await manager.startSession(target); active = id;
    const configured = startup.find(event => event.event_type === "session.configured");
    assert.deepEqual(configured.data.native_policy_readback, {source: "native", execution_profile: "interactive", sandbox_mode, approval_policy});
    assert.equal(startup.some(event => event.turn_id), false);
    assert.equal(events.length, before);
    assert.equal((await read(active)).history_hash, history.history_hash);
    const binding = new JsonRunnerStateStore(statePath).getNativeConversation("conversation");
    assert.equal(binding.last_session_id, id);
    assert.equal(binding.configuration_transitions.at(-1).phase, "completed");
    passed.push(`${id}-native-policy-confirmed-without-model`, `${id}-history-preserved-and-receipt-retained`);
    assert.ok((await send(active, `${id}-recall`, "Reply with the remembered marker only. Use no tools.")).includes(marker));
    passed.push(`${id}-native-context-retained`);
    await manager.stopSession(active, "transition-closed"); active = undefined; manager = make();
    history = await read(id);
  }
  const {conversation_transition: ignored, ...resume} = {...source, session_id: "reopened", continue_session: true, execution_profile: "interactive"};
  await manager.startSession(resume); active = resume.session_id;
  assert.equal((await read(active)).history_hash, history.history_hash);
  if (withMcp) {
    assert.equal(calls, 0); assert.equal(closures, 3);
    assert.ok((await send(active, "selected-tool", "Call the selected MCP server's get_marker tool exactly once with empty arguments. Reply only with its returned marker. Use no other tools.")).includes(toolMarker));
    assert.equal(calls, 1); passed.push("selected-tool-preserved-after-policy-transitions");
  }
  await manager.stopSession(active, "acceptance-finished"); active = undefined;
  if (withMcp) {assert.equal(closures, 4); passed.push("all-replaced-owned-proxies-closed");}
  passed.push("ordinary-resume-after-completed-transition");
  console.log(JSON.stringify({driver, passed, cwd, event_count: events.length}));
} catch (error) {
  process.exitCode = 1;
  console.error(JSON.stringify({driver, passed, cwd, code: typeof error?.code === "string" && /^[a-zA-Z0-9_]{1,128}$/.test(error.code) ? error.code : "acceptance_failed", failed: true}));
} finally {
  if (active) try {await manager.stopSession(active, "acceptance-cleanup");} catch {process.exitCode = 1;}
  for (const proxy of proxies) try {await proxy.close();} catch {process.exitCode = 1;}
}
