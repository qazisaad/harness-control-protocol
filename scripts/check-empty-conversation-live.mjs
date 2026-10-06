import assert from "node:assert/strict";
import {mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {HarnessSessionManager} from "@harness-control/runner/harnesses";
import {RunnerConfigSchema} from "@harness-control/runner/config";
import {JsonRunnerStateStore} from "@harness-control/runner/state";

// Native account access is explicit. Optional injection recall sends one model turn.
if (process.env.HCP_NATIVE_LIVE !== "1") throw new Error("Set HCP_NATIVE_LIVE=1 for native acceptance.");
const driver = process.env.HCP_LIVE_PROVIDER ?? "opencode";
assert.ok(["codex", "opencode"].includes(driver), "This check supports Codex and OpenCode.");
const cwd = await mkdtemp(join(tmpdir(), "hcp-live-empty-conversation-"));
const path = join(cwd, "state.json");
const config = RunnerConfigSchema.parse({runner_id: "empty-acceptance", control_plane_url: "ws://localhost:1",
  workspaces: [{id: "workspace", path: cwd}], provider_instances: [{id: driver, driver_kind: driver}]});
let manager = new HarnessSessionManager(config, {stateStore: new JsonRunnerStateStore(path)});
const start = {session_id: "empty", workspace_id: "workspace", provider_instance_id: driver, driver_kind: driver,
  cwd, sandbox_mode: "danger_full_access", approval_policy: "ask", continue_session: false,
  continuation_group_key: "empty-conversation", execution_profile: "interactive",
  model_selection: {model: process.env.HCP_LIVE_OPENCODE_MODEL ?? "opencode-go/glm-5.3-flash"}, mcp_servers: [],
  configuration_inheritance: driver === "opencode" ? {user_settings: false, project_settings: false, hooks: false, mcp_servers: false, plugins: false}
    : {mcp_servers: false, plugins: false}};
const passed = [];
const inject = process.env.HCP_LIVE_INJECT === "1";
try {
  const status = (await manager.providerDriverStatuses()).find(value => value.driver_kind === driver);
  assert.ok(status?.execution_capabilities?.empty_conversation ||
    status?.execution_capabilities?.execution_profiles?.find(profile => profile.id === "interactive")?.empty_conversation);
  if (driver === "codex") {
    start.model_selection.model = status.models.find(model => model.is_default)?.id ?? status.models[0]?.id;
    assert.ok(start.model_selection.model);
  }
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
  if (inject) {
    assert.equal(driver, "codex", "Only Codex advertises native history injection.");
    await manager.stopSession("reopened", "inject-initial-context");
    const marker = randomUUID();
    const request = {session_id: "reopened", operation: {kind: "inject", expected_history_hash: resumed.history.history_hash,
      messages: [{role: "user", content: `Historical handoff marker: ${marker}.`}, {role: "assistant", content: `I retained ${marker}.`}]}};
    const receipt = await manager.conversationOperation("initial-context", request);
    assert.equal(receipt.injection?.outcome, "applied");
    manager = new HarnessSessionManager(config, {stateStore: new JsonRunnerStateStore(path)});
    assert.deepEqual(await manager.conversationOperation("initial-context", request), receipt);
    passed.push("initial-context-injection", "restart-injection-receipt");
    await manager.startSession({...start, session_id: "first-prompt", continue_session: true});
    const events = await manager.sendTurn({session_id: "first-prompt", turn_id: "first", input:
      "What was the historical handoff marker? Reply with the marker only. Do not use tools."});
    const terminal = events.findLast(event => ["turn.completed", "turn.failed", "turn.cancelled"].includes(event.event_type));
    assert.equal(terminal?.event_type, "turn.completed");
    assert.ok(JSON.stringify(terminal.data).includes(marker));
    passed.push("initial-context-first-prompt-recall");
  }
} catch (error) {
  console.error(JSON.stringify({driver, passed, cwd, error_code: error?.code}));
  throw error;
} finally {
  for (const id of ["empty", "reopened", "first-prompt"]) {
    try {await manager.stopSession(id, "cleanup");}
    catch (error) {if (error?.code !== "session_not_found") throw error;}
  }
}
console.log(JSON.stringify({driver, passed, cwd}));
