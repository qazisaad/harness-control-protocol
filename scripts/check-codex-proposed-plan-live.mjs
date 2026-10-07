import assert from "node:assert/strict";
import {mkdtemp, realpath} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {WebSocketServer} from "ws";
import {HcpHostConnection, projectHcpProposedPlans} from "@harness-control/sdk";
import {harnessProposedPlanDeltaSchema, harnessProposedPlanCompletedSchema} from "@harness-control/protocol";
import {RunnerConnection} from "@harness-control/runner/connection";
import {RunnerConfigSchema} from "@harness-control/runner/config";
import {HarnessSessionManager} from "@harness-control/runner/harnesses";

if (process.env.HCP_CODEX_PROPOSED_PLAN_LIVE !== "1") throw new Error("Set HCP_CODEX_PROPOSED_PLAN_LIVE=1 for isolated native proposed-plan acceptance.");
const cwd = await realpath(await mkdtemp(join(tmpdir(), "hcp-native-proposed-plan-")));
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
  assert.equal(provider.execution_capabilities.execution_profiles.find(profile => profile.id === "interactive").native_plan_proposals, true);
  const model = process.env.HCP_LIVE_CODEX_MODEL ?? provider.models.find(model => model.is_default)?.id;assert.ok(model);
  runner = new RunnerConnection({config, runnerVersion: "native-plan", harnessSessions: manager});await runner.connect();await connected;
  await peer.startSession({session_id: "plan", workspace_id: "workspace", cwd, provider_instance_id: "codex", driver_kind: "codex",
    execution_profile: "interactive", model_selection: {model}, sandbox_mode: "read_only", approval_policy: "ask", continue_session: false, mcp_servers: []});
  assert.equal(events.some(event => event.event_type === "native.execution.admitted"), false);
  await peer.sendTurn({session_id: "plan", turn_id: "original", mode: "plan",
    input: "Produce a proposed implementation plan for an imaginary pure function that adds two integers. Make it self-contained with three short steps and assumptions, suitable for implementation later. Use no tools, files, shell, agents, network or questions. Finish with a proposed plan."});
  const terminal = await peer.waitForSessionEvent("plan", event => event.turn_id === "original" &&
    ["turn.completed", "turn.failed", "turn.cancelled", "turn.aborted"].includes(event.event_type), {afterSequence: 0, timeoutMs: 60_000});
  assert.equal(terminal.event_type, "turn.completed", terminal.data.error?.code);
  const deltas = events.filter(event => event.event_type === "turn.proposed.delta").map(event => harnessProposedPlanDeltaSchema.parse(event.data));
  const completions = events.filter(event => event.event_type === "turn.proposed.completed").map(event => harnessProposedPlanCompletedSchema.parse(event.data));
  assert.ok(deltas.length);assert.ok(completions.length);
  const plans = projectHcpProposedPlans(events, "plan", "original");assert.equal(plans.length, 1);
  const resolved = await peer.readProposedPlansComplete("plan", events, "original");assert.equal(resolved.length, 1);
  assert.equal(resolved[0].completed_plan, plans[0].completed);assert.deepEqual(resolved[0].source, plans[0]);
  const plan = plans[0];assert.equal(plan.status, "completed");assert.equal(typeof plan.completed, "string");assert.ok(plan.completed.length);
  assert.equal(plan.completed, completions[0].plan);assert.equal(plan.item_id, deltas[0].item_id);
  assert.equal(plan.native_execution_reference, completions[0].native_execution_reference);
  assert.ok(events.some(event => event.event_type === "native.execution.completed" && event.data.native_execution_reference === plan.native_execution_reference && event.data.status === "completed"));
  assert.ok(events.some(event => event.event_type === "item.completed" && event.data.item_id === plan.item_id && event.data.item_type === "plan"));
  assert.equal(events.some(event => ["approval.requested", "user_input.requested", "native.work.updated"].includes(event.event_type)), false);
  await peer.stopSession({session_id: "plan"});const exited = await peer.waitForSessionEvent("plan", event => event.event_type === "session.exited", {afterSequence: 0});
  assert.equal(exited.event_type, "session.exited");
  console.log(JSON.stringify({driver: "codex", version: provider.version, cwd, passed: ["declared-native-plan-proposals", "no-model-startup",
    "native-plan-deltas", "native-plan-completion", "actual-native-plan-item", "exact-native-phase", "original-origin",
    "sdk-preview-and-authoritative-content", "sdk-complete-plan-body", "no-tools-or-questions", "confirmed-unload"]}));
} finally {if (runner) await runner.close().catch(() => {});for (const socket of server.clients) socket.terminate();await new Promise(resolve => server.close(resolve));}
