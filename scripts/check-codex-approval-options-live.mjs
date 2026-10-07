import assert from "node:assert/strict";
import {mkdtemp, realpath} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {WebSocketServer} from "ws";
import {HcpHostConnection} from "@harness-control/sdk";
import {RunnerConnection} from "@harness-control/runner/connection";
import {HarnessSessionManager} from "@harness-control/runner/harnesses";
import {RunnerConfigSchema} from "@harness-control/runner/config";

if (process.env.HCP_NATIVE_LIVE !== "1") throw new Error("Set HCP_NATIVE_LIVE=1 for native acceptance.");
const root = await realpath(await mkdtemp(join(tmpdir(), "hcp-native-approval-options-")));
const cwd = root;
const server = new WebSocketServer({host: "127.0.0.1", port: 0});
await new Promise(resolve => server.once("listening", resolve));
const config = RunnerConfigSchema.parse({runner_id: "native-approval-options", control_plane_url: `ws://127.0.0.1:${server.address().port}`,
  workspaces: [{id: "current", path: cwd}], provider_instances: [{id: "codex", driver_kind: "codex",
    ...(process.env.HCP_LIVE_CODEX_EXECUTABLE ? {executable_path: process.env.HCP_LIVE_CODEX_EXECUTABLE} : {})}]});
const manager = new HarnessSessionManager(config);
const events = [], waiters = new Set();let peer, ready = false, failure, runner;
const fail = error => {failure = error;for (const waiter of waiters) waiter.reject(error);waiters.clear();};
const wait = predicate => {
  if (failure) return Promise.reject(failure);
  if (predicate()) return Promise.resolve();
  const result = new Promise((resolve, reject) => waiters.add({predicate, resolve, reject}));void result.catch(() => {});return result;
};
const deadline = setTimeout(() => fail(new Error("Native approval options acceptance exceeded its deadline.")), 120_000);
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
  runner = new RunnerConnection({config, runnerVersion: "native-approval-options-acceptance", harnessSessions: manager});
  await runner.connect();await wait(() => ready);passed.push("actual-public-websocket-sdk");
  const base = {workspace_id: "current", cwd, provider_instance_id: "codex", driver_kind: "codex", execution_profile: "interactive",
    sandbox_mode: "workspace_write", approval_policy: "auto_edits", continue_session: false, model_selection: {model}, mcp_servers: []};
  const categories = enabled => ({sandbox_escalation: enabled, execution_rules: enabled, skill_execution: enabled,
    permission_requests: enabled, mcp_elicitation: enabled});
  for (const [name, prompt_categories] of [["reject-all", categories(false)], ["allow-all-prompts", categories(true)],
    ["mixed", {...categories(false), execution_rules: true, mcp_elicitation: true}]]) {
    const session_id = name, start = {...base, session_id, continuation_group_key: `${name}-conversation`, approval_options: {prompt_categories}};
    const configured = await startSession(start);
    const observed = configured.find(event => event.event_type === "session.configured").data.native_policy_readback;
    assert.deepEqual(observed.approval_options, start.approval_options);assert.equal(observed.approval_policy, "auto_edits");
    assert.equal(configured.some(event => event.turn_id), false);
    passed.push(`native-${name}-category-readback`, `native-${name}-no-model-start`);
    if (name === "mixed") {
      const result = await sendTurn({session_id, turn_id: "model", input: "Reply FILTER_SETTINGS_READY only. Use no tools, agents or goal."});
      assert.equal(result.at(-1)?.event_type, "turn.completed");
      assert.deepEqual(result.find(event => event.event_type === "settings.effective").data.approval_options, start.approval_options);
      passed.push("native-model-preserves-prompt-filter");
    }
    await stopSession(session_id);passed.push(`native-${name}-unload`);
    await assert.rejects(startSession({...start, session_id: `${name}-changed`, continue_session: true,
      approval_options: {prompt_categories: {...prompt_categories, sandbox_escalation: !prompt_categories.sandbox_escalation}}}), /policy changed|original configuration scope/);
    passed.push(`native-${name}-changed-filter-refused`);
    const resumed = await startSession({...start, session_id: `${name}-resumed`, continue_session: true});
    assert.deepEqual(resumed.find(event => event.event_type === "session.configured").data.native_policy_readback.approval_options, start.approval_options);
    await stopSession(`${name}-resumed`);passed.push(`native-${name}-exact-filter-resume`);
  }
  assert.equal(manager.activeSessionCount(), 0);
  console.log(JSON.stringify({driver: "codex", scenario: "native-public-approval-options", passed, private_workspace: root}));
} finally {
  clearTimeout(deadline);if (runner) await runner.close();await manager.close();
  for (const socket of server.clients) socket.terminate();await new Promise(resolve => server.close(resolve));
}
