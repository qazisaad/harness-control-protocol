import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer } from "ws";
import { HcpHostConnection } from "@harness-control/sdk";
import type { HcpMessage } from "@harness-control/protocol";
import { RunnerConfigSchema } from "./config/index.js";
import { connectionDirectory } from "./ownership.js";
import { writeRunnerCredentials } from "./pairing/index.js";

// The real Codex adapter talks to this local RPC fixture; no provider account is used.
const codex = `#!${process.execPath}
const readline = require('node:readline');
if (process.argv.includes('--version')) { console.log('codex ownership fixture'); process.exit(0); }
if (process.argv.includes('login')) process.exit(0);
const send = value => console.log(JSON.stringify(value));
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (!message.id) return;
  const reply = result => send({ id: message.id, result });
  if (message.method === 'initialize') reply({});
  if (message.method === 'config/read') reply({ config: {} });
  if (message.method === 'mcpServerStatus/list') reply({ data: [], nextCursor: null });
  if (message.method === 'thread/start') reply({ thread: { id: 'native-thread' }, sandbox: { type: 'workspaceWrite', writableRoots: [], excludeTmpdirEnvVar: true, excludeSlashTmp: true }, approvalPolicy: 'never' });
  if (message.method === 'turn/start') {
    reply({ turn: { id: 'native-turn' } });
    send({ method: 'turn/started', params: { threadId: 'native-thread', turn: { id: 'native-turn' } } });
    send({ method: 'item/completed', params: { threadId: 'native-thread', turnId: 'native-turn', item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'Recovered' } } });
    send({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { id: 'native-turn', status: 'completed', error: null } } });
  }
});
`;

