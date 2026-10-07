import assert from "node:assert/strict";
import {mkdtemp, mkdir, realpath, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {WebSocketServer} from "ws";
import {HcpHostConnection} from "@harness-control/sdk";
import {harnessNativeRequestIdentitySchema, harnessApprovalRequestedEventDataSchema, isNativeWorkTerminal} from "@harness-control/protocol";
import {RunnerConnection} from "@harness-control/runner/connection";
import {RunnerConfigSchema} from "@harness-control/runner/config";
import {HarnessSessionManager} from "@harness-control/runner/harnesses";
import {JsonRunnerStateStore} from "@harness-control/runner/state";

if (process.env.HCP_OPENCODE_ORDERED_CHILD_POLICY_LIVE !== "1") throw new Error("Set HCP_OPENCODE_ORDERED_CHILD_POLICY_LIVE=1 for isolated ordered child policy acceptance.");
const cwd = await realpath(await mkdtemp(join(tmpdir(), "hcp-opencode-ordered-child-policy-")));
for (const name of ["home", "data", "state", "cache", "config"]) await mkdir(join(cwd, name));
await writeFile(join(cwd, "toy.env"), "HCP_TOY_MARKER=ORDERED_NATIVE_READ\n");
const config = RunnerConfigSchema.parse({runner_id: "native-ordered-policy", control_plane_url: "ws://127.0.0.1:1",
  workspaces: [{id: "workspace", path: cwd}], provider_instances: [{id: "opencode", driver_kind: "opencode",
    executable_path: process.env.HCP_LIVE_OPENCODE_EXECUTABLE ?? "/tmp/hcp-native-acceptance-tools/node_modules/.bin/opencode",
    env: {HOME: join(cwd, "home"), USERPROFILE: join(cwd, "home"), XDG_DATA_HOME: join(cwd, "data"),
      XDG_STATE_HOME: join(cwd, "state"), XDG_CACHE_HOME: join(cwd, "cache"), XDG_CONFIG_HOME: join(cwd, "config"), OPENCODE_AUTH_CONTENT: "{}", OPENCODE_API_KEY: ""}}]});
const server = new WebSocketServer({host: "127.0.0.1", port: 0});
await new Promise((resolve, reject) => {server.once("listening", resolve);server.once("error", reject);});
config.control_plane_url = `ws://127.0.0.1:${server.address().port}`;
const stateStore = new JsonRunnerStateStore(join(cwd, "hcp-state.json"));
const manager = new HarnessSessionManager(config, {stateStore});
let peer, runner;
let ready, failReady;
const connected = new Promise((resolve, reject) => {ready = resolve;failReady = reject;});
const events = [], replies = [];
let observationFailure;
server.on("connection", socket => {
  peer = new HcpHostConnection({send: message => socket.send(JSON.stringify(message))});
  socket.on("close", () => peer.disconnect());
  socket.on("message", raw => {try {
    const result = peer.receive(raw.toString());
    if (result.message.type === "host.hello") peer.accept({protocol_version: "hcp.v0", heartbeat_interval_seconds: 30});
    if (result.message.type === "host.capabilities.updated") ready();
    if (result.message.type === "harness.event" && result.reduction.outcome !== "duplicate") {
      assert.equal(result.reduction.outcome, "applied");events.push(result.message.payload);
      const event = result.message.payload;
      if (event.event_type === "approval.requested") {
        assert.equal(event.turn_id, "child-origin");
        const request = harnessApprovalRequestedEventDataSchema.parse(event.data);
        assert.ok(request.native_work_id, "The requested read was not owned by the native child.");
        const identity = harnessNativeRequestIdentitySchema.parse(request.native_request);
        assert.ok(identity.request_reference);assert.ok(identity.call_reference);assert.ok(identity.execution_reference);
        assert.notEqual(identity.request_reference, request.request_id);assert.equal(request.allowed_decisions.includes("accept_for_session"), false);
      }
    }
  } catch (error) {observationFailure = error;failReady(error);}});
});

const selected = [
  {permission: "*", pattern: "*", action: "deny"},
  {permission: "read", pattern: "*", action: "allow"},
  {permission: "read", pattern: "*.env", action: "ask"},
  {permission: "task", pattern: "*", action: "allow"},
];
let stage = "connecting", primaryFailure = false;
const lifetime = new AbortController();
const observe = predicate => {
  const promise = peer.waitForSessionEvent("owned", predicate, {signal: lifetime.signal, timeoutMs: 120_000});void promise.catch(() => {});return promise;
};
const send = async (turn_id, input) => {
  const finished = observe(event => event.turn_id === turn_id && ["turn.completed", "turn.failed", "turn.cancelled"].includes(event.event_type));
  await peer.sendTurn({session_id: "owned", turn_id, input});assert.equal((await finished).event_type, "turn.completed");
};
const checks = [];
try {
  runner = new RunnerConnection({config, runnerVersion: "0.5.0-ordered-child-acceptance", harnessSessions: manager});
  await runner.connect();await connected;
  stage = "startup";
  const configured = observe(event => event.event_type === "session.configured");
  const base = {session_id: "owned", continuation_group_key: "owned-child-policy", workspace_id: "workspace", cwd,
    provider_instance_id: "opencode", driver_kind: "opencode", execution_profile: "background",
    configuration_inheritance: {user_settings: false, project_settings: false, hooks: false, mcp_servers: false, plugins: false},
    model_selection: {model: process.env.HCP_LIVE_OPENCODE_MODEL ?? "opencode/space-bunny-free"}, approval_policy: "ask", sandbox_mode: "danger_full_access",
    approval_options: {permission_rules: selected}, continue_session: false, mcp_servers: []};
  await peer.startSession(base);assert.deepEqual((await configured).data.native_policy_readback.approval_options, base.approval_options);
  checks.push("complete-background-root-readback", "no-model-startup");
  stage = "child-launch";
  const requested = observe(event => event.event_type === "approval.requested" && event.turn_id === "child-origin" && !!event.data.native_work_id);
  const terminal = observe(event => event.event_type === "native.work.updated" && event.data.work.kind === "agent" && event.data.work.origin_turn_id === "child-origin" && isNativeWorkTerminal(event.data.work.status));
  const wakeTerminal = observe(event => event.event_type === "native.work.updated" && event.data.work.kind === "task" && event.data.work.origin_turn_id === "child-origin" && isNativeWorkTerminal(event.data.work.status));
  await send("child-origin", `Use task exactly once with background=true and subagent_type=general. Child prompt: Use read exactly once to read ${join(cwd, "toy.env")}. Use no other tools. After approval reply with the toy marker and stop. After launching reply PARENT_ONLY. Do not wait or poll.`);
  const approval = await requested;
  stage = "newer-root";
  await send("newer-root", "Reply NEW_ROOT_ONLY. Use no tools, tasks, waiting or polling.");
  const request = harnessApprovalRequestedEventDataSchema.parse(approval.data);
  const pending = await peer.readNativeWorkInventory("owned");
  const child = pending.items.find(item => item.work.work_id === request.native_work_id);assert.ok(child);
  assert.equal(child.work.origin_turn_id, "child-origin");assert.equal(child.work.kind, "agent");assert.equal(child.work.background, true);
  assert.equal(request.native_request.native_reference, child.work.native_reference);
  checks.push("actual-native-background-child", "child-read-path-request", "exact-child-request-identity", "original-child-origin-after-newer-root", "one-shot-only-child-decisions");
  stage = "child-reply";
  const response = {session_id: "owned", turn_id: "child-origin", request_id: request.request_id, action_hash: request.action_hash, actor_id: "native-acceptance"};
  await assert.rejects(peer.respondToApproval({...response, turn_id: "newer-root", decision: "accept"}));
  await assert.rejects(peer.respondToApproval({...response, decision: "accept_for_session"}));
  await peer.respondToApproval({...response, decision: "accept"});
  checks.push("newer-root-reply-refused", "remembered-child-grant-refused", "original-one-shot-child-reply");
  stage = "child-terminal";
  const completed = await terminal;assert.equal(completed.data.work.status, "completed");
  assert.equal(completed.data.work.work_id, child.work.work_id);await wakeTerminal;
  checks.push("exact-native-child-terminal", "native-parent-wake-terminal");
  stage = "child-history";
  const roster = await peer.readNativeWorkInventory("owned");const ended = roster.items.find(item => item.work.work_id === child.work.work_id);assert.ok(ended);
  const history = await peer.readNativeWorkHistoryPageComplete("owned", ended.work.work_id, ended.work.revision, {limit: 100});
  assert.ok(history.history.turns.some(turn => turn.portable_items?.some(item => item.item.type === "tool_call" && JSON.stringify(item.values).includes("toy.env"))));
  assert.ok(JSON.stringify(history.history.turns).includes("ORDERED_NATIVE_READ"));
  checks.push("owned-child-complete-read-history", "actual-child-read-result");
  stage = "unload";
  const exit = observe(event => event.event_type === "session.exited");await peer.stopSession({session_id: "owned"});await exit;
  checks.push("confirmed-unload");
  const retained = await peer.readNativeWorkInventory("owned");const row = retained.items.find(item => item.work.work_id === child.work.work_id);assert.ok(row);
  const retainedHistory = await peer.readNativeWorkHistoryPageComplete("owned", row.work.work_id, row.work.revision, {limit: 100}, {owner: "retained"});
  assert.equal(retainedHistory.history.source.history_hash, history.history.source.history_hash);checks.push("retained-child-history-after-unload");
  if (observationFailure) throw observationFailure;
  console.log(JSON.stringify({driver: "opencode", version: "1.18.34", cwd, passed: checks}));
} catch (error) {
  primaryFailure = true;
  console.log(JSON.stringify({driver: "opencode", stage, observationFailure: observationFailure?.name,
    observations: events.map(event => ({type: event.event_type, origin: event.turn_id,
      ...(event.event_type === "runtime.warning" ? {code: event.data.code} : {}),
      ...(event.event_type === "native.work.updated" ? {kind: event.data.work.kind, status: event.data.work.status} : {})}))}));
  throw error;
} finally {
  lifetime.abort();try {try {await runner?.close();} catch (error) {if (!primaryFailure) throw error;console.log(JSON.stringify({cleanup_error_code: error.code ?? "cleanup_failed"}));}} finally {for (const socket of server.clients) socket.terminate();await new Promise(resolve => server.close(resolve));}
}
