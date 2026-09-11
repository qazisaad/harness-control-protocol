// Standalone package acceptance example. Only loopback, temporary files, and the mock provider.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer } from "ws";
import { HcpHostConnection } from "@harness-control/sdk";
import { RunnerConnection } from "@harness-control/runner/connection";
import { RunnerConfigSchema, loadRunnerConfig } from "@harness-control/runner/config";
import { HarnessSessionManager } from "@harness-control/runner/harnesses";

const directory = await mkdtemp(join(tmpdir(), "hcp-public-sdk-"));
const folder = join(directory, "project");
await mkdir(folder);
await writeFile(join(folder, "README.md"), "Package acceptance workspace\n");
const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
const received = [];
let peer;
let failure;
let runner;
server.on("connection", socket => {
  // This isolated example has no external clients. A hosted app must authenticate first.
  const connection = new HcpHostConnection({ send: message => socket.send(JSON.stringify(message)) });
  peer = connection;
  socket.on("message", raw => {
    try {
      const observation = connection.receive(raw.toString());
      const message = observation.message;
      if (message.type === "host.hello") {
        assert.equal(message.payload.runner_id, "public-sdk-example");
        assert.equal(message.payload.host_id, "public-sdk-example");
        connection.accept({ protocol_version: "hcp.v0", heartbeat_interval_seconds: 30 });
      }
      if ("reduction" in observation) assert.ok(["applied", "duplicate"].includes(observation.reduction.outcome));
      received.push(message);
    } catch (error) { failure = error; connection.disconnect(); socket.close(); }
  });
  socket.on("close", () => connection.disconnect());
  socket.on("error", error => { failure = error; connection.disconnect(); });
});
async function until(predicate) {
  const deadline = Date.now() + 15_000;
  while (!predicate()) {
    if (failure) throw failure;
    if (Date.now() > deadline) throw new Error("Timed out waiting for terminal observation");
    await delay(10);
  }
}
try {
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const configPath = join(directory, "runner.json");
  const config = RunnerConfigSchema.parse({
    runner_id: "public-sdk-example", host_id: "public-sdk-example",
    control_plane_url: `ws://127.0.0.1:${address.port}`,
    workspaces: [], workspace_management: { allowed_roots: [directory] },
    provider_instances: [{ id: "mock", driver_kind: "mock", display_name: "Mock", enabled: true }],
  });
  await writeFile(configPath, JSON.stringify(config));
  runner = new RunnerConnection({ config, configPath, runnerVersion: "0.2.0", harnessSessions: new HarnessSessionManager(config) });
  await runner.connect();
  await until(() => received.some(message => message.type === "host.capabilities.updated"));
  const capabilities = received.find(message => message.type === "host.capabilities.updated").payload;
  assert.ok(capabilities.providers.some(provider => provider.provider_instance_id === "mock"));
  let revision = capabilities.workspace_management.revision;
  async function manage(operation) {
    const result = await peer.manageWorkspaces({ operation, expected_revision: revision, expires_at: new Date(Date.now() + 30_000).toISOString() });
    assert.equal(result.payload.outcome.kind, "success");
    revision = result.payload.management.revision;
    return result.payload.workspaces;
  }
  assert.deepEqual(await manage({ kind: "list" }), []);
  const [workspace] = await manage({ kind: "add", path: folder, display_name: "Project" });
  assert.ok(workspace);
  await manage({ kind: "rename", id: workspace.id, display_name: "Renamed project" });
  const persisted = await loadRunnerConfig(configPath);
  assert.equal(persisted.workspaces[0].display_name, "Renamed project");
  await peer.startSession({ session_id: "session-1", workspace_id: workspace.id, provider_instance_id: "mock",
    driver_kind: "mock", cwd: folder, sandbox_mode: "workspace_write", approval_policy: "full_access", continue_session: false, model_selection: { model: "mock-model", options: [] }, mcp_servers: [] });
  await until(() => received.some(message => message.type === "harness.event" && message.payload.event_type === "session.configured"));
  await peer.sendTurn({ session_id: "session-1", turn_id: "turn-1", input: "Explain this project" });
  await until(() => received.some(message => message.type === "harness.event" && message.payload.event_type === "turn.completed"));
  const snapshot = await peer.requestSnapshot({ session_id: "session-1" });
  assert.ok(snapshot.payload.events.some(event => event.event_type === "turn.completed"));
  await peer.stopSession({ session_id: "session-1", reason: "Example complete" });
  await until(() => received.some(message => message.type === "harness.event" && message.payload.event_type === "session.exited"));
  assert.deepEqual(await manage({ kind: "remove", id: workspace.id }), []);
  assert.equal(await readFile(join(folder, "README.md"), "utf8"), "Package acceptance workspace\n");
  if (failure) throw failure;
  console.log("Public packages: folder list/add/rename/remove, persisted config, session start, terminal turn, snapshot, and session exit verified over WebSocket.");
} finally {
  await runner?.close();
  peer?.disconnect();
  for (const socket of server.clients) socket.terminate();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await rm(directory, { recursive: true, force: true });
}
