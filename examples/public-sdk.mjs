// Standalone package acceptance example. Only loopback, temporary files, and a custom adapter.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer } from "ws";
import { HcpHostConnection } from "@harness-control/sdk";
import { RunnerConnection } from "@harness-control/runner/connection";
import { RunnerConfigSchema, loadRunnerConfig } from "@harness-control/runner/config";
import { AccountUsageReader, normalizeCodexUsage } from "@harness-control/runner/accounts";
import { EchoHarnessAdapter } from "./custom-harness.js";
import { HarnessAdapterRegistry, HarnessSessionManager } from "@harness-control/runner/harnesses";

const directory = await realpath(await mkdtemp(join(tmpdir(), "hcp-public-sdk-")));
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
    provider_instances: [{ id: "echo-local", driver_kind: "example.echo", display_name: "Custom harness", enabled: true, account_usage: {} }],
  });
  await writeFile(configPath, JSON.stringify(config));
  runner = new RunnerConnection({ config, configPath, runnerVersion: "0.4.0", accountUsage: new AccountUsageReader(config, { collectors: new Map([["example.echo", async context => normalizeCodexUsage(context, { account: { type: "chatgpt", email: "fixture@example.com", planType: "fixture" } }, { rateLimits: { primary: { usedPercent: 96, resetsAt: Math.ceil(Date.now() / 1000) + 86400 } } })]]) }), harnessSessions: new HarnessSessionManager(config, { adapterRegistry: new HarnessAdapterRegistry([new EchoHarnessAdapter()]) }) });
  await runner.connect();
  await until(() => received.some(message => message.type === "host.capabilities.updated"));
  const capabilities = received.find(message => message.type === "host.capabilities.updated").payload;
  assert.ok(capabilities.providers.some(provider => provider.provider_instance_id === "echo-local"));
  const accountSnapshot = await peer.readAccounts();
  assert.equal(accountSnapshot.payload.providers.length, 1);
  const [accountView] = peer.accounts.accounts(new Date(), 300_000);
  assert.equal(accountView.freshness, "fresh");
  assert.equal(accountView.observation.limits[0]?.used_percent, 96);
  assert.equal(accountView.sources.length, 1);
  let revision = capabilities.workspace_management.revision;
  async function manage(operation) {
    const result = await peer.manageWorkspaces({ operation, expected_revision: revision, expires_at: new Date(Date.now() + 30_000).toISOString() });
    assert.equal(result.payload.outcome.kind, "success");
    revision = result.payload.management.revision;
    return result.payload.workspaces;
  }
  assert.deepEqual(await manage({ kind: "list" }), []);
  const browsed = await peer.manageWorkspaces({ operation: { kind: "browse", path: directory }, expected_revision: revision, expires_at: new Date(Date.now() + 30_000).toISOString() });
  assert.equal(browsed.payload.outcome.kind, "directory");
  assert.ok(browsed.payload.outcome.entries.some(entry => entry.path === folder));
  assert.deepEqual(browsed.payload.workspaces, []);
  const [workspace] = await manage({ kind: "add", path: folder, display_name: "Project" });
  assert.ok(workspace);
  await manage({ kind: "rename", id: workspace.id, display_name: "Renamed project" });
  const persisted = await loadRunnerConfig(configPath);
  assert.equal(persisted.workspaces[0].display_name, "Renamed project");
  await peer.startSession({ session_id: "session-1", workspace_id: workspace.id, provider_instance_id: "echo-local",
    driver_kind: "example.echo", cwd: folder, sandbox_mode: "workspace_write", approval_policy: "full_access", continue_session: false, model_selection: { model: "echo", options: [] }, mcp_servers: [], local_capability_lease: { lease_id: "local-lease", hcp_session_id: "session-1", execution_host_id: config.host_id, provider_instance_id: "echo-local", workspace_id: workspace.id, issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString(), policy_version: "example-v1", capabilities: [{ id: "filesystem", scopes: ["workspace_read"] }] } });
  await until(() => received.some(message => message.type === "harness.event" && message.payload.event_type === "session.configured"));
  await peer.sendTurn({ session_id: "session-1", turn_id: "turn-1", input: "Explain this project" });
  await until(() => received.some(message => message.type === "harness.event" && message.payload.event_type === "turn.completed"));
  assert.equal(received.find(message => message.type === "harness.event" && message.payload.event_type === "turn.completed").payload.data.final_output.final_text, "Explain this project");
  const localRead = await peer.runLocalAction({
    request_id: "read-1", action: "local.filesystem.read", issued_at: new Date().toISOString(),
    attribution: { session_id: "session-1", turn_id: "turn-1", workspace_id: workspace.id, provider_instance_id: "echo-local" },
    lease: { lease_id: "local-lease", capability_id: "filesystem", scope: "workspace_read", hcp_session_id: "session-1", execution_host_id: config.host_id, provider_instance_id: "echo-local", workspace_id: workspace.id },
    sandbox: { mode: "workspace_write", workspace_root: folder, cwd: folder, requires_workspace_containment: true },
    approval: { status: "not_required" }, output_limits: { content_bytes: 65536 }, cancellation: { cancellable: false },
    audit: { started_event_type: "local_capability.action.started", completed_event_type: "local_capability.action.completed", failed_event_type: "local_capability.action.failed" },
    input: { path: "README.md", encoding: "utf8" },
  });
  assert.equal(localRead.type, "local.action.response");
  assert.equal(localRead.payload.output.content, "Package acceptance workspace\n");
  const snapshot = await peer.requestSnapshot({ session_id: "session-1" });
  assert.ok(snapshot.payload.events.some(event => event.event_type === "turn.completed"));
  await peer.stopSession({ session_id: "session-1", reason: "Example complete" });
  await until(() => received.some(message => message.type === "harness.event" && message.payload.event_type === "session.exited"));
  assert.deepEqual(await manage({ kind: "remove", id: workspace.id }), []);
  assert.equal(await readFile(join(folder, "README.md"), "utf8"), "Package acceptance workspace\n");
  if (failure) throw failure;
  console.log("Public packages: custom adapter, local capability without product IDs, account read, SDK account reduction, folder browse/list/add/rename/remove, persisted config, session start, terminal turn, snapshot, and session exit verified over WebSocket.");
} finally {
  await runner?.close();
  peer?.disconnect();
  for (const socket of server.clients) socket.terminate();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await rm(directory, { recursive: true, force: true });
}
