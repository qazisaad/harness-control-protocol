import assert from "node:assert/strict";
import {mkdtemp, realpath} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {WebSocketServer} from "ws";
import {HcpHostConnection, projectHcpNativePhases} from "@harness-control/sdk";
import {RunnerConnection} from "@harness-control/runner/connection";
import {HarnessSessionManager} from "@harness-control/runner/harnesses";
import {RunnerConfigSchema} from "@harness-control/runner/config";

if (process.env.HCP_NATIVE_LIVE !== "1") throw new Error("Set HCP_NATIVE_LIVE=1 for native permission-rejection acceptance.");
const root = await realpath(await mkdtemp(join(tmpdir(), "hcp-native-permission-prompting-")));
const cwd = root;
const server = new WebSocketServer({host: "127.0.0.1", port: 0});
await new Promise(resolve => server.once("listening", resolve));
const config = RunnerConfigSchema.parse({runner_id: "native-tool-selection", control_plane_url: `ws://127.0.0.1:${server.address().port}`,
  workspaces: [{id: "current", path: cwd}], provider_instances: [{id: "claude", driver_kind: "claude",
    ...(process.env.HCP_LIVE_CLAUDE_EXECUTABLE ? {executable_path: process.env.HCP_LIVE_CLAUDE_EXECUTABLE} : {})}]});
