// Packed SDK + runner: remote agent setup with a local fake installer. No network, no real agent.
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer } from "ws";
import { HcpHostConnection } from "@harness-control/sdk";
import { RunnerConnection } from "@harness-control/runner/connection";
import { RunnerConfigSchema, loadRunnerConfig } from "@harness-control/runner/config";

const directory = await realpath(await mkdtemp(join(tmpdir(), "hcp-provider-setup-consumer-")));
const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
await new Promise(resolve => server.once("listening", resolve));
let peer, runner, failure;
const capabilities = [];
server.on("connection", socket => {
  peer = new HcpHostConnection({ send: message => socket.send(JSON.stringify(message)) });
  socket.on("message", raw => { try {
    const { message } = peer.receive(raw.toString());
    if (message.type === "host.hello") peer.accept({ protocol_version: "hcp.v0", heartbeat_interval_seconds: 30 });
    if (message.type === "host.capabilities.updated") capabilities.push(message.payload);
  } catch (error) { failure = error; socket.close(); } });
  socket.on("close", () => peer.disconnect());
});
async function until(predicate) {
  const deadline = Date.now() + 15_000;
  while (!predicate()) { if (failure) throw failure; if (Date.now() > deadline) throw new Error("Provider setup consumer timed out"); await delay(10); }
}
try {
  const configPath = join(directory, "runner.json");
  const installRoot = join(directory, "providers");
  const config = RunnerConfigSchema.parse({ runner_id: "provider-setup-consumer", control_plane_url: `ws://127.0.0.1:${server.address().port}`,
    provider_setup: { remote_agents: ["codex"] } });
  await writeFile(configPath, JSON.stringify(config));
  const installs = [];
  // Stands in for npm: the same bin layout, answering the real Codex probe as installed but signed out.
  const installer = async ({ packageSpec, prefix }) => {
    installs.push(packageSpec);
    await mkdir(join(prefix, "node_modules", ".bin"), { recursive: true });
    const binary = join(prefix, "node_modules", ".bin", "codex");
    await writeFile(binary, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo \"codex-cli 0.161.0\"; exit 0; fi\nexit 1\n");
    await chmod(binary, 0o755);
  };
  runner = new RunnerConnection({ config, configPath, runnerVersion: "package-check", providerSetup: { installRoot, installer } });
  await runner.connect();
  await until(() => capabilities.length === 1);
  assert.deepEqual(capabilities[0].provider_setup, { agents: [{ agent: "codex", version: "0.161.0" }] });

  const refused = await peer.setupProvider({ agent: "claude", action: "install", expires_at: new Date(Date.now() + 60_000).toISOString() });
  assert.equal(refused.payload.outcome.kind, "refused");
  assert.equal(refused.payload.outcome.reason, "agent_not_allowed");

  const request = { agent: "codex", action: "install", expires_at: new Date(Date.now() + 60_000).toISOString() };
  const result = await peer.setupProvider(request, { id: "setup-codex" });
  const executable = join(installRoot, "codex", "0.161.0", "node_modules", ".bin", "codex");
  assert.deepEqual(result.payload.outcome, { kind: "installed", version: "0.161.0", changed: true, status: "unauthenticated", login_command: `${executable} login` });
  await until(() => capabilities.length === 2);
  const codex = capabilities[1].providers.find(provider => provider.driver_kind === "codex");
  assert.equal(codex.auth.login_command, `${executable} login`);
  assert.equal((await loadRunnerConfig(configPath)).provider_instances[0].executable_path, executable);

  // A lost result is recovered by resending the same id; the runner answers from its receipt.
  const repeated = await peer.setupProvider(request, { id: "setup-codex" });
  assert.deepEqual(repeated.payload, result.payload);
  assert.deepEqual(installs, ["@openai/codex@0.161.0"]);
  if (failure) throw failure;
  console.log("Provider setup: capability policy, refusal, install result with sign-in command, republished capabilities, saved executable and idempotent resend verified over WebSocket.");
} finally {
  await runner?.close();
  peer?.disconnect();
  for (const socket of server.clients) socket.terminate();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await rm(directory, { recursive: true, force: true });
}
