import assert from "node:assert/strict";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import {WebSocketServer} from "ws";
import {HcpHostConnection} from "@harness-control/sdk";
import {RunnerConnection} from "@harness-control/runner/connection";
import {RunnerConfigSchema} from "@harness-control/runner/config";
import {HarnessSessionManager, HarnessAdapterRegistry} from "@harness-control/runner/harnesses";
import {ControlHarnessAdapter} from "./conversation-controls.js";

const cwd = await mkdtemp(join(tmpdir(), "hcp-controls-consumer-"));
const server = new WebSocketServer({host: "127.0.0.1", port: 0});
await new Promise(resolve => server.once("listening", resolve));
let peer, runner, failure;
let ready = false;
const events = [];
server.on("connection", socket => {
  peer = new HcpHostConnection({send: message => socket.send(JSON.stringify(message))});
  socket.on("message", raw => {
    try {
      const observation = peer.receive(raw.toString());
      if (observation.message.type === "host.hello") peer.accept({protocol_version: "hcp.v0", heartbeat_interval_seconds: 30});
      if (observation.message.type === "host.capabilities.updated") ready = true;
      if (observation.message.type === "harness.event") {
        assert.ok(["applied", "duplicate"].includes(observation.reduction.outcome)); events.push(observation.message.payload);
      }
    } catch (error) {failure = error; socket.close();}
  });
  socket.on("close", () => peer.disconnect());
});
async function until(predicate) {
  const deadline = Date.now() + 15_000;
  while (!predicate()) {if (failure) throw failure; if (Date.now() > deadline) throw new Error("Control fixture timed out"); await delay(10);}
}
try {
  const config = RunnerConfigSchema.parse({runner_id: "controls-consumer", control_plane_url: `ws://127.0.0.1:${server.address().port}`,
    workspaces: [{id: "workspace", path: cwd}], provider_instances: [{id: "provider", driver_kind: "example.controls"}]});
  const adapter = new ControlHarnessAdapter();
  const sessions = new HarnessSessionManager(config, {adapterRegistry: new HarnessAdapterRegistry([adapter])});
  runner = new RunnerConnection({config, runnerVersion: "fixture", harnessSessions: sessions});
  await runner.connect(); await until(() => ready);
  const start = {session_id: "session", workspace_id: "workspace", cwd, provider_instance_id: "provider", driver_kind: "example.controls",
    model_selection: {model: "fixture"}, approval_policy: "full_access", sandbox_mode: "read_only", continue_session: false,
    continuation_group_key: "conversation", mcp_servers: [],
    instructions: {system: "Application instructions"},
    configuration_inheritance: {user_settings: false, project_settings: false, hooks: false, mcp_servers: false, plugins: false}};
  await peer.startSession(start);
  await peer.sendTurn({session_id: "session", turn_id: "turn", input: "wait-for-steering"});
  await until(() => events.some(event => event.event_type === "content.delta"));
  assert.deepEqual(adapter.instructionsSeen, start.instructions);
  assert.deepEqual(events.find(event => event.event_type === "session.configured").data.configuration_inheritance, start.configuration_inheritance);
  const steered = await peer.steerTurn("session", "turn", "steered"); assert.equal(steered.payload.turn_id, "turn");
  await until(() => events.some(event => event.turn_id === "turn" && event.event_type === "turn.completed"));
  adapter.emitObservation("session", "between-turns");
  await until(() => events.some(event => event.event_type === "extension.example.observation" && event.data.fields.phase === "between-turns"));
  assert.equal(events.filter(event => event.turn_id === "turn" && event.event_type === "turn.completed").length, 1);
  adapter.emitWork("session", "turn", "running");
  await until(() => events.some(event => event.event_type === "native.work.updated"));
  const children = await peer.readNativeWork("session");
  assert.equal(children.payload.work.items[0].owner_status, "active");
  const child = children.payload.work.items[0].work;
  const cancelled = await peer.cancelNativeWork("session", child.work_id, child.revision, {id: "cancel-child"});
  const cancelledAgain = await peer.cancelNativeWork("session", child.work_id, child.revision, {id: "cancel-child"});
  assert.deepEqual(cancelled.payload, cancelledAgain.payload);
  assert.equal(adapter.nativeCancellations, 1);
  const settledChild = (await peer.readNativeWork("session")).payload.work.items[0].work;
  assert.equal(settledChild.status, "cancelled");
  await peer.retireNativeWork("session", child.work_id, settledChild.revision);
  const reference = events.find(event => event.event_type === "turn.completed").data.final_output.content_ref;
  const chunks = []; let offset = 0;
  while (true) {
    const result = await peer.readContent("session", reference.content_id, offset);
    const chunk = result.payload.content; chunks.push(Buffer.from(chunk.data_base64, "base64"));
    if (chunk.next_offset === undefined) break; offset = chunk.next_offset;
  }
  assert.equal(Buffer.concat(chunks).toString("utf8"), "steered".repeat(30_000));
  await peer.compactConversation("session", "compact");
  await until(() => events.some(event => event.turn_id === "compact" && event.event_type === "turn.completed"));
  await peer.stopSession({session_id: "session"});
  const read = await peer.readConversation("session");
  const fork = {target_session_id: "child", continuation_group_key: "child-key", expected_history_hash: read.payload.history.history_hash,
    last_turn_id: "turn"};
  const first = await peer.forkConversation("session", fork, {id: "durable-fork"});
  const duplicate = await peer.forkConversation("session", fork, {id: "durable-fork"});
  assert.deepEqual(first.payload, duplicate.payload); assert.equal(adapter.mutations, 1);
  const rolled = await peer.rollbackConversation("session", {num_turns: 1, expected_history_hash: read.payload.history.history_hash});
  assert.equal(rolled.payload.history.turn_count, 1); assert.equal(rolled.payload.filesystem_undo, false);
  await peer.startSession({...start, session_id: "child", continuation_group_key: "child-key", continue_session: true});
  await peer.sendTurn({session_id: "child", turn_id: "child-turn", input: "followup"});
  await until(() => events.some(event => event.turn_id === "child-turn" && event.event_type === "turn.completed"));
  await peer.stopSession({session_id: "child"}); await peer.retireConversation("child");
  console.log("Public SDK controls, session observations, native adapter hooks, content chunks, mutation receipts and fork resume passed");
} finally {
  await runner?.close(); for (const socket of server.clients) socket.terminate();
  await new Promise(resolve => server.close(resolve)); await rm(cwd, {recursive: true, force: true});
}
