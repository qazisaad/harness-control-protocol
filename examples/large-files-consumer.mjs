// Independent public runner/SDK fixture acceptance. Synthetic adapter IDs are not native-provider evidence.
import assert from "node:assert/strict";
import {mkdtemp, rm, realpath, readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import {createHash} from "node:crypto";
import {WebSocketServer} from "ws";
import {HcpHostConnection} from "@harness-control/sdk";
import {HarnessSessionManager, HarnessAdapterRegistry} from "@harness-control/runner/harnesses";
import {RunnerConnection} from "@harness-control/runner/connection";
import {RunnerConfigSchema} from "@harness-control/runner/config";
const cwd = await realpath(await mkdtemp(join(tmpdir(), "hcp-large-files-consumer-")));
const bytes = new Uint8Array(50 * 1024 * 1024).fill(7), expected = Buffer.from(bytes);let turns = 0, wireBytes = 0, peer, runner, failure, ready = false;
const events = [], server = new WebSocketServer({host: "127.0.0.1", port: 0});
await new Promise(resolve => server.once("listening", resolve));
server.on("connection", socket => {
  peer = new HcpHostConnection({send(message) {if (message.type === "harness.turn.send") wireBytes = Buffer.byteLength(JSON.stringify(message));socket.send(JSON.stringify(message));}});
  socket.on("message", raw => {try {
    const observation = peer.receive(raw.toString());
    if (observation.message.type === "host.hello") peer.accept({protocol_version: "hcp.v0", heartbeat_interval_seconds: 30});
    if (observation.message.type === "host.capabilities.updated") ready = true;
    if (observation.message.type === "harness.event") {assert.ok(["applied", "duplicate"].includes(observation.reduction.outcome));events.push(observation.message.payload);}
  } catch (error) {failure = error;socket.close();}});
  socket.on("close", () => peer.disconnect());
});
const until = async predicate => {const deadline = Date.now() + 15000;while (!predicate()) {if (failure) throw failure;if (Date.now() > deadline) throw new Error("Owned-image fixture timed out");await delay(10);}};
try {
  const adapter = {driverKind: "example.images", fileContextInputs: true,
    async probe() {return {driver_kind: "example.images", installed: true, available: true, models: []};},async validateStart() {},
    async startSession() {return {adapter_session_id: "fixture"};},async cancelTurn() {return [];},async stopSession() {return [];},
    async sendTurn(input) {
      turns++;assert.equal(input.payload.images, undefined);assert.equal(input.payload.files.length, 1);
      const context = input.payload.input;
      const projection = JSON.parse(context.slice(context.indexOf("[{")))[0];
      const actual = await readFile(projection.path);
      assert.equal(actual.byteLength, expected.byteLength);
      assert.equal(createHash("sha256").update(actual).digest("hex"), createHash("sha256").update(expected).digest("hex"));
      assert.equal(projection.sha256, input.payload.files[0].reference.sha256);
      return [{event_type: "turn.completed", turn_id: input.payload.turn_id, data: {final_output: {final_text: "fixture", final_text_truncated: false}}}];
    }};
  const config = RunnerConfigSchema.parse({runner_id: "owned-images-consumer", control_plane_url: `ws://127.0.0.1:${server.address().port}`,
    workspaces: [{id: "workspace", path: cwd}], provider_instances: [{id: "provider", driver_kind: "example.images"}]});
  const manager = new HarnessSessionManager(config, {adapterRegistry: new HarnessAdapterRegistry([adapter])});
  runner = new RunnerConnection({config, runnerVersion: "fixture", harnessSessions: manager});await runner.connect();await until(() => ready);
  await peer.startSession({session_id: "fixture", workspace_id: "workspace", cwd, provider_instance_id: "provider", driver_kind: "example.images",
    model_selection: {model: "fixture"}, sandbox_mode: "read_only", approval_policy: "ask", continue_session: false, mcp_servers: []});
  const uploaded = await peer.uploadInputFile("fixture", {filename: "fixture.bin", mime_type: "application/octet-stream", bytes});assert.equal(turns, 0);
  await peer.sendTurn({session_id: "fixture", turn_id: "image", input: "fixture", files: [{reference: uploaded.reference, delivery: "file_context"}]});await until(() => events.some(event => event.turn_id === "image" && event.event_type === "turn.completed"));
  assert.equal(turns, 1);assert.ok(wireBytes < 8192);
  const retained = await peer.inputFile("fixture", {action: "read", file_id: uploaded.reference.file_id});assert.equal(retained.payload.input_file.state, "retained");
  await assert.rejects(peer.inputFile("fixture", {action: "release", file_id: uploaded.reference.file_id}));
  console.log("Packed public maximum-size files: 50 MiB scoped sealed upload, small turn references, exact materialized integrity, retained lifetime and release refusal passed.");
} finally {await runner?.close();for (const client of server.clients) client.terminate();await new Promise(resolve => server.close(resolve));await rm(cwd, {recursive: true, force: true});}