const manager = new HarnessSessionManager(config);
const events = [], waiters = new Set();let peer, ready = false, failure, runner;
const fail = error => {failure = error;for (const waiter of waiters) waiter.reject(error);waiters.clear();};
const wait = predicate => {
  if (failure) return Promise.reject(failure);
  if (predicate()) return Promise.resolve();
  const result = new Promise((resolve, reject) => waiters.add({predicate, resolve, reject}));void result.catch(() => {});return result;
};
const deadline = setTimeout(() => fail(new Error("Native tool selection acceptance exceeded its deadline.")), 120_000);
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
  const abort = new AbortController(), configured = peer.waitForSessionEvent(payload.session_id,
    event => event.event_type === "session.configured", {signal: abort.signal});void configured.catch(() => {});
  try {await peer.startSession(payload);await configured;} finally {abort.abort();}
  return events.filter(event => event.session_id === payload.session_id);
};
const sendTurn = async payload => {
  const abort = new AbortController(), terminal = peer.waitForSessionEvent(payload.session_id,
    event => event.turn_id === payload.turn_id && ["turn.completed", "turn.failed", "turn.cancelled", "turn.aborted"].includes(event.event_type),
    {signal: abort.signal});void terminal.catch(() => {});
  try {await peer.sendTurn(payload);await terminal;} finally {abort.abort();}
  return events.filter(event => event.session_id === payload.session_id && event.turn_id === payload.turn_id);
};
const stopSession = async session_id => {
  const abort = new AbortController(), exited = peer.waitForSessionEvent(session_id, event => event.event_type === "session.exited", {signal: abort.signal});
  void exited.catch(() => {});
  try {await peer.stopSession({session_id});await exited;} finally {abort.abort();}
};
const passed = [];
try {
  const status = (await manager.providerDriverStatuses()).find(provider => provider.driver_kind === "claude");
  assert.equal(status?.installed, true);assert.match(status?.version ?? "", /2\.1\.289/);
  const model = process.env.HCP_LIVE_CLAUDE_MODEL ?? "claude-haiku-4-5";
  runner = new RunnerConnection({config, runnerVersion: "native-tool-selection-acceptance", harnessSessions: manager});
  await runner.connect();await wait(() => ready);passed.push("actual-public-websocket-sdk");
  const base = {workspace_id: "current", cwd, provider_instance_id: "claude", driver_kind: "claude", execution_profile: "interactive",
    sandbox_mode: "danger_full_access", approval_policy: "ask", approval_options: {permission_prompting: "reject_unapproved"}, continue_session: false, model_selection: {model}, mcp_servers: []};
  await assert.rejects(peer.startSession({...base, session_id: "unsupported", tool_selection: {native_builtin_tools: ["Bash"]}}), /builtin tool selection/);
  passed.push("unsupported-selection-refused-before-launch");
  await assert.rejects(peer.startSession({...base, session_id: "bypass", approval_policy: "full_access"}), /matching authority/);
  await assert.rejects(peer.startSession({...base, session_id: "automatic", approval_reviewer: "native_auto"}), /matching authority/);
  passed.push("native-bypass-conflict-refused", "automatic-review-conflict-refused");
  for (const [name, native_builtin_tools] of [["read-only", ["Read", "Glob", "Grep"]], ["no-builtins", []]]) {
    const session_id = name, start = {...base, session_id, continuation_group_key: `${name}-conversation`, tool_selection: {native_builtin_tools}};
    await startSession(start);
    const configured = events.find(event => event.session_id === session_id && event.event_type === "session.configured");
    assert.equal(configured.data.native_policy_readback.source, "native");
    assert.deepEqual(configured.data.native_policy_readback.approval_options, base.approval_options);
    assert.equal(configured.data.native_policy_readback.approval_policy, "ask");
    assert.equal(events.some(event => event.session_id === session_id && event.event_type === "settings.tools.effective"), false);
    const read = async (owner, turn_id) => {
      const result = await sendTurn({session_id: owner, turn_id, input: "/goal"});
      assert.equal(result.at(-1)?.event_type, "turn.completed");
      const effective = result.find(event => event.event_type === "settings.tools.effective").data;
      assert.deepEqual([...effective.tool_selection.native_builtin_tools].sort(), [...native_builtin_tools].sort());
      assert.equal(effective.source, "native");assert.equal(effective.scope, "root");
      const admitted = result.find(event => event.event_type === "native.execution.admitted").data;
      const completed = result.find(event => event.event_type === "native.execution.completed").data;
      assert.equal(effective.native_reference, admitted.native_reference);
      assert.equal(completed.admission_id, admitted.admission_id);assert.equal(completed.native_execution_reference, admitted.native_execution_reference);
      assert.equal(completed.status, "completed");
      const phases = projectHcpNativePhases(result, owner, turn_id);
      assert.equal(phases.length, 1);assert.equal(phases[0].native_execution_reference, admitted.native_execution_reference);
      assert.equal(phases[0].native_reference, effective.native_reference);assert.equal(phases[0].origin_turn_id, turn_id);
      assert.equal(phases[0].status, "completed");assert.ok(phases[0].admitted_at);assert.ok(phases[0].completed_at);
      assert.ok(result.filter(event => event.event_type === "context.updated").every(event => event.data.status === "unavailable"));
      assert.equal(result.some(event => event.event_type === "native.goal.updated"), false);
    };
    await read(session_id, `${name}-read`);
    passed.push(`native-${name}-exact-builtin-readback`, `native-${name}-owned-phase-terminal`, `native-${name}-no-model-context`, `native-${name}-no-goal-job-claim`);
    await stopSession(session_id);passed.push(`native-${name}-unload`);
    await assert.rejects(startSession({...start, session_id: `${name}-changed`, continue_session: true,
      tool_selection: {native_builtin_tools: native_builtin_tools.length ? [] : ["Read"]}}), /policy changed|original configuration scope/);
    passed.push(`native-${name}-changed-selection-refused`);
    const {approval_options: _options, ...withoutRejection} = start;
    await assert.rejects(startSession({...withoutRejection, session_id: `${name}-prompting-changed`, continue_session: true}), /policy changed|original configuration scope/);
    passed.push(`native-${name}-permission-rejection-removal-refused`);
    await startSession({...start, session_id: `${name}-resumed`, continue_session: true});
    await read(`${name}-resumed`, `${name}-resumed-read`);await stopSession(`${name}-resumed`);
    passed.push(`native-${name}-same-selection-resume-read`);
  }
  assert.equal(manager.activeSessionCount(), 0);
  passed.push("public-native-phase-projection", "native-permission-rejection-startup-readback");
  console.log(JSON.stringify({driver: "claude", scenario: "native-public-permission-rejection", passed, private_workspace: root}));
} finally {
  clearTimeout(deadline);if (runner) await runner.close();await manager.close();
  for (const socket of server.clients) socket.terminate();await new Promise(resolve => server.close(resolve));
}
