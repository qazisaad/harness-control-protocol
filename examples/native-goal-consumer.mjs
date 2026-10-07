import assert from "node:assert/strict";
import {mkdtemp, realpath, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import {WebSocketServer} from "ws";
import {harnessItemEventDataSchema} from "@harness-control/protocol";
import {HcpHostConnection, projectHcpNativePhases} from "@harness-control/sdk";
import {HarnessSessionManager, HarnessAdapterRegistry} from "@harness-control/runner/harnesses";
import {RunnerConfigSchema} from "@harness-control/runner/config";
import {JsonRunnerStateStore} from "@harness-control/runner/state";
import {RunnerConnection} from "@harness-control/runner/connection";
import {ControlHarnessAdapter} from "./conversation-controls.js";

// External providers can implement native jobs without consumer-specific orchestration.
class GoalAdapter extends ControlHarnessAdapter {
  goals = new Map(); mutations = 0;
  constructor() {super(); this.executionProfiles = this.executionProfiles.map(profile => ({...profile, native_goals: true, native_execution_outcomes: true}));}
  async sendTurn(input) {
    if (!input.payload.goal) return super.sendTurn(input);
    const root = input.session.native_thread_id, request = input.payload.goal;
    let goal = this.goals.get(root);
    let admission;
    if (request.action === "start") {
      assert.equal(goal, undefined);
      admission = input.beginNativeGoal(root, request);
      goal = {source: "native", scope: "root", native_reference: root, objective: request.objective,
        native_created_at: 100, native_updated_at: 100, status: "paused", tokens_used: 0, time_used_seconds: 0,
        ...(request.token_budget !== undefined ? {token_budget: request.token_budget} : {})};
    } else {
      assert.equal(goal.native_created_at, request.expected_native_created_at);
      admission = input.beginNativeGoal(root, request, goal);
    }
    const update = patch => {
      goal = {...goal, ...patch}; this.goals.set(root, goal);
      input.confirmNativeGoal({...goal, admission_id: admission, origin_turn_id: input.payload.turn_id});
    };
    update({status: "paused"});
    for (let phase = 0; phase < 2; phase++) {
      const id = input.beginNativeExecution(root, admission, ...(phase ? [true] : []));
      input.confirmNativeExecution(id, `native-${input.payload.turn_id}-${phase}`);
      const nativePart = {message_reference: `native-message-${phase}`, index: 0};
      input.emitEvent?.({event_type: "item.started", turn_id: input.payload.turn_id, data: {item_type: "reasoning", native_part: nativePart, status: "running"}});
      input.emitEvent?.({event_type: "reasoning.delta", turn_id: input.payload.turn_id, data: {delta: `Phase ${phase} thought`,
        stream_kind: "thinking", message_id: `native-message-${phase}`, native_part: {message_reference: `native-message-${phase}`, index: 0}}});
      input.emitEvent?.({event_type: "item.completed", turn_id: input.payload.turn_id, data: {item_type: "reasoning", native_part: nativePart, status: "completed"}});
      update({status: "active", native_updated_at: goal.native_updated_at + 1, tokens_used: goal.tokens_used + 10});
      input.completeNativeExecution(id, "completed", {final_text: `Native phase ${phase} finished`});
    }
    update({status: "complete", native_updated_at: goal.native_updated_at + 1});
    return [{event_type: "turn.completed", turn_id: input.payload.turn_id, data: {final_output: {final_text: "Native goal finished"}}}];
  }
  async controlNativeGoal(input) {
    input.signal.throwIfAborted();
    const root = input.nativeThreadId, goal = this.goals.get(root) ?? null;
    if (input.operation.action === "read") return {action: "read", source: "native", native_reference: root, goal};
    assert.equal(input.inspectionOnly, false); assert.equal(goal.native_created_at, input.operation.expected_native_created_at);
    input.beginMutation(); this.mutations++;
    const actual = input.operation.action === "clear" ? null : {...goal, status: "paused", native_updated_at: goal.native_updated_at + 1};
    if (actual) this.goals.set(root, actual); else this.goals.delete(root);
    return {action: input.operation.action, source: "native", native_reference: root, target_native_created_at: goal.native_created_at, goal: actual};
  }
}
const cwd = await realpath(await mkdtemp(join(tmpdir(), "hcp-public-goal-")));
const server = new WebSocketServer({host: "127.0.0.1", port: 0});
await new Promise(resolve => server.once("listening", resolve));
let peer, ready = false, failure, runner;
const events = [];
server.on("connection", socket => {
  ready = false; peer = new HcpHostConnection({send: message => socket.send(JSON.stringify(message))});
  socket.on("message", raw => {try {
    const observed = peer.receive(raw.toString());
    if (observed.message.type === "host.hello") peer.accept({protocol_version: "hcp.v0", heartbeat_interval_seconds: 30});
    if (observed.message.type === "host.capabilities.updated") ready = true;
    if (observed.message.type === "harness.event") events.push(observed.message.payload);
  } catch (error) {failure = error; socket.close();}});
  socket.on("close", () => peer.disconnect());
});
async function until(predicate) {
  const deadline = Date.now() + 15000;
  while (!predicate()) {if (failure) throw failure; if (Date.now() > deadline) throw new Error("Public goal consumer timed out"); await delay(10);}
}
const adapter = new GoalAdapter();
const config = RunnerConfigSchema.parse({runner_id: "generic-goal", control_plane_url: `ws://127.0.0.1:${server.address().port}`,
  workspaces: [{id: "workspace", path: cwd}], provider_instances: [{id: "provider", driver_kind: adapter.driverKind}]});
const path = join(cwd, "state.json");
const connect = async () => {
  const manager = new HarnessSessionManager(config, {stateStore: new JsonRunnerStateStore(path), adapterRegistry: new HarnessAdapterRegistry([adapter])});
  ready = false; runner = new RunnerConnection({config, runnerVersion: "fixture", harnessSessions: manager});
  await runner.connect(); await until(() => ready); return manager;
};
try {
  const manager = await connect();
  await peer.startSession({session_id: "source", continuation_group_key: "goal-key", workspace_id: "workspace", cwd,
    provider_instance_id: "provider", driver_kind: adapter.driverKind, model_selection: {model: "fixture"},
    approval_policy: "full_access", sandbox_mode: "read_only", execution_profile: "interactive", continue_session: false, mcp_servers: []});
  adapter.observations.get("source")({event_type: "native.goal.observed", data: {source: "native_transcript", scope: "session",
    native_reference: "native-source", native_message_reference: "native-command", kind: "command", goal: null}});
  await until(() => events.some(event => event.event_type === "native.goal.observed"));
  const observation = events.find(event => event.event_type === "native.goal.observed");
  assert.equal(observation.turn_id, undefined); assert.equal(observation.data.goal, null);
  const finished = peer.waitForSessionEvent("source", event => event.turn_id === "original" && event.event_type === "turn.completed");
  void finished.catch(() => {});
  await peer.startNativeGoal("source", "original", {objective: "Generic explicit objective"});
  assert.equal((await finished).turn_id, "original");
  const admitted = events.find(event => event.event_type === "native.goal.updated").data;
  assert.equal(admitted.token_budget, undefined);
  const phases = events.filter(event => event.event_type === "native.execution.admitted");
  assert.equal(phases.length, 2); assert.ok(phases.every(event => event.turn_id === "original" && event.data.goal_admission_id === admitted.admission_id));
  const outcomes = events.filter(event => event.event_type === "native.execution.completed");
  assert.equal(outcomes.length, 2); assert.ok(outcomes.every(event => event.data.status === "completed" && phases.some(phase =>
    phase.data.admission_id === event.data.admission_id && phase.data.native_execution_reference === event.data.native_execution_reference)));
  const projected = projectHcpNativePhases(peer.events.events(), "source", "original");
  assert.equal(projected.length, 2);assert.ok(projected.every(phase => phase.status === "completed" && phase.origin_turn_id === "original"
    && phase.goal_admission_id === admitted.admission_id && phase.admitted_at && phase.completed_at));
  const parts = events.filter(event => event.event_type === "reasoning.delta");
  assert.equal(parts.length, 2); assert.ok(parts.every(event => event.turn_id === "original"));
  assert.deepEqual(parts.map(event => event.data.native_part.message_reference), ["native-message-0", "native-message-1"]);
  assert.ok(parts.every(event => event.data.native_part.index === 0 && !event.data.item_id));
  const lifecycle = events.filter(event => ["item.started", "item.completed"].includes(event.event_type));
  assert.deepEqual(lifecycle.map(event => event.event_type), ["item.started", "item.completed", "item.started", "item.completed"]);
  assert.ok(lifecycle.every(event => {const data = harnessItemEventDataSchema.parse(event.data);
    return data.native_part.index === 0 && !data.item_id;}));
  const read = (await peer.readNativeGoal("source")).payload.goal;
  assert.equal(read.goal.status, "complete");
  const generation = read.goal.native_created_at;
  await peer.pauseNativeGoal("source", generation);
  await peer.resumeNativeGoal("source", "resumed", generation);
  await until(() => events.some(event => event.turn_id === "resumed" && event.event_type === "turn.completed"));
  const jobs = manager.stateStore().nativeWorkState("source").goals;
  assert.equal(jobs.length, 2); assert.notEqual(jobs[0].admission_id, jobs[1].admission_id);
  assert.equal(jobs[1].snapshot.native_created_at, generation); assert.equal(jobs[1].origin_turn_id, "resumed");
  const cleared = await peer.clearNativeGoal("source", generation, {id: "clear-native-goal"});
  assert.equal(cleared.payload.goal.goal, null); assert.equal(adapter.mutations, 2);
  await peer.stopSession({session_id: "source"}); await runner.close(); await connect();
  assert.deepEqual((await peer.clearNativeGoal("source", generation, {id: "clear-native-goal"})).payload, cleared.payload);
  assert.equal(adapter.mutations, 2); assert.equal((await peer.readNativeGoal("source")).payload.goal.goal, null);
  console.log("Packed public SDK native goal admission, autonomous phases, generation-bound controls/resume and durable replay passed");
} finally {
  await runner?.close(); for (const socket of server.clients) socket.terminate();
  await new Promise(resolve => server.close(resolve)); await rm(cwd, {recursive: true, force: true});
}
