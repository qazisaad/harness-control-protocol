// Opt-in Codex acceptance: controlled generated PNG, local runner/WebSocket and one native vision prompt.
import assert from "node:assert/strict";
import {mkdtemp, realpath} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {deflateSync} from "node:zlib";
import {setTimeout as delay} from "node:timers/promises";
import {WebSocketServer} from "ws";
import {HcpHostConnection} from "@harness-control/sdk";
import {harnessTurnFinalOutputSchema} from "@harness-control/protocol";
import {HarnessSessionManager} from "@harness-control/runner/harnesses";
import {RunnerConnection} from "@harness-control/runner/connection";
import {RunnerConfigSchema} from "@harness-control/runner/config";
import {JsonRunnerStateStore} from "@harness-control/runner/state";
if (process.env.HCP_NATIVE_LIVE !== "1") throw new Error("Set HCP_NATIVE_LIVE=1 for controlled native image acceptance.");
const passed = [], cwd = await realpath(await mkdtemp(join(tmpdir(), "hcp-native-owned-image-")));
function crc32(bytes) {let crc = 0xffffffff;for (const byte of bytes) {crc ^= byte;for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);}return (crc ^ 0xffffffff) >>> 0;}
function chunk(type, body) {const name = Buffer.from(type), length = Buffer.alloc(4), crc = Buffer.alloc(4);length.writeUInt32BE(body.length);crc.writeUInt32BE(crc32(Buffer.concat([name, body])));return Buffer.concat([length, name, body, crc]);}
const header = Buffer.alloc(13);header.writeUInt32BE(32, 0);header.writeUInt32BE(32, 4);header[8] = 8;header[9] = 2;
const rows = Buffer.alloc(32 * (1 + 32 * 3));for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) rows[y * 97 + 1 + x * 3] = 255;
const baseImage = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
const imageBytes = process.env.HCP_LIVE_IMAGE_BYTES ? Number(process.env.HCP_LIVE_IMAGE_BYTES) : 529000;
assert.ok(Number.isSafeInteger(imageBytes) && imageBytes > 384 * 1024 && imageBytes <= 10 * 1024 * 1024);
const padding = Buffer.alloc(imageBytes - baseImage.length - 12, 120);Buffer.from("Fixture\0").copy(padding);
const image = Buffer.concat([baseImage.subarray(0, 33), chunk("tEXt", padding), baseImage.subarray(33)]);
assert.equal(image.byteLength, imageBytes);

const server = new WebSocketServer({host: "127.0.0.1", port: 0});await new Promise(resolve => server.once("listening", resolve));
let peer, runner, failure, ready = false, commandBytes = 0;const events = [];
server.on("connection", socket => {
  peer = new HcpHostConnection({send(message) {if (message.type === "harness.turn.send") commandBytes = Buffer.byteLength(JSON.stringify(message));socket.send(JSON.stringify(message));}});
  socket.on("message", raw => {try {
    const observation = peer.receive(raw.toString());
    if (observation.message.type === "host.hello") peer.accept({protocol_version: "hcp.v0", heartbeat_interval_seconds: 30});
    if (observation.message.type === "host.capabilities.updated") ready = true;
    if (observation.message.type === "harness.event") {if (!["applied", "duplicate"].includes(observation.reduction.outcome)) throw new Error("Native observation continuity changed.");events.push(observation.message.payload);}
  } catch (error) {failure = error;socket.close();}});socket.on("close", () => peer.disconnect());
});
const until = async predicate => {const deadline = Date.now() + 90000;while (!predicate()) {if (failure) throw failure;if (Date.now() > deadline) throw new Error("Native owned-image acceptance timed out.");await delay(20);}};
const config = RunnerConfigSchema.parse({runner_id: "native-owned-image", control_plane_url: `ws://127.0.0.1:${server.address().port}`,
  workspaces: [{id: "workspace", path: cwd}], provider_instances: [{id: "codex", driver_kind: "codex"}]});
const manager = new HarnessSessionManager(config, {stateStore: new JsonRunnerStateStore(join(cwd, "state.json"))});
try {
  const status = (await manager.providerDriverStatuses()).find(provider => provider.driver_kind === "codex");assert.ok(status?.execution_capabilities?.owned_image_inputs);
  if (process.env.HCP_LIVE_CODEX_EXPECTED_VERSION) assert.equal(status.version, process.env.HCP_LIVE_CODEX_EXPECTED_VERSION);
  else assert.match(status.version, /^codex-cli 0\.160\.[01]$/);const model = process.env.HCP_LIVE_CODEX_MODEL ?? status.models.find(model => model.is_default)?.id;assert.ok(model);
  passed.push("declared-owned-native-images");runner = new RunnerConnection({config, runnerVersion: "native-image-acceptance", harnessSessions: manager});await runner.connect();await until(() => ready);
  await peer.startSession({session_id: "image", workspace_id: "workspace", cwd, provider_instance_id: "codex", driver_kind: "codex", execution_profile: "interactive",
    model_selection: {model}, sandbox_mode: "read_only", approval_policy: "ask", continue_session: false, continuation_group_key: "image", mcp_servers: [], configuration_inheritance: {mcp_servers: false, plugins: false}});
  const uploaded = await peer.uploadImageFile("image", {filename: "fixture.png", mime_type: "image/png", bytes: image});
  assert.equal(events.filter(event => event.event_type === "turn.started").length, 0);passed.push("sealed-large-upload-before-model");
  await peer.sendTurn({session_id: "image", turn_id: "vision", input: "What is the predominant color in this image? Answer with exactly one uppercase color word. Use no tools, files, shell, agents or network.", image_files: [uploaded.reference]});
  await until(() => events.some(event => event.turn_id === "vision" && ["turn.completed", "turn.failed", "turn.cancelled"].includes(event.event_type)));
  const terminal = events.findLast(event => event.turn_id === "vision" && ["turn.completed", "turn.failed", "turn.cancelled"].includes(event.event_type));assert.equal(terminal.event_type, "turn.completed");
  const output = await peer.readFinalTextComplete("image", harnessTurnFinalOutputSchema.parse(terminal.data.final_output));assert.equal(output.availability, "complete");
  assert.ok(/^RED[.!]?$/i.test(output.final_text.trim()), "Native vision did not identify the controlled image color.");passed.push("actual-native-image-decoding");
  assert.ok(commandBytes < 8192);passed.push("small-reference-turn-frame");
  const text = await peer.readTextItemsComplete("image", events, "vision");assert.ok(text.some(item => item.completed_content?.toUpperCase().includes("RED")));passed.push("complete-physical-native-text-body");
  const retained = await peer.inputFile("image", {action: "read", file_id: uploaded.reference.file_id});assert.equal(retained.payload.input_file.state, "retained");passed.push("exact-image-retained-lifetime");
  const history = await peer.readConversationPageComplete("image");assert.ok(history.turns.length);passed.push("actual-native-history-readable");
  assert.ok(history.turns.some(turn => turn.portable_items?.some(row => row.item.type === "attachment" && row.item.media_kind === "image" && row.media)));
  passed.push("typed-portable-image-history");
  await peer.stopSession({session_id: "image"});await until(() => events.some(event => event.event_type === "session.exited" && event.data.native_owner_closed === true));passed.push("actual-native-owner-closure");
  console.log(JSON.stringify({driver: "codex", version: status.version, image_bytes: image.byteLength, passed}));
} finally {await runner?.close();await manager.close();for (const socket of server.clients) socket.terminate();await new Promise(resolve => server.close(resolve));}
