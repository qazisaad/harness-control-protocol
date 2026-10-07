import {JsonRunnerStateStore} from "@harness-control/runner/state";
import assert from "node:assert/strict";
import {mkdtemp, mkdir, realpath} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {WebSocketServer} from "ws";
import {HcpHostConnection, projectHcpNativePlanObservations} from "@harness-control/sdk";
import {harnessTurnPlanUpdatedEventDataSchema} from "@harness-control/protocol";
import {RunnerConnection} from "@harness-control/runner/connection";
import {RunnerConfigSchema} from "@harness-control/runner/config";
import {HarnessSessionManager} from "@harness-control/runner/harnesses";

if (process.env.HCP_OPENCODE_PLAN_OBSERVATIONS_LIVE !== "1") throw new Error("Set HCP_OPENCODE_PLAN_OBSERVATIONS_LIVE=1 for isolated native plan-observation acceptance.");
const cwd = await realpath(await mkdtemp(join(tmpdir(), "hcp-opencode-native-plan-observations-")));
for (const name of ["home", "config", "data", "state", "cache"]) await mkdir(join(cwd, name));
const env = {HOME: join(cwd, "home"), USERPROFILE: join(cwd, "home"), XDG_CONFIG_HOME: join(cwd, "config"),
  XDG_DATA_HOME: join(cwd, "data"), XDG_STATE_HOME: join(cwd, "state"), XDG_CACHE_HOME: join(cwd, "cache"),
  OPENCODE_AUTH_CONTENT: "{}", OPENCODE_API_KEY: "", OPENCODE_CONFIG_CONTENT: JSON.stringify({enabled_providers: ["opencode"],
    plugin: [], mcp: {}, instructions: [], autoupdate: false, share: "disabled"}), OPENCODE_DISABLE_PROJECT_CONFIG: "true",
  OPENCODE_PURE: "true", OPENCODE_DISABLE_DEFAULT_PLUGINS: "true", OPENCODE_DISABLE_CLAUDE_CODE: "true",
  OPENCODE_DISABLE_EXTERNAL_SKILLS: "true", OPENCODE_DISABLE_AUTOUPDATE: "true"};
const server = new WebSocketServer({host: "127.0.0.1", port: 0});
await new Promise((resolve, reject) => {server.once("listening", resolve);server.once("error", reject);});
const config = RunnerConfigSchema.parse({runner_id: "native-plan", control_plane_url: `ws://127.0.0.1:${server.address().port}`,
  workspaces: [{id: "workspace", path: cwd}], provider_instances: [{id: "opencode", driver_kind: "opencode", env,
    ...(process.env.HCP_LIVE_OPENCODE_EXECUTABLE ? {executable_path: process.env.HCP_LIVE_OPENCODE_EXECUTABLE} : {})}]});
