import assert from "node:assert/strict";
import {mkdtemp, mkdir, realpath, readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {WebSocketServer} from "ws";
import {HcpHostConnection} from "@harness-control/sdk";
import {RunnerConnection} from "@harness-control/runner/connection";
import {HarnessSessionManager} from "@harness-control/runner/harnesses";
import {RunnerConfigSchema} from "@harness-control/runner/config";

if (process.env.HCP_NATIVE_LIVE !== "1") throw new Error("Set HCP_NATIVE_LIVE=1 for native acceptance.");
const root = await realpath(await mkdtemp(join(tmpdir(), "hcp-native-sandbox-options-")));
const cwd = join(root, "current"), extra = join(root, "extra");await mkdir(cwd);await mkdir(extra);
const write = process.env.HCP_LIVE_SANDBOX_WRITE === "1";
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const server = new WebSocketServer({host: "127.0.0.1", port: 0});
await new Promise(resolve => server.once("listening", resolve));
const config = RunnerConfigSchema.parse({runner_id: "native-sandbox-options", control_plane_url: `ws://127.0.0.1:${server.address().port}`,
  workspaces: [{id: "current", path: cwd}, {id: "extra", path: extra}], provider_instances: [{id: "codex", driver_kind: "codex",
    ...(process.env.HCP_LIVE_CODEX_EXECUTABLE ? {executable_path: process.env.HCP_LIVE_CODEX_EXECUTABLE} : {})}]});
const manager = new HarnessSessionManager(config);
const events = [], waiters = new Set();let peer, ready = false, failure, runner;
const fail = error => {failure = error;for (const waiter of waiters) waiter.reject(error);waiters.clear();};
const wait = predicate => {
  if (failure) return Promise.reject(failure);
  if (predicate()) return Promise.resolve();
  const result = new Promise((resolve, reject) => waiters.add({predicate, resolve, reject}));void result.catch(() => {});return result;
};
const deadline = setTimeout(() => fail(new Error("Native sandbox acceptance exceeded its deadline.")), 120_000);
server.on("connection", socket => {
  peer = new HcpHostConnection({send: message => socket.send(JSON.stringify(message))});
  socket.on("message", raw => {
    try {
      const observed = peer.receive(raw.toString());
      if (observed.message.type === "host.hello") peer.accept({protocol_version: "hcp.v0", heartbeat_interval_seconds: 30});
      if (observed.message.type === "host.capabilities.updated") ready = true;
      if (observed.message.type === "harness.event") {
        assert.ok(["applied", "duplicate"].includes(observed.reduction.outcome));events.push(observed.message.payload);
      }
      for (const waiter of [...waiters]) if (waiter.predicate()) {waiters.delete(waiter);waiter.resolve();}
    } catch (error) {fail(error);}
  });
  socket.on("close", () => peer.disconnect());
});
const startSession = async payload => {
  await peer.startSession(payload);
  await wait(() => events.some(event => event.session_id === payload.session_id && event.event_type === "session.configured"));
  return events.filter(event => event.session_id === payload.session_id);
};
const sendTurn = async payload => {
  await peer.sendTurn(payload);
  await wait(() => events.some(event => event.session_id === payload.session_id && event.turn_id === payload.turn_id &&
    ["turn.completed", "turn.failed", "turn.cancelled", "turn.aborted"].includes(event.event_type)));
  return events.filter(event => event.session_id === payload.session_id && event.turn_id === payload.turn_id);
};
const stopSession = async session_id => {
  await peer.stopSession({session_id});await wait(() => events.some(event => event.session_id === session_id && event.event_type === "session.exited"));
};
const passed = [];
try {
  const status = (await manager.providerDriverStatuses()).find(provider => provider.driver_kind === "codex");
  assert.equal(status?.available, true);assert.equal(status?.version, process.env.HCP_LIVE_CODEX_EXPECTED_VERSION ?? "codex-cli 0.160.0");
  const model = process.env.HCP_LIVE_CODEX_MODEL ?? status.models.find(model => model.is_default)?.id;assert.ok(model);
  runner = new RunnerConnection({config, runnerVersion: "native-sandbox-options-acceptance", harnessSessions: manager});
  await runner.connect();await wait(() => ready);passed.push("actual-public-websocket-sdk");
  const base = {workspace_id: "current", cwd, provider_instance_id: "codex", driver_kind: "codex", execution_profile: "interactive",
    sandbox_mode: "workspace_write", approval_policy: write ? "full_access" : "auto_edits", continue_session: false, model_selection: {model}, mcp_servers: []};
  for (const network_access of [false, true]) {
    const session_id = `network-${network_access}`, start = {...base, session_id, continuation_group_key: `${session_id}-conversation`,
      sandbox_options: {network_access, writable_roots: [{workspace_id: "extra", path: extra}]}};
    const configured = await startSession(start);
    assert.deepEqual(configured.find(event => event.event_type === "session.configured").data.native_policy_readback.sandbox_options, start.sandbox_options);
    assert.equal(configured.some(event => event.turn_id), false);
    passed.push(`native-network-${network_access}-and-additional-root`, `no-model-start-${network_access}`);
    if (process.env.HCP_LIVE_SANDBOX_MODEL === "1") {
      const events = await sendTurn({session_id, turn_id: `proof-${network_access}`, input: "Reply SANDBOX_OPTIONS_READY. Use no tools."});
      assert.equal(events.at(-1)?.event_type, "turn.completed");
      assert.deepEqual(events.find(event => event.event_type === "settings.effective").data.sandbox_options, start.sandbox_options);
      passed.push(`native-model-preserves-authority-${network_access}`);
    }
    if (write) {
      const allowed = join(extra, `allowed-${network_access}.txt`);
      const command = `/usr/bin/printf AUTHORIZED_ROOT > ${shellQuote(allowed)}`;
      const result = await sendTurn({session_id, turn_id: `write-${network_access}`, input:
        "Use exec_command exactly once to run the following shell command, preserving default sandbox_permissions. Do not request escalation, retry or use any other tools. Finish after the operation.\n" + command});
      assert.equal(result.at(-1)?.event_type, "turn.completed");
      const completed = result.filter(event => event.event_type === "command.completed" && typeof event.data.command === "string" && event.data.command.includes(allowed));
      assert.equal(completed.length, 1);assert.ok(completed[0].data.command_id);assert.equal(completed[0].data.exit_code, 0);
      assert.equal(await readFile(allowed, "utf8"), "AUTHORIZED_ROOT");
      passed.push(`native-authorized-root-write-${network_access}`);
    }
    await stopSession(session_id, "verify-unload");passed.push(`confirmed-unload-${network_access}`);
    await assert.rejects(startSession({...start, session_id: `changed-${network_access}`, continue_session: true,
      sandbox_options: {...start.sandbox_options, network_access: !network_access}}), /policy changed|original configuration scope/);
    passed.push(`changed-authority-refused-${network_access}`);
    const resumed = await startSession({...start, session_id: `resumed-${network_access}`, continue_session: true});
    assert.deepEqual(resumed.find(event => event.event_type === "session.configured").data.native_policy_readback.sandbox_options, start.sandbox_options);
    await stopSession(`resumed-${network_access}`, "verify-resumed-unload");passed.push(`same-authority-resume-${network_access}`);
  }
  console.log(JSON.stringify({driver: "codex", root, passed}));
} finally {
  clearTimeout(deadline);
  if (runner) await runner.close();else await manager.close();
  for (const socket of server.clients) socket.terminate();await new Promise(resolve => server.close(resolve));
}
