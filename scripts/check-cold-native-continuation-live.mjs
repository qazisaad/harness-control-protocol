// Opt-in durable cold continuation using Claude's local /goal read command.
import assert from "node:assert/strict";
import {mkdtemp, realpath} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {setTimeout as delay} from "node:timers/promises";
import {WebSocketServer} from "ws";
import {HcpHostConnection, HcpNativeSessions} from "@harness-control/sdk";
import {HarnessSessionManager} from "@harness-control/runner/harnesses";
import {RunnerConnection} from "@harness-control/runner/connection";
import {RunnerConfigSchema} from "@harness-control/runner/config";
import {JsonRunnerStateStore} from "@harness-control/runner/state";
if (process.env.HCP_NATIVE_LIVE !== "1") throw new Error("Set HCP_NATIVE_LIVE=1 for controlled public Claude policy acceptance.");
const cwd = await realpath(await mkdtemp(join(tmpdir(), "hcp-native-claude-policy-control-"))), passed = [], events = [];
const server = new WebSocketServer({host: "127.0.0.1", port: 0}); await new Promise(resolve => server.once("listening", resolve));
let peer, owners, runner, failure, ready = false;
server.on("connection", socket => {
  peer = new HcpHostConnection({send(message) {socket.send(JSON.stringify(message));}}); owners = new HcpNativeSessions(peer);
  socket.on("message", raw => {try {
    const observation = peer.receive(raw.toString());
    if (observation.message.type === "host.hello") peer.accept({protocol_version: "hcp.v0", heartbeat_interval_seconds: 30});
    if (observation.message.type === "host.capabilities.updated") ready = true;
    if (observation.message.type === "harness.event") {
      if (!["applied", "duplicate"].includes(observation.reduction.outcome)) throw new Error("Native policy observation continuity changed.");
      events.push(observation.message.payload);
    }
  } catch (error) {failure = error; socket.close();}}); socket.on("close", () => peer.disconnect());
});
const until = async predicate => {const deadline = Date.now() + 90000; while (!predicate()) {
  if (failure) throw failure; if (Date.now() > deadline) throw new Error("Native policy acceptance timed out."); await delay(20);
}};
const config = RunnerConfigSchema.parse({runner_id: "native-claude-policy", control_plane_url: `ws://127.0.0.1:${server.address().port}`,
  workspaces: [{id: "workspace", path: cwd}], provider_instances: [{id: "claude", driver_kind: "claude",
    ...(process.env.HCP_LIVE_CLAUDE_EXECUTABLE ? {executable_path: process.env.HCP_LIVE_CLAUDE_EXECUTABLE} : {})}]});
const state = new JsonRunnerStateStore(join(cwd, "state.json")), manager = new HarnessSessionManager(config, {stateStore: state});
try {
  const status = (await manager.providerDriverStatuses()).find(provider => provider.driver_kind === "claude"); assert.match(status.version, /2\.1\.289/);
  assert.equal(status.execution_capabilities.execution_profiles.find(profile => profile.id === "interactive").native_policy_control, "idle_native_owner");
  passed.push("declared-in-place-policy-control"); const model = status.models.find(model => model.is_default)?.id ?? status.models[0]?.id; assert.ok(model);
  runner = new RunnerConnection({config, runnerVersion: "native-policy-acceptance", harnessSessions: manager, stateStore: state}); await runner.connect(); await until(() => ready);
  const start = {session_id: "policy", workspace_id: "workspace", cwd, provider_instance_id: "claude", driver_kind: "claude", execution_profile: "interactive",
    model_selection: {model}, sandbox_mode: "danger_full_access", approval_policy: "ask", continue_session: false, continuation_group_key: "fixture", mcp_servers: [],
    policy_control_authority: {allowed_selections: ["ask", "auto_edits", "full_access"].map(approval_policy => ({approval_policy, approval_reviewer: "user"}))},
    configuration_inheritance: {user_settings: false, project_settings: false, hooks: false, mcp_servers: false, plugins: false}};
  await owners.open(start, {readiness: "configured"}); const run = async turn_id => {
    await peer.sendTurn({session_id: "policy", turn_id, input: "/goal"});
    await until(() => events.some(event => event.turn_id === turn_id && ["turn.completed", "turn.failed", "turn.cancelled"].includes(event.event_type)));
    assert.equal(events.findLast(event => event.turn_id === turn_id && ["turn.completed", "turn.failed", "turn.cancelled"].includes(event.event_type)).event_type, "turn.completed");
  };
  await run("initial"); const nativeId = state.getNativeConversation("fixture").native_thread_id; assert.ok(nativeId);
  const initialBinding = state.nativeWorkState("policy").scope.execution_binding_hash; passed.push("initial-ask-owner-and-local-command");
  await owners.close("policy");assert.equal(owners.state("policy").phase, "closed");passed.push("original-owner-confirmed-closed");
  owners.dispose();owners = new HcpNativeSessions(peer);
  await assert.rejects(owners.open({...start, session_id: "wrong-reference", continue_session: true,
    expected_native_reference: "foreign-native-reference"}, {readiness: "configured"}), error => error.outcome === "rejected");
  assert.equal(state.getNativeConversation("fixture").native_thread_id, nativeId);
  assert.ok(!events.some(event => event.session_id === "wrong-reference" && event.event_type === "turn.started"));
  passed.push("wrong-saved-reference-refused-before-model-dispatch");
  owners.dispose();owners = new HcpNativeSessions(peer);
  const restored = await owners.open({...start, session_id: "restored", continue_session: true,
    expected_native_reference: nativeId}, {readiness: "configured"});
  assert.ok(["reserved", "active"].includes(restored.phase));passed.push("new-sdk-registry-restores-durable-conversation");
  await peer.sendTurn({session_id: "restored", turn_id: "restored-local", input: "/goal"});
  await until(() => events.some(event => event.turn_id === "restored-local" && ["turn.completed", "turn.failed", "turn.cancelled"].includes(event.event_type)));
  assert.equal(events.findLast(event => event.turn_id === "restored-local" && ["turn.completed", "turn.failed", "turn.cancelled"].includes(event.event_type)).event_type, "turn.completed");
  assert.equal(owners.state("restored").configured.data.native_reference, nativeId);
  assert.equal(state.getNativeConversation("fixture").native_thread_id, nativeId);passed.push("actual-native-local-command-preserves-saved-identity");
  await owners.close("restored");assert.equal(owners.state("restored").phase, "closed");passed.push("restored-owner-confirmed-closed");
  console.log(JSON.stringify({driver: "claude", version: status.version, scope: "public-sdk-cold-continuation", passed}));
} finally {owners?.dispose(); await runner?.close(); await manager.close(); for (const socket of server.clients) socket.terminate(); await new Promise(resolve => server.close(resolve));}