const manager = new HarnessSessionManager(config, {stateStore: new JsonRunnerStateStore(join(cwd, "native-state.json"))}), events = [];
let peer, runner, ready, failed;
const connected = new Promise((resolve, reject) => {ready = resolve;failed = reject;});
server.on("connection", socket => {
  peer = new HcpHostConnection({send: message => socket.send(JSON.stringify(message))});
  socket.on("close", () => peer.disconnect());
  socket.on("message", raw => {try {
    const result = peer.receive(raw.toString());
    if (result.message.type === "host.hello") peer.accept({protocol_version: "hcp.v0", heartbeat_interval_seconds: 30});
    if (result.message.type === "host.capabilities.updated") ready();
    if (result.message.type === "harness.event" && result.reduction.outcome !== "duplicate") {
      assert.equal(result.reduction.outcome, "applied");events.push(result.message.payload);
    }
  } catch (error) {failed(error);}});
});
try {
  const provider = (await manager.providerDriverStatuses()).find(provider => provider.driver_kind === "opencode");
  assert.equal(provider.execution_capabilities.execution_profiles.find(profile => profile.id === "interactive").native_plan_observations.includes("snapshot"), true);
  const model = process.env.HCP_LIVE_OPENCODE_MODEL ?? "opencode/space-bunny-free";assert.ok(model.startsWith("opencode/"));
  runner = new RunnerConnection({config, runnerVersion: "native-plan", harnessSessions: manager});await runner.connect();await connected;
  await peer.startSession({session_id: "plan", workspace_id: "workspace", cwd, provider_instance_id: "opencode", driver_kind: "opencode",
    execution_profile: "interactive", continuation_group_key: "native-todo-history", configuration_inheritance: {user_settings: false, project_settings: false, hooks: false, mcp_servers: false, plugins: false},
    model_selection: {model}, sandbox_mode: "danger_full_access", approval_policy: "ask",
    approval_options: {permission_rules: [{permission: "*", pattern: "*", action: "deny"},
      {permission: "todowrite", pattern: "*", action: "allow"}, {permission: "task", pattern: "*", action: "deny"}]}, continue_session: false, mcp_servers: []});
  assert.equal(events.some(event => event.event_type === "native.execution.admitted"), false);
  await peer.sendTurn({session_id: "plan", turn_id: "original", mode: "execute",
    input: "Call todowrite exactly once with two toy todos: First toy step with status completed and priority medium, and Second toy step with status pending and priority medium. Then reply DONE. Do not execute either step or use any other tools, files, shell, agents, network or questions."});
  const terminal = await peer.waitForSessionEvent("plan", event => event.turn_id === "original" &&
    ["turn.completed", "turn.failed", "turn.cancelled", "turn.aborted"].includes(event.event_type), {afterSequence: 0, timeoutMs: 60_000});
  assert.equal(terminal.event_type, "turn.completed", terminal.data.error?.code);
  const updates = events.filter(event => event.event_type === "turn.plan.updated").map(event => harnessTurnPlanUpdatedEventDataSchema.parse(event.data));
  assert.ok(updates.length);assert.ok(updates.every(update => update.native_plan?.observation === "snapshot"));
  const projected = projectHcpNativePlanObservations(events, "plan", "original");assert.equal(projected.length, updates.length);
  const resolved = await peer.readNativePlanObservationsComplete("plan", events, "original");assert.equal(resolved.length, projected.length);
  const latest = resolved.at(-1);assert.ok(latest);assert.equal(latest.source.origin_turn_id, "original");
  assert.equal(latest.source.native_plan.observation, "snapshot");assert.equal(latest.source.native_plan.kind, "todo_list");
  assert.equal(latest.source.native_plan.native_item_reference, undefined);
  assert.equal(latest.steps.length, 2);assert.deepEqual(latest.steps.map(step => [step.index, step.status]), [[0, "completed"], [1, "pending"]]);
  assert.equal(latest.source.native_plan.native_execution_reference, undefined);
  assert.ok(events.some(event => event.event_type === "native.execution.admitted" && event.data.native_reference === latest.source.native_plan.native_reference));
  assert.ok(events.some(event => event.event_type === "native.execution.completed" && event.data.native_reference === latest.source.native_plan.native_reference && event.data.status === "completed"));
  assert.ok(events.some(event => event.event_type === "session.configured" && event.data.native_reference === latest.source.native_plan.native_reference));
  assert.equal(events.some(event => ["approval.requested", "user_input.requested", "native.work.updated", "command.started", "file_change.started"].includes(event.event_type)), false);
  const portableEvents = events.filter(event => event.turn_id === "original" && event.event_type === "item.completed" && event.data.portable);
  assert.ok(portableEvents.length, "The actual todo tool omitted portable completion.");
  const tools = await Promise.all(portableEvents.map(event => peer.readPortableItemComplete("plan", event.data.portable)));
  const todo = tools.find(observation => observation.items.some(row => row.item.type === "tool_call" && row.item.tool_name === "todowrite"));
  assert.ok(todo); assert.ok(todo.source.native_call_reference); assert.ok(todo.source.native_item_reference);
  assert.notEqual(todo.source.native_call_reference, todo.source.native_item_reference);
  assert.ok(todo.items.some(row => row.item.type === "tool_result" && row.item.call_id === todo.source.native_call_reference));
  const call = todo.items.find(row => row.item.type === "tool_call");
  assert.equal(call.values.arguments.storage, "inline");
  assert.deepEqual(call.values.arguments.value.todos.map(todo => todo.status), ["completed", "pending"]);
  const textItems = await peer.readTextItemsComplete("plan", events, "original");
  assert.ok(textItems.some(item => typeof item.completed_content === "string" && item.completed_content.includes("DONE")));
  assert.ok(textItems.filter(item => item.completed_content !== undefined).every(item => item.source.message_id && item.source.item_id));
  const history = await peer.readConversationPageComplete("plan");
  const restored = history.turns.flatMap(turn => turn.portable_items ?? []);
  const restoredCall = restored.find(row => row.item.type === "tool_call" && row.item.native_call_reference === todo.source.native_call_reference);
  assert.ok(restoredCall); assert.equal(restoredCall.item.id, call.item.id);
  assert.equal(restoredCall.item.native_item_reference, todo.source.native_item_reference);
  assert.ok(restored.some(row => row.item.type === "tool_result" && row.item.call_id === call.item.id));
  await peer.stopSession({session_id: "plan"});const exited = await peer.waitForSessionEvent("plan", event => event.event_type === "session.exited", {afterSequence: 0});
  assert.equal(exited.event_type, "session.exited");
  console.log(JSON.stringify({driver: "opencode", version: provider.version, cwd, passed: ["declared-native-plan-snapshots", "no-model-startup",
    "actual-native-plan-observation", "actual-native-todo-body", "completed-and-pending-native-status", "no-guessed-native-phase", "no-invented-native-item",
    "original-origin", "sdk-source-semantics", "sdk-complete-steps", "no-observed-external-actions-or-questions", "confirmed-unload", "portable-native-call-result", "actual-call-part-identities", "live-history-call-correlation", "complete-native-text-body"]}));
} finally {if (runner) await runner.close().catch(() => {});for (const socket of server.clients) socket.terminate();await new Promise(resolve => server.close(resolve));}
