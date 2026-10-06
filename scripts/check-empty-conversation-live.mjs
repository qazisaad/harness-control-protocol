import assert from "node:assert/strict";
import {mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {HarnessSessionManager} from "@harness-control/runner/harnesses";
import {RunnerConfigSchema} from "@harness-control/runner/config";
import {JsonRunnerStateStore} from "@harness-control/runner/state";

// Native account access is explicit. This check never requests a model turn.
if (process.env.HCP_NATIVE_LIVE !== "1") throw new Error("Set HCP_NATIVE_LIVE=1 for native acceptance.");
const driver = process.env.HCP_LIVE_PROVIDER ?? "opencode";
assert.equal(driver, "opencode", "Only OpenCode currently advertises empty native conversations.");
const cwd = await mkdtemp(join(tmpdir(), "hcp-live-empty-conversation-"));
const path = join(cwd, "state.json");
const config = RunnerConfigSchema.parse({runner_id: "empty-acceptance", control_plane_url: "ws://localhost:1",
  workspaces: [{id: "workspace", path: cwd}], provider_instances: [{id: driver, driver_kind: driver}]});
let manager = new HarnessSessionManager(config, {stateStore: new JsonRunnerStateStore(path)});
const start = {session_id: "empty", workspace_id: "workspace", provider_instance_id: driver, driver_kind: driver,
  cwd, sandbox_mode: "danger_full_access", approval_policy: "ask", continue_session: false,
  continuation_group_key: "empty-conversation", execution_profile: "interactive",
  model_selection: {model: process.env.HCP_LIVE_OPENCODE_MODEL ?? "opencode-go/glm-5.3-flash"}, mcp_servers: [],
  configuration_inheritance: {user_settings: false, project_settings: false, hooks: false, mcp_servers: false, plugins: false}};
const passed = [];
try {
  const status = (await manager.providerDriverStatuses()).find(value => value.driver_kind === driver);
  assert.equal(status?.execution_capabilities?.empty_conversation, true);
  const events = await manager.startSession(start);
  assert.equal(events.some(event => event.event_type.startsWith("turn.")), false);
  const native = new JsonRunnerStateStore(path).getNativeConversation(start.continuation_group_key)?.native_thread_id;
  assert.ok(native);
  const read = await manager.conversationOperation("empty-live", {session_id: "empty", operation: {kind: "read"}});
  assert.equal(read.history?.turn_count, 0);
  assert.deepEqual(read.history.turns, []);
  passed.push("native-empty-start", "durable-binding", "live-empty-history");
  await manager.stopSession("empty", "restart");
  manager = new HarnessSessionManager(config, {stateStore: new JsonRunnerStateStore(path)});
  const offline = await manager.conversationOperation("empty-offline", {session_id: "empty", operation: {kind: "read"}});
  assert.equal(offline.history?.turn_count, 0);
  passed.push("empty-history-after-restart");
  await manager.startSession({...start, session_id: "reopened", continue_session: true});
  assert.equal(new JsonRunnerStateStore(path).getNativeConversation(start.continuation_group_key)?.native_thread_id, native);
  const resumed = await manager.conversationOperation("empty-reopened", {session_id: "reopened", operation: {kind: "read"}});
  assert.equal(resumed.history?.turn_count, 0);
  passed.push("same-empty-conversation-resumed", "zero-model-turns");
} finally {
  for (const id of ["empty", "reopened"]) {
    try {await manager.stopSession(id, "cleanup");}
    catch (error) {if (error?.code !== "session_not_found") throw error;}
  }
}
console.log(JSON.stringify({driver, passed, cwd}));