test("CLI crash recovery preserves identity, excludes run/connect competitors, and completes a turn", { timeout: 90_000, skip: process.platform === "win32" }, async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "hcp-cli-ownership-")));
  const children: { process: ChildProcess; exited: Promise<unknown[]>; output: () => string }[] = [];
  let pairingRequests = 0;
  let tokenRequests = 0;
  let holdRequests = false;
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/runner-connection-token") {
      tokenRequests++;
      if (holdRequests) return;
      res.end(JSON.stringify({ connection_token: "fixture", expires_at: new Date(Date.now() + 60_000).toISOString() }));
    } else { pairingRequests++; if (holdRequests) return; res.writeHead(400); res.end("{}"); }
  });
  const sockets = new WebSocketServer({ server });
  const received: HcpMessage[] = [];
  const peers: HcpHostConnection[] = [];
  let failure: unknown;
  sockets.on("connection", socket => {
    const peer = new HcpHostConnection({ send: message => socket.send(JSON.stringify(message)) });
    peers.push(peer);
    socket.on("message", raw => {
      try {
        const { message } = peer.receive(raw.toString());
        received.push(message);
        if (message.type === "host.hello") peer.accept({ protocol_version: "hcp.v0", heartbeat_interval_seconds: 30 });
      } catch (error) { failure = error; }
    });
    socket.on("close", () => peer.disconnect());
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = `ws://127.0.0.1:${address.port}/hcp/runner`;
  const directory = connectionDirectory(endpoint, home);
  const configPath = join(directory, "runner.json");
  const executable = join(home, "codex.cjs");
  const cli = (args: string[]) => {
    const source = `import { main } from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)}; process.exitCode = await main(JSON.parse(process.argv[2]), process.argv[3]);`;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source, fileURLToPath(import.meta.url), JSON.stringify(args), home], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout!.on("data", (data: Buffer) => { output += data.toString(); });
    child.stderr!.on("data", (data: Buffer) => { output += data.toString(); });
    const result = { process: child, exited: once(child, "exit"), output: () => output };
    children.push(result);
    return result;
  };
  const until = async (condition: () => boolean): Promise<void> => {
    const deadline = Date.now() + 30_000;
    while (!condition()) {
      if (failure) throw failure;
      assert.ok(Date.now() < deadline, children.map(child => child.output()).join("\n"));
      await delay(10);
    }
  };
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(executable, codex, { mode: 0o700 });
    const config = RunnerConfigSchema.parse({
      runner_id: "ownership-fixture", host_id: "ownership-fixture", control_plane_url: endpoint,
      credentials_path: join(home, "credentials.json"), state_path: join(home, "state.json"),
      workspaces: [{ id: "project", path: home }], workspace_management: { allowed_roots: [home] },
      provider_instances: [{ id: "codex", driver_kind: "codex", executable_path: executable, models: [{ id: "fixture", label: "Fixture", is_default: true }] }],
    });
    const saved = JSON.stringify(config);
    await writeFile(configPath, saved);
    await writeRunnerCredentials(config.credentials_path!, { credential_id: "fixture", credential_secret: "fixture", runner_id: config.runner_id, host_id: config.host_id!, control_plane_url: endpoint, issued_at: new Date().toISOString(), mcp_proof_secret: "fixture" });
    const credentials = await readFile(config.credentials_path!, "utf8");
    const first = cli(["connect", endpoint, "--no-browser"]);
    await until(() => received.some(message => message.type === "host.capabilities.updated"));
    const duplicate = cli(["connect", endpoint]);
    assert.equal((await duplicate.exited)[0], 0, duplicate.output());
    assert.match(duplicate.output(), /already running/);
    const direct = cli(["run", "--config", configPath]);
    assert.equal((await direct.exited)[0], 1, direct.output());
    assert.match(direct.output(), /requested config was not started/);
    const otherConfig = join(home, "other.json");
    await writeFile(otherConfig, JSON.stringify({ ...config, control_plane_url: `${endpoint}/other` }));
    const sharedState = cli(["run", "--config", otherConfig]);
    assert.equal((await sharedState.exited)[0], 1, sharedState.output());
    assert.match(sharedState.output(), /saved state is already in use/);
    assert.equal(peers.length, 1);
    first.process.kill("SIGKILL");
    await first.exited;
    received.length = 0;
    const recovered = cli(["connect", endpoint, "--no-browser"]);
    await until(() => received.some(message => message.type === "host.capabilities.updated"));
    assert.match(recovered.output(), /Recovered the previous HCP connection/);
    assert.equal(pairingRequests, 0);
    assert.equal(tokenRequests, 2);
    assert.equal(await readFile(configPath, "utf8"), saved);
    assert.equal(await readFile(config.credentials_path!, "utf8"), credentials);
    const hello = received.find(message => message.type === "host.hello");
    assert.ok(hello?.type === "host.hello");
    assert.equal(hello.payload.runner_id, config.runner_id);
    const peer = peers.at(-1)!;
    await peer.startSession({ session_id: "recovered-session", workspace_id: "project", provider_instance_id: "codex", driver_kind: "codex", cwd: home, sandbox_mode: "workspace_write", approval_policy: "full_access", continue_session: false, model_selection: { model: "fixture", options: [] }, mcp_servers: [] });
    await until(() => received.some(message => message.type === "harness.event" && message.payload.event_type === "session.configured"));
    await peer.sendTurn({ session_id: "recovered-session", turn_id: "recovered-turn", input: "Recover" });
    await until(() => received.some(message => message.type === "harness.event" && message.payload.event_type === "turn.completed"));
    await peer.stopSession({ session_id: "recovered-session", reason: "Acceptance complete" });
    await until(() => received.some(message => message.type === "harness.event" && message.payload.event_type === "session.exited"));
    recovered.process.kill("SIGTERM");
    assert.equal((await recovered.exited)[0], 0, recovered.output());
    await assert.rejects(readFile(join(directory, "runner.json.lock")), { code: "ENOENT" });
    const directRestart = cli(["run", "--config", configPath]);
    await until(() => peers.length === 3);
    const blockedConnect = cli(["connect", endpoint]);
    assert.equal((await blockedConnect.exited)[0], 0, blockedConnect.output());
    assert.match(blockedConnect.output(), /already running/);
    directRestart.process.kill("SIGINT");
    assert.equal((await directRestart.exited)[0], 0, directRestart.output());
    holdRequests = true;
    const priorTokenRequests = tokenRequests;
    const duringStartup = cli(["connect", endpoint, "--no-browser"]);
    await until(() => tokenRequests > priorTokenRequests);
    duringStartup.process.kill("SIGTERM");
    assert.equal((await duringStartup.exited)[0], 0, duringStartup.output());
    await assert.rejects(readFile(join(directory, "runner.json.lock")), { code: "ENOENT" });
    assert.equal(peers.length, 3);
    const duringPairing = cli(["connect", endpoint, "--pair", "--no-browser"]);
    await until(() => pairingRequests === 1);
    duringPairing.process.kill("SIGINT");
    assert.equal((await duringPairing.exited)[0], 1, duringPairing.output());
    assert.match(duringPairing.output(), /Setup cancelled/);
    await assert.rejects(readFile(join(directory, "runner.json.lock")), { code: "ENOENT" });
    assert.equal(await readFile(config.credentials_path!, "utf8"), credentials);
  } finally {
    for (const child of children) {
      if (child.process.exitCode === null && child.process.signalCode === null) { child.process.kill("SIGKILL"); await child.exited; }
    }
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>(resolve => sockets.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
});
