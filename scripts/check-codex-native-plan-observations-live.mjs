import assert from "node:assert/strict";
import {mkdtemp, realpath} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {WebSocketServer} from "ws";
import {HcpHostConnection, projectHcpNativePlanObservations} from "@harness-control/sdk";
import {harnessTurnPlanUpdatedEventDataSchema} from "@harness-control/protocol";
import {RunnerConnection} from "@harness-control/runner/connection";
import {RunnerConfigSchema} from "@harness-control/runner/config";
import {HarnessSessionManager} from "@harness-control/runner/harnesses";

if (process.env.HCP_CODEX_PLAN_OBSERVATIONS_LIVE !== "1") throw new Error("Set HCP_CODEX_PLAN_OBSERVATIONS_LIVE=1 for isolated native plan-observation acceptance.");
const cwd = await realpath(await mkdtemp(join(tmpdir(), "hcp-native-plan-observations-")));
const server = new WebSocketServer({host: "127.0.0.1", port: 0});
await new Promise((resolve, reject) => {server.once("listening", resolve);server.once("error", reject);});
const config = RunnerConfigSchema.parse({runner_id: "native-plan", control_plane_url: `ws://127.0.0.1:${server.address().port}`,
  workspaces: [{id: "workspace", path: cwd}], provider_instances: [{id: "codex", driver_kind: "codex"}]});
const manager = new HarnessSessionManager(config), events = [];
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
  const provider = (await manager.providerDriverStatuses()).find(provider => provider.driver_kind === "codex");
  assert.equal(provider.execution_capabilities.execution_profiles.find(profile => profile.id === "interactive").native_plan_observations.includes("snapshot"), true);
  const model = process.env.HCP_LIVE_CODEX_MODEL ?? provider.models.find(model => model.is_default)?.id;assert.ok(model);
  runner = new RunnerConnection({config, runnerVersion: "native-plan", harnessSessions: manager});await runner.connect();await connected;
  await peer.startSession({session_id: "plan", workspace_id: "workspace", cwd, provider_instance_id: "codex", driver_kind: "codex",
    execution_profile: "interactive", model_selection: {model}, sandbox_mode: "read_only", approval_policy: "ask", continue_session: false, mcp_servers: []});
  assert.equal(events.some(event => event.event_type === "native.execution.admitted"), false);
  await peer.sendTurn({session_id: "plan", turn_id: "original", mode: "execute",
    input: "Call update_plan exactly once with explanation HCP_EXPLANATION and two toy steps: First toy step with status completed, and Second toy step with status pending. Then reply DONE. Do not execute either step or use any other tools, files, shell, agents, network or questions."});
  const terminal = await peer.waitForSessionEvent("plan", event => event.turn_id === "original" &&
    ["turn.completed", "turn.failed", "turn.cancelled", "turn.aborted"].includes(event.event_type), {afterSequence: 0, timeoutMs: 60_000});
  assert.equal(terminal.event_type, "turn.completed", terminal.data.error?.code);
  const updates = events.filter(event => event.event_type === "turn.plan.updated").map(event => harnessTurnPlanUpdatedEventDataSchema.parse(event.data));
  assert.ok(updates.length);assert.ok(updates.every(update => update.native_plan?.observation === "snapshot"));
  const projected = projectHcpNativePlanObservations(events, "plan", "original");assert.equal(projected.length, updates.length);
  const resolved = await peer.readNativePlanObservationsComplete("plan", events, "original");assert.equal(resolved.length, projected.length);
  const latest = resolved.at(-1);assert.ok(latest);assert.equal(latest.source.origin_turn_id, "original");
  assert.equal(latest.source.native_plan.observation, "snapshot");assert.equal(latest.source.native_plan.kind, "execution_plan");
  assert.equal(latest.source.native_plan.native_item_reference, undefined);
  assert.equal(latest.explanation, "HCP_EXPLANATION");assert.equal(latest.source.native_plan.explanation, "HCP_EXPLANATION");
  assert.equal(latest.steps.length, 2);assert.deepEqual(latest.steps.map(step => [step.index, step.status]), [[0, "completed"], [1, "pending"]]);
  assert.ok(events.some(event => event.event_type === "native.execution.admitted" && event.data.native_execution_reference === latest.source.native_plan.native_execution_reference));
  assert.ok(events.some(event => event.event_type === "native.execution.completed" && event.data.native_execution_reference === latest.source.native_plan.native_execution_reference && event.data.status === "completed"));
  assert.ok(events.some(event => event.event_type === "session.configured" && event.data.native_reference === latest.source.native_plan.native_reference));
  assert.equal(events.some(event => ["approval.requested", "user_input.requested", "native.work.updated", "command.started", "file_change.started"].includes(event.event_type)), false);
  await peer.stopSession({session_id: "plan"});const exited = await peer.waitForSessionEvent("plan", event => event.event_type === "session.exited", {afterSequence: 0});
  assert.equal(exited.event_type, "session.exited");
  console.log(JSON.stringify({driver: "codex", version: provider.version, cwd, passed: ["declared-native-plan-snapshots", "no-model-startup",
    "actual-native-plan-observation", "actual-native-plan-body", "completed-and-pending-native-status", "exact-native-phase", "no-invented-native-item",
    "original-origin", "sdk-source-semantics", "sdk-complete-steps", "exact-native-explanation", "no-observed-external-actions-or-questions", "confirmed-unload"]}));
} finally {if (runner) await runner.close().catch(() => {});for (const socket of server.clients) socket.terminate();await new Promise(resolve => server.close(resolve));}
