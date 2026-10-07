import assert from "node:assert/strict";
import {mkdtemp, mkdir, realpath, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {WebSocketServer} from "ws";
import {HcpHostConnection} from "@harness-control/sdk";
import {harnessNativeRequestIdentitySchema, harnessApprovalRequestedEventDataSchema} from "@harness-control/protocol";
import {RunnerConnection} from "@harness-control/runner/connection";
import {RunnerConfigSchema} from "@harness-control/runner/config";
import {HarnessSessionManager} from "@harness-control/runner/harnesses";
import {JsonRunnerStateStore} from "@harness-control/runner/state";

if (process.env.HCP_OPENCODE_ORDERED_PERMISSIONS_LIVE !== "1") throw new Error("Set HCP_OPENCODE_ORDERED_PERMISSIONS_LIVE=1 for isolated ordered native policy acceptance.");
const cwd = await realpath(await mkdtemp(join(tmpdir(), "hcp-opencode-ordered-policy-")));
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
        assert.equal(event.turn_id, "read-env");
        const request = harnessApprovalRequestedEventDataSchema.parse(event.data);
        const identity = harnessNativeRequestIdentitySchema.parse(request.native_request);
        assert.ok(identity.request_reference);assert.ok(identity.call_reference);assert.notEqual(identity.request_reference, request.request_id);
        assert.equal(request.allowed_decisions.includes("accept_for_session"), false);
        stage = "native-permission-request";
        const reply = peer.respondToApproval({session_id: event.session_id, turn_id: event.turn_id, request_id: request.request_id,
          actor_id: "native-acceptance", action_hash: request.action_hash, decision: "accept"});
        replies.push(reply);void reply.catch(error => {observationFailure = error;});
      }
    }
  } catch (error) {observationFailure = error;failReady(error);}});
});
const selected = [
  {permission: "*", pattern: "*", action: "deny"},
  {permission: "read", pattern: "*", action: "allow"},
  {permission: "read", pattern: "*.env", action: "ask"},
  {permission: "read", pattern: "*.env.example", action: "allow"},
  {permission: "task", pattern: "*", action: "deny"},
];
const base = {workspace_id: "workspace", cwd, provider_instance_id: "opencode", driver_kind: "opencode", execution_profile: "interactive",
  configuration_inheritance: {user_settings: false, project_settings: false, hooks: false, mcp_servers: false, plugins: false},
  model_selection: {model: process.env.HCP_LIVE_OPENCODE_MODEL ?? "opencode/space-bunny-free"}, sandbox_mode: "danger_full_access", approval_policy: "ask", continue_session: false, mcp_servers: []};
let stage = "connecting";
const checks = [];
const start = async payload => {
  const controller = new AbortController();
  const proof = peer.waitForSessionEvent(payload.session_id, event => event.event_type === "session.configured", {signal: controller.signal, timeoutMs: 30_000});
  void proof.catch(() => {});
  try {
    await peer.startSession(payload);const readback = (await proof).data.native_policy_readback;
    assert.equal(readback.source, "native");assert.deepEqual(readback.approval_options, payload.approval_options);
    assert.equal(events.some(event => event.session_id === payload.session_id && event.event_type === "native.execution.admitted"), false);
  } finally {controller.abort();}
};
const stop = async session_id => {
  const proof = peer.waitForSessionEvent(session_id, event => event.event_type === "session.exited", {timeoutMs: 30_000});void proof.catch(() => {});
  await peer.stopSession({session_id});await proof;
};
try {
  runner = new RunnerConnection({config, runnerVersion: "0.5.0-ordered-native-acceptance", harnessSessions: manager});
  await runner.connect();await connected;
  const payload = {...base, session_id: "ordered", continuation_group_key: "ordered-native-owner", approval_options: {permission_rules: selected}};
  stage = "startup";await start(payload);checks.push("exact-ordered-native-startup", "no-model-startup");
  const retained = stateStore.getNativeConversation(payload.continuation_group_key);
  assert.deepEqual(retained.approval_options, payload.approval_options);checks.push("retained-complete-policy");
  if (process.env.HCP_OPENCODE_ORDERED_PERMISSION_TOOL_LIVE === "1") {
    stage = "tool-dispatch";
    const completed = peer.waitForSessionEvent("ordered", event => event.turn_id === "read-env" && ["turn.completed", "turn.failed", "turn.cancelled"].includes(event.event_type), {timeoutMs: 120_000});
    void completed.catch(() => {});
    await peer.sendTurn({session_id: "ordered", turn_id: "read-env", input: `Use read exactly once to read ${join(cwd, "toy.env")}. Use no other tools. After approval, reply with the toy marker in that file and stop.`});
    assert.equal((await completed).event_type, "turn.completed");await Promise.all(replies);
    const request = events.find(event => event.turn_id === "read-env" && event.event_type === "approval.requested");assert.ok(request, "No actual path-matching native permission request.");
    const page = await peer.readConversationPageComplete("ordered", {limit: 100});
    assert.ok(page.turns.some(turn => turn.portable_items?.some(item => item.item.type === "tool_call" && JSON.stringify(item.values).includes("toy.env"))), "No complete native read-tool arguments.");
    assert.ok(events.some(event => event.turn_id === "read-env" && event.event_type === "item.completed" && event.data.item_type === "tool_call" && event.data.status === "completed"));
    assert.ok(events.some(event => event.turn_id === "read-env" && event.event_type === "native.execution.completed" && event.data.status === "completed"));
    checks.push("native-path-rule-request", "exact-native-request-identity", "public-once-reply", "actual-read-tool-completion", "native-root-terminal");
  }
  await stop("ordered");checks.push("confirmed-unload");
  await assert.rejects(peer.startSession({...payload, session_id: "changed", continue_session: true,
    approval_options: {permission_rules: selected.map((rule, i) => i === 2 ? {...rule, action: "allow"} : rule)}}));checks.push("changed-rule-resume-refused");
  await start({...payload, session_id: "resumed", continue_session: true});checks.push("same-policy-resume");
  await stop("resumed");
  const history = await peer.readConversation("resumed", {limit: 100});assert.ok(history.payload.history);checks.push("retained-policy-history-read");
  for (const change of [{execution_profile: "background", approval_options: {permission_rules: selected.map((rule, index) => index === 0 ? {...rule, action: "ask"} : rule)}}, {approval_policy: "full_access"}, {approval_reviewer: "native_auto"},
    {configuration_inheritance: {user_settings: true, project_settings: true, hooks: true, mcp_servers: true, plugins: true}},
    {approval_options: {permission_rules: [{permission: "*", pattern: "*", action: "allow"}]}}])
    await assert.rejects(peer.startSession({...payload, session_id: "unsupported", continuation_group_key: "unsupported", ...change}));
  checks.push("unseeded-background-policy-refused", "bypass-policy-refused", "automatic-review-refused", "inherited-policy-refused", "unowned-task-policy-refused");
  if (observationFailure) throw observationFailure;
  console.log(JSON.stringify({driver: "opencode", version: "1.18.34", cwd, passed: checks}));
} catch (error) {
  console.log(JSON.stringify({driver: "opencode", stage, observationFailure: observationFailure?.name,
    observations: events.map(event => ({type: event.event_type, origin: event.turn_id,
      ...(event.event_type === "item.completed" ? {status: event.data.status, kind: event.data.item_type} : {})}))}));
  throw error;
} finally {
  try {await runner?.close();} finally {for (const socket of server.clients) socket.terminate();await new Promise(resolve => server.close(resolve));}
}
