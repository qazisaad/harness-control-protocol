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

const cwd = await mkdtemp(join(tmpdir(), "hcp-mcp-detach-consumer-"));
const server = new WebSocketServer({host: "127.0.0.1", port: 0});
await new Promise(resolve => server.once("listening", resolve));
let peer, runner, ready = false, failure;
const events = [], closed = [];
server.on("connection", socket => {
  peer = new HcpHostConnection({send: message => socket.send(JSON.stringify(message))});
  socket.on("message", raw => {try {
    const observation = peer.receive(raw.toString());
    if (observation.message.type === "host.hello") peer.accept({protocol_version: "hcp.v0", heartbeat_interval_seconds: 30});
    if (observation.message.type === "host.capabilities.updated") ready = true;
    if (observation.message.type === "harness.event") events.push(observation.message.payload);
  } catch (error) {failure = error; socket.close();}});
  socket.on("close", () => peer.disconnect());
});
async function until(predicate) {
  const deadline = Date.now() + 15000;
  while (!predicate()) {if (failure) throw failure; if (Date.now() > deadline) throw new Error("MCP detach consumer timed out"); await delay(10);}
}
try {
  const config = RunnerConfigSchema.parse({runner_id: "detach-consumer", control_plane_url: `ws://127.0.0.1:${server.address().port}`,
    workspaces: [{id: "workspace", path: cwd}], provider_instances: [{id: "provider", driver_kind: "example.controls"}]});
  const adapter = new ControlHarnessAdapter();
  // These selected endpoints are local test descriptors; no remote connection is made.
  const sessions = new HarnessSessionManager(config, {adapterRegistry: new HarnessAdapterRegistry([adapter]),
    mcpClientFactory: ({attachment}) => ({async connect() {}, async listTools() {return [];}, async close() {closed.push(attachment.name);}})});
  runner = new RunnerConnection({config, runnerVersion: "fixture", harnessSessions: sessions});
  await runner.connect(); await until(() => ready);
  const descriptors = ["first", "second"].map(name => ({name, transport: "streamable_http", url: `https://example.invalid/${name}`,
    headers: {}, lease_id: "fixture", proof_of_possession: {scheme: "runner_signed_request", key_id: "fixture", required_headers: ["x-hcp-session-id"]}}));
  await peer.startSession({session_id: "session", workspace_id: "workspace", cwd, provider_instance_id: "provider", driver_kind: "example.controls",
    model_selection: {model: "fixture"}, approval_policy: "full_access", sandbox_mode: "read_only", execution_profile: "interactive",
    continue_session: false, continuation_group_key: "conversation", mcp_servers: descriptors});
  await peer.sendTurn({session_id: "session", turn_id: "first", input: "original"});
  await until(() => events.some(event => event.turn_id === "first" && event.event_type === "turn.completed"));
  await assert.rejects(peer.detachTools({session_id: "session", names: ["foreign"]})); assert.equal(adapter.nativeMcpDetaches, 0);
  await peer.detachTools({session_id: "session", names: ["first"]}, {id: "detach-first"});
  await until(() => events.some(event => event.event_type === "mcp.status.updated" && event.data.status === "detached"));
  await peer.detachTools({session_id: "session", names: ["first"]}, {id: "detach-first"});
  assert.equal(adapter.nativeMcpDetaches, 1); assert.deepEqual(closed, ["first"]);
  await peer.sendTurn({session_id: "session", turn_id: "followup", input: "followup"});
  await until(() => events.some(event => event.turn_id === "followup" && event.event_type === "turn.completed"));
  await peer.stopSession({session_id: "session"}); assert.deepEqual(closed, ["first", "second"]);
  console.log("Packed public MCP detach: native receipt, selected client closure, duplicate command and same-owner follow-up passed.");
} finally {if (runner) await runner.close(); await new Promise(resolve => server.close(resolve)); await rm(cwd, {recursive: true, force: true});}
