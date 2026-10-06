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

if (process.env.HCP_NATIVE_LIVE !== "1") throw new Error("Set HCP_NATIVE_LIVE=1 for authenticated acceptance.");
const cwd = await mkdtemp(join(tmpdir(), "hcp-live-claude-child-mcp-"));
const marker = randomUUID(), passed = [], events = [];
let calls = 0, closures = 0, active = false, stage = "startup";
let release;
const held = new Promise(resolve => {release = resolve;});
const tool = {name: "get_marker", description: "Return the controlled local acceptance marker.", input_schema: {type: "object", properties: {}, additionalProperties: false}};
const backend = {async connect() {}, async close() {}, async listTools() {return [tool];},
  async callTool(name, args) {assert.equal(name, "get_marker"); assert.deepEqual(args, {}); calls++;
    let timer;
    try {await Promise.race([held, new Promise((_, reject) => {timer = setTimeout(() => reject(new Error("Controlled tool deadline exceeded.")), 90000);})]);}
    finally {clearTimeout(timer);}
    return {is_error: false, content: [{type: "text", text: marker}]};}};
const proxy = new McpProxyServer({attachment: {name: "selected", allowed_tools: ["get_marker"]}, upstream: backend});
const config = RunnerConfigSchema.parse({runner_id: "child-mcp-acceptance", control_plane_url: "ws://localhost:1",
  workspaces: [{id: "workspace", path: cwd}], provider_instances: [{id: "claude", driver_kind: "claude"}]});
const manager = new HarnessSessionManager(config, {stateStore: new JsonRunnerStateStore(join(cwd, "state.json")), mcpClientFactory: () => ({
  async connect() {await proxy.connect();}, get adapterAttachment() {return proxy.adapterAttachment;},
  async listTools() {return [tool];}, async callTool(...args) {return backend.callTool(...args);},
  async close() {closures++; await proxy.close();}})});
const unsubscribe = manager.subscribeEvents(event => {hcpHarnessEventPayloadSchema.parse(event); events.push(event);});
const descriptor = {name: "selected", transport: "streamable_http", url: "https://example.invalid/local-acceptance-only", headers: {}, allowed_tools: ["get_marker"], lease_id: "local-fixture",
  proof_of_possession: {scheme: "runner_signed_request", key_id: "local-fixture", required_headers: ["x-hcp-session-id", "x-hcp-host-id", "x-hcp-proof-signature", "x-hcp-proof-nonce"]}};
const work = async () => (await manager.conversationOperation(randomUUID(), {session_id: "work", operation: {kind: "work", action: "read"}})).work;
const until = async (predicate, milliseconds = 90000) => {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) {const result = await predicate(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 200));}
  throw new Error("Acceptance deadline exceeded.");
};
const send = async (turn_id, input) => {
  await manager.sendTurn({session_id: "work", turn_id, input});
  assert.equal(events.findLast(event => event.turn_id === turn_id && ["turn.completed", "turn.failed", "turn.cancelled"].includes(event.event_type))?.event_type, "turn.completed");
};
try {
  await manager.startSession({session_id: "work", workspace_id: "workspace", cwd, provider_instance_id: "claude", driver_kind: "claude", execution_profile: "interactive",
    model_selection: {model: process.env.HCP_LIVE_CLAUDE_MODEL ?? "sonnet"}, sandbox_mode: "danger_full_access", approval_policy: "full_access",
    continue_session: false, continuation_group_key: "child-mcp", mcp_servers: [descriptor],
    configuration_inheritance: {user_settings: false, project_settings: false, hooks: false, mcp_servers: false, plugins: false}});
  active = true; stage = "background-launch";
  await send("launch", "Use Agent exactly once with run_in_background: true and this exact child prompt: Call the selected MCP server's get_marker tool exactly once with empty arguments. Use ToolSearch to find mcp__selected__get_marker if necessary. Wait for that tool's result and reply only with its returned marker. Use no other tools or commands. After launching, immediately reply ROOT_RETURNED. Do not wait, poll, call MCP or perform the child's work yourself.");
  const child = (await work()).items.find(item => item.work.origin_turn_id === "launch" && item.work.background && item.work.status === "running")?.work;
  assert.ok(child); await until(() => calls === 1); passed.push("owned-child-outlives-root");
  stage = "followup";
  await send("followup", "Reply READY only. Use no tools and do not wait for any background work.");
  assert.ok((await work()).items.some(item => item.work.work_id === child.work_id && item.work.status === "running"));
  passed.push("root-followup-with-selected-mcp-child");
  release();
  stage = "child-completion";
  const completed = await until(async () => (await work()).items.find(item => item.work.work_id === child.work_id && item.work.status === "completed")?.work);
  assert.equal(calls, 1); passed.push("native-child-selected-tool-invocation", "observed-child-completion");
  stage = "owned-child-transcript";
  const history = (await manager.conversationOperation(randomUUID(), {session_id: "work", operation: {
    kind: "work", action: "history", work_id: child.work_id, expected_revision: completed.revision, limit: 100}})).work;
  assert.equal(history.owner_status, "active"); assert.equal(history.work_id, child.work_id);
  const items = history.history.turns.flatMap(turn => turn.portable_items ?? []);
  const call = items.find(item => item.type === "tool_call" && item.tool_name.endsWith("__get_marker"));
  assert.ok(call);
  assert.ok(items.some(item => item.type === "tool_result" && item.call_id === call.id && item.result.storage === "inline" && JSON.stringify(item.result.value).includes(marker)));
  passed.push("owned-native-child-tool-call-and-result");
  // HTTP MCP transport alone supplies no caller identity. The bound native child
  // transcript is the evidence here; no root/child scope is fabricated on callbacks.
  stage = "unload";
  await manager.stopSession("work", "child-mcp-acceptance-finished"); active = false;
  assert.equal(closures, 1); passed.push("owned-proxy-closed-after-child");
  console.log(JSON.stringify({driver: "claude", cwd, passed}));
} catch (error) {
  process.exitCode = 1;
  console.error(JSON.stringify({driver: "claude", cwd, passed, stage, calls, failed: true,
    code: typeof error?.code === "string" && /^[a-zA-Z0-9_]{1,128}$/.test(error.code) ? error.code : "acceptance_failed"}));
} finally {
  release();
  if (active) try {await manager.stopSession("work", "child-mcp-acceptance-cleanup");} catch {process.exitCode = 1;}
  unsubscribe(); await proxy.close();
}
