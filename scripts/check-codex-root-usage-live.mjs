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
const root = await realpath(await mkdtemp(join(tmpdir(), "hcp-native-root-usage-")));
const cwd = root;
const server = new WebSocketServer({host: "127.0.0.1", port: 0});
await new Promise(resolve => server.once("listening", resolve));
const config = RunnerConfigSchema.parse({runner_id: "native-root-usage", control_plane_url: `ws://127.0.0.1:${server.address().port}`,
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
const deadline = setTimeout(() => fail(new Error("Native root usage acceptance exceeded its deadline.")), 120_000);
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
  runner = new RunnerConnection({config, runnerVersion: "native-root-usage-acceptance", harnessSessions: manager});
  await runner.connect();await wait(() => ready);passed.push("actual-public-websocket-sdk");
  const base = {session_id: "accounting", continuation_group_key: "accounting-conversation", workspace_id: "current", cwd,
    provider_instance_id: "codex", driver_kind: "codex", execution_profile: "interactive", sandbox_mode: "workspace_write",
    approval_policy: "auto_edits", continue_session: false, model_selection: {model}, mcp_servers: []};
  await startSession(base);
  for (const [turn_id, expectedStatus] of [["fresh", "complete"], ["followup", "partial"]]) {
    const result = await sendTurn({session_id: base.session_id, turn_id, input: "Reply ACCOUNTING_READY only. Use no tools, agents or goal."});
    assert.equal(result.at(-1)?.event_type, "turn.completed");
    const roots = result.filter(event => event.event_type === "usage.updated" && event.data.actor === "root");
    assert.equal(roots.length, 1);const usage = roots[0].data;
    const admission = result.find(event => event.event_type === "native.execution.admitted").data;
    assert.equal(usage.native_reference, admission.native_reference);
    assert.equal(usage.native_execution_reference, admission.native_execution_reference);
    assert.equal(usage.scope, "turn");assert.equal(usage.status, expectedStatus);
    assert.ok(Number.isSafeInteger(usage.input_tokens));assert.ok(usage.input_tokens > 0);
    assert.ok(Number.isSafeInteger(usage.output_tokens));assert.ok(usage.output_tokens > 0);
    assert.equal(usage.total_tokens, usage.input_tokens + usage.output_tokens);
    assert.ok(usage.cached_input_tokens <= usage.input_tokens);assert.ok(usage.reasoning_output_tokens <= usage.output_tokens);
    const aggregate = result.find(event => event.event_type === "usage.updated" && event.data.scope === "conversation").data;
    assert.ok(aggregate.total_tokens >= usage.total_tokens);
    assert.ok(result.some(event => event.event_type === "context.updated" && event.data.status === "measured"));
    passed.push(`native-${turn_id}-root-billing`, `native-${turn_id}-physical-execution`, `native-${turn_id}-context-and-aggregate-separate`);
  }
  await stopSession(base.session_id);passed.push("confirmed-unload");
  assert.equal(manager.activeSessionCount(), 0);
  console.log(JSON.stringify({driver: "codex", scenario: "native-public-root-usage", passed, private_workspace: root}));
} finally {
  clearTimeout(deadline);if (runner) await runner.close();await manager.close();
  for (const socket of server.clients) socket.terminate();await new Promise(resolve => server.close(resolve));
}
