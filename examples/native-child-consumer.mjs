import assert from "node:assert/strict";
import {mkdtemp, realpath, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import {WebSocketServer} from "ws";
import {HcpHostConnection} from "@harness-control/sdk";
import {HarnessSessionManager, HarnessAdapterRegistry} from "@harness-control/runner/harnesses";
import {RunnerConfigSchema} from "@harness-control/runner/config";
import {JsonRunnerStateStore} from "@harness-control/runner/state";
import {RunnerConnection} from "@harness-control/runner/connection";
import {ControlHarnessAdapter} from "./conversation-controls.js";

// An extensible non-bundled provider verifies that custody contracts aren't hard-coded to T3 or Codex.
class ChildAdapter extends ControlHarnessAdapter {
  inspections = 0;
  forks = 0;
  constructor() {
    super();
    this.executionProfiles = this.executionProfiles.map(profile => ({...profile,
      retained_native_work_history: true, native_work_fork: true, native_work_terminal_reconciliation: true}));
  }
  admit(session, root, origin, id, status) {
    this.observations.get(session)({event_type: "native.work.updated", data: {work: {
      work_id: id, native_reference: `native-${id}`, origin_turn_id: origin, kind: "agent",
      background: true, status, supports_cancel: false}}, nativeWorkCustody: {
      source: this.driverKind, work_id: id, native_reference: `native-${id}`, origin_turn_id: origin,
      root_native_reference: root, parent_native_reference: root, launch_native_reference: `launch-${id}`,
      native_execution_reference: `execution-${id}`}});
  }
  async readRetainedNativeWorkHistory(input) {
    this.inspections++; input.signal.throwIfAborted();
    assert.equal(input.custody.source, this.driverKind);
    return {history_hash: "a".repeat(64), turn_count: 1, truncated: false,
      turns: [{id: "child-turn", status: "completed", items: [{type: "text", text: "Retained generic child"}]}]};
  }
  async forkNativeWork(input) {
    assert.equal(input.operation.expected_history_hash, "a".repeat(64));
    input.beginMutation(); this.forks++;
    this.histories.set("independent-child-fork", [{id: "child-turn", status: "completed", items: [{type: "text", text: "Retained generic child"}]}]);
    return {native_reference: "independent-child-fork"};
  }
  async reconcileNativeWork(input) {
    input.signal.throwIfAborted(); assert.equal(input.custody.native_execution_reference, "execution-lost");
    return {status: "completed"};
  }
}
const cwd = await realpath(await mkdtemp(join(tmpdir(), "hcp-public-child-")));
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
  while (!predicate()) {if (failure) throw failure; if (Date.now() > deadline) throw new Error("Public child consumer timed out"); await delay(10);}
}
const adapter = new ChildAdapter();
const config = RunnerConfigSchema.parse({runner_id: "generic-child", control_plane_url: `ws://127.0.0.1:${server.address().port}`,
  workspaces: [{id: "workspace", path: cwd}], provider_instances: [{id: "provider", driver_kind: adapter.driverKind}]});
const statePath = join(cwd, "state.json");
const connect = async () => {
  const sessions = new HarnessSessionManager(config, {stateStore: new JsonRunnerStateStore(statePath), adapterRegistry: new HarnessAdapterRegistry([adapter])});
  ready = false;
  runner = new RunnerConnection({config, runnerVersion: "fixture", harnessSessions: sessions});
  await runner.connect(); await until(() => ready); return sessions;
};
try {
  const sessions = await connect();
  const start = {session_id: "source", continuation_group_key: "source-key", workspace_id: "workspace", cwd,
    provider_instance_id: "provider", driver_kind: adapter.driverKind, model_selection: {model: "fixture"},
    approval_policy: "full_access", sandbox_mode: "read_only", execution_profile: "interactive", continue_session: false, mcp_servers: []};
  await peer.startSession(start);
  await peer.sendTurn({session_id: "source", turn_id: "origin", input: "Launch owned generic work"});
  await until(() => events.some(event => event.turn_id === "origin" && event.event_type === "turn.completed"));
  const root = sessions.stateStore().getNativeConversation("source-key").native_thread_id;
  const admission = events.find(event => event.turn_id === "origin" && event.event_type === "native.execution.admitted");
  assert.equal(admission.data.native_reference, root);
  assert.equal(sessions.stateStore().nativeWorkState("source").root_executions[0].native_execution_reference,
    admission.data.native_execution_reference);
  adapter.admit("source", root, "origin", "child", "completed");
  adapter.admit("source", root, "origin", "lost", "running");
  const inventory = (await peer.readNativeWork("source")).payload.work;
  const child = inventory.items.find(item => item.work.work_id === "child").work;
  const completeInventory = await peer.readNativeWorkInventory("source", {pageSize: 1});
  assert.equal(completeInventory.items.length, 2);assert.equal(completeInventory.total_count, 2);
  assert.ok(completeInventory.items.every(item => item.work.origin_turn_id === "origin"));
  const history = (await peer.readRetainedNativeWorkHistory("source", "child", child.revision)).payload.work;
  assert.equal(history.owner_status, "retained");
  const fork = {work_id: "child", expected_revision: child.revision, expected_history_hash: history.history.history_hash,
    target_session_id: "destination", continuation_group_key: "destination-key"};
  const forked = await peer.forkNativeWork("source", fork, {id: "child-fork-command"});
  assert.equal(forked.payload.work.fork.native_reference, "independent-child-fork");
  adapter.loseWorkOwner("source");
  const lost = (await peer.readNativeWork("source")).payload.work.items.find(item => item.work.work_id === "lost").work;
  const reconciled = await peer.reconcileNativeWork("source", "lost", lost.revision, {id: "reconcile-command"});
  assert.equal(reconciled.payload.work.session_closure, "unconfirmed");
  assert.equal((await peer.readNativeWork("source")).payload.work.closure_unconfirmed, true);
  assert.ok(events.every(event => !JSON.stringify(event).includes("launch-child")));
  await assert.rejects(runner.close(), /closure is unconfirmed/);
  await connect();
  assert.deepEqual((await peer.forkNativeWork("source", fork, {id: "child-fork-command"})).payload, forked.payload);
  assert.deepEqual((await peer.reconcileNativeWork("source", "lost", lost.revision, {id: "reconcile-command"})).payload, reconciled.payload);
  assert.equal(adapter.forks, 1);
  const retained = (await peer.readRetainedNativeWorkHistory("source", "child", child.revision)).payload.work;
  assert.equal(retained.owner_status, "retained");
  const resolved = await peer.readNativeWorkHistoryPageComplete("source", "child", child.revision, {}, {owner: "retained"});
  assert.equal(resolved.work.owner_status, "retained");assert.equal(resolved.work.revision, child.revision);
  assert.equal(resolved.history.source.history_hash, retained.history.history_hash);
  assert.deepEqual(resolved.history.turns[0].native_items, [{type: "text", text: "Retained generic child"}]);
  assert.equal((await peer.readNativeWorkInventory("source", {pageSize: 1})).closure_unconfirmed, true);
  await assert.rejects(peer.readNativeWorkHistory("source", "child", child.revision), /live/);
  await peer.startSession({...start, session_id: "destination", continuation_group_key: "destination-key", continue_session: true});
  await peer.sendTurn({session_id: "destination", turn_id: "continued", input: "Continue fork"});
  await until(() => events.some(event => event.turn_id === "continued" && event.event_type === "turn.completed"));
  await peer.stopSession({session_id: "destination"});
  console.log("Packed public SDK generic custody, retained reads, child forks, lost-child reconciliation, durable replay and fork continuation passed");
} finally {
  await runner?.close(); for (const socket of server.clients) socket.terminate();
  await new Promise(resolve => server.close(resolve)); await rm(cwd, {recursive: true, force: true});
}
