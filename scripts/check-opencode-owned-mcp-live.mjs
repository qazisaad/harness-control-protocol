import assert from "node:assert/strict";
import {mkdtemp, mkdir, realpath} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {WebSocketServer} from "ws";
import {HcpHostConnection} from "@harness-control/sdk";
import {harnessApprovalRequestedEventDataSchema, harnessInputRequestedEventDataSchema} from "@harness-control/protocol";
import {McpProxyServer, McpInputRequiredError} from "@harness-control/runner/mcp";
import {RunnerConnection} from "@harness-control/runner/connection";
import {RunnerConfigSchema} from "@harness-control/runner/config";
import {HarnessSessionManager} from "@harness-control/runner/harnesses";

if (process.env.HCP_OPENCODE_OWNED_MCP_LIVE !== "1") throw new Error("Set HCP_OPENCODE_OWNED_MCP_LIVE=1 for isolated native public-model acceptance.");
const cwd = await realpath(await mkdtemp(join(tmpdir(), "hcp-opencode-owned-mcp-")));
for (const name of ["home", "config", "data", "state", "cache"]) await mkdir(join(cwd, name));
const env = {HOME: join(cwd, "home"), USERPROFILE: join(cwd, "home"), XDG_CONFIG_HOME: join(cwd, "config"),
  XDG_DATA_HOME: join(cwd, "data"), XDG_STATE_HOME: join(cwd, "state"), XDG_CACHE_HOME: join(cwd, "cache"),
  OPENCODE_AUTH_CONTENT: "{}", OPENCODE_API_KEY: "", OPENCODE_CONFIG_CONTENT: JSON.stringify({enabled_providers: ["opencode"],
    plugin: [], mcp: {}, instructions: [], autoupdate: false, share: "disabled"}), OPENCODE_DISABLE_PROJECT_CONFIG: "true",
  OPENCODE_PURE: "true", OPENCODE_DISABLE_DEFAULT_PLUGINS: "true", OPENCODE_DISABLE_CLAUDE_CODE: "true",
  OPENCODE_DISABLE_EXTERNAL_SKILLS: "true", OPENCODE_DISABLE_AUTOUPDATE: "true"};
const server = new WebSocketServer({host: "127.0.0.1", port: 0});
await new Promise(resolve => server.once("listening", resolve));
const config = RunnerConfigSchema.parse({runner_id: "owned-mcp-acceptance", control_plane_url: `ws://127.0.0.1:${server.address().port}`,
  workspaces: [{id: "workspace", path: cwd}], provider_instances: [{id: "opencode", driver_kind: "opencode", env,
    ...(process.env.HCP_LIVE_OPENCODE_EXECUTABLE ? {executable_path: process.env.HCP_LIVE_OPENCODE_EXECUTABLE} : {})}]});
const marker = randomUUID(), calls = [], proxies = [];
const tool = {name: "get_marker", description: "Return the selected safe marker after platform input. Call once with empty arguments.", input_schema: {type: "object", properties: {}, additionalProperties: false}, review_policy: {kind: "always"}};
const backend = {async connect() {}, async close() {}, async listTools() {return [tool];}, async callTool(name, args, grant, continuation) {
  assert.equal(name, "get_marker"); assert.deepEqual(args, {}); assert.ok(grant?.request_id); calls.push({continued: !!continuation});
  if (!continuation) throw new McpInputRequiredError({resultType: "input_required", requestState: "private-local-state", inputRequests: {
    question: {method: "elicitation/create", params: {message: "Choose the toy name", requestedSchema: {type: "object", properties: {name: {type: "string"}}, required: ["name"]}}}}});
  assert.equal(continuation.pending.requestState, "private-local-state");
  assert.deepEqual(continuation.responses, {question: {action: "accept", content: {name: "Ada"}}});
  return {is_error: false, content: [{type: "text", text: marker}], structured_content: {marker}};
}};
const manager = new HarnessSessionManager(config, {mcpClientFactory: () => {
  const proxy = new McpProxyServer({attachment: {name: "selected", allowed_tools: ["get_marker"]}, upstream: backend});proxies.push(proxy);
  return {async connect() {await proxy.connect();}, get adapterAttachment() {return proxy.adapterAttachment;}, async listTools() {return [tool];},
    async callTool(...args) {return backend.callTool(...args);}, async close() {await proxy.close();}};
}});
const events = [], waiters = new Set();
let peer, runner, rejected, heldApproval;
const replies = [], passed = [];
const nativeCalls = new Map();
const wait = predicate => {
  if (rejected) return Promise.reject(rejected);
  const existing = predicate(); if (existing) return Promise.resolve(existing);
  const result = new Promise((resolve, reject) => waiters.add({predicate, resolve, reject}));
  void result.catch(() => {}); return result;
};
const fail = error => {rejected = error; for (const waiter of waiters) waiter.reject(error); waiters.clear();};
const flush = () => {for (const waiter of waiters) {const value = waiter.predicate(); if (value) {waiters.delete(waiter); waiter.resolve(value);}}};
let ready = false;
const deadline = setTimeout(() => fail(new Error("Anonymous native acceptance exceeded its deadline.")), 180_000);
server.on("connection", socket => {
  peer = new HcpHostConnection({send: message => socket.send(JSON.stringify(message))});
  socket.on("message", raw => {try {
    const received = peer.receive(raw.toString());
    if (received.message.type === "host.hello") peer.accept({protocol_version: "hcp.v0", heartbeat_interval_seconds: 30});
    if (received.message.type === "host.capabilities.updated") ready = true;
    if (received.message.type === "harness.event") {
      if (received.reduction.outcome === "duplicate") return;
      assert.equal(received.reduction.outcome, "applied", "Native event stream requires reconciliation.");
      const event = received.message.payload; events.push(event);
      if (event.event_type === "approval.requested") {
        const request = harnessApprovalRequestedEventDataSchema.parse(event.data);
        assert.equal(request.native_request?.source, "native");assert.ok(request.native_request.call_reference);
        assert.ok(request.native_request.message_reference);assert.ok(request.native_request.item_reference);assert.ok(request.native_request.execution_reference);
        assert.equal(request.native_request.request_reference, undefined);assert.notEqual(request.request_id, request.native_request.call_reference);
        nativeCalls.set(event.turn_id, request.native_request);
        if (request.native_work_id) {assert.equal(event.turn_id, "child-root");heldApproval = event;}
        else {assert.equal(event.turn_id, "root-tool");const reply = peer.respondToApproval({session_id: "owned", turn_id: event.turn_id,
          request_id: request.request_id, action_hash: request.action_hash, actor_id: "acceptance", decision: "accept"});replies.push(reply);void reply.catch(fail);}
      }
      if (event.event_type === "input.requested") {
        const request = harnessInputRequestedEventDataSchema.parse(event.data);
        assert.deepEqual(request.native_request, nativeCalls.get(event.turn_id));
        assert.equal(request.native_work_id, event.turn_id === "child-root" ? heldApproval?.data.native_work_id : undefined);
        const reply = peer.respondToInput({session_id: "owned", turn_id: event.turn_id, request_id: request.request_id, actor_id: "acceptance",
          value: {question: {action: "accept", content: {name: "Ada"}}}});replies.push(reply);void reply.catch(fail);
      }
    }
    flush();
  } catch (error) {fail(error);}});
});

const terminal = turn => wait(() => events.find(event => event.turn_id === turn && ["turn.completed", "turn.failed", "turn.cancelled"].includes(event.event_type)));
const send = async (turn_id, input) => {const finished = terminal(turn_id);await peer.sendTurn({session_id: "owned", turn_id, input});assert.equal((await finished).event_type, "turn.completed");};
const descriptor = {name: "selected", transport: "streamable_http", url: "https://example.invalid/owned-local-acceptance-only", headers: {}, allowed_tools: ["get_marker"], lease_id: "local-fixture", expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
  proof_of_possession: {scheme: "runner_signed_request", key_id: "local-fixture", required_headers: ["x-hcp-session-id", "x-hcp-host-id", "x-hcp-proof-signature", "x-hcp-proof-nonce"]}};
let stage = "connect";
try {
  runner = new RunnerConnection({config, runnerVersion: "owned-mcp-native-acceptance", harnessSessions: manager});await runner.connect();await wait(() => ready);
  stage = "background-start";
  await peer.startSession({session_id: "owned", workspace_id: "workspace", cwd, provider_instance_id: "opencode", driver_kind: "opencode", execution_profile: "background",
    configuration_inheritance: {user_settings: false, project_settings: false, hooks: false, mcp_servers: false, plugins: false}, model_selection: {model: process.env.HCP_LIVE_OPENCODE_MODEL ?? "opencode/space-bunny-free"},
    sandbox_mode: "danger_full_access", approval_policy: "full_access", continue_session: false,
    continuation_group_key: "owned-native-child-history", mcp_servers: [descriptor]});
  stage = "root-tool";
  await send("root-tool", "Call the selected safe marker tool exactly once with empty arguments. Reply with its marker. Use no other tools.");
  assert.equal(calls.length, 2);passed.push("public-background-attachment", "native-root-review", "native-root-form", "native-root-continuation");
  stage = "child-spawn";
  await send("child-root", "Use task exactly once with background=true and subagent_type=general. Child prompt: Call the selected safe marker tool exactly once with empty arguments. Return its marker. Use no other tools. After launching immediately reply PARENT_RETURNED. Do not wait, poll, or call the marker tool yourself.");
  await wait(() => heldApproval);assert.equal(calls.length, 2);
  stage = "newer-root";
  await send("new-root", "Reply NEW_ROOT only. Use no tools.");
  passed.push("child-review-after-root-completion", "new-root-with-retained-review");
  stage = "original-child-reply";
  const approval = harnessApprovalRequestedEventDataSchema.parse(heldApproval.data);
  await assert.rejects(peer.respondToApproval({session_id: "owned", turn_id: "new-root", request_id: approval.request_id, action_hash: approval.action_hash, actor_id: "acceptance", decision: "accept"}));
  assert.equal(calls.length, 2);passed.push("new-root-cannot-adopt-child-review");
  await peer.respondToApproval({session_id: "owned", turn_id: "child-root", request_id: approval.request_id, action_hash: approval.action_hash, actor_id: "acceptance", decision: "accept"});
  stage = "child-completion";
  await wait(() => events.find(event => event.event_type === "native.work.updated" && event.data.work?.work_id === approval.native_work_id && event.data.work.status === "completed"));
  await Promise.all(replies);assert.equal(calls.length, 4);
  assert.ok(events.some(event => event.event_type === "input.resolved" && event.data.native_work_id === approval.native_work_id));
  assert.equal(JSON.stringify(events).includes("private-local-state"), false);
  passed.push("original-child-review-authority", "child-form-after-new-root", "native-child-continuation", "exact-child-terminal", "private-input-state-excluded");
  for (const event of events.filter(event => ["approval.resolved", "input.resolved"].includes(event.event_type)))
    assert.deepEqual(event.data.native_request, nativeCalls.get(event.turn_id));
  passed.push("native-call-observation-through-review-and-form", "native-call-separate-from-reply-token");
  stage = "child-inventory-and-history";
  const roster = await peer.readNativeWorkInventory("owned", {pageSize: 1});
  const ownedChild = roster.items.find(row => row.work.work_id === approval.native_work_id);
  assert.ok(ownedChild);assert.equal(ownedChild.work.origin_turn_id, "child-root");assert.equal(ownedChild.work.status, "completed");
  const childPage = await peer.readNativeWorkHistoryPageComplete("owned", ownedChild.work.work_id, ownedChild.work.revision, {limit: 100});
  assert.equal(childPage.work.owner_status, "active");assert.equal(childPage.work.work_id, ownedChild.work.work_id);
  assert.ok(childPage.history.source.turn_count > 0);assert.ok(childPage.history.turns.some(turn => turn.portable_items?.length));
  passed.push("public-stable-child-inventory", "public-complete-child-history-page");
  stage = "unload";
  const exited = wait(() => events.find(event => event.event_type === "session.exited"));await peer.stopSession({session_id: "owned"});await exited;
  const retainedRoster = await peer.readNativeWorkInventory("owned", {pageSize: 1});
  const retainedChild = retainedRoster.items.find(row => row.work.work_id === approval.native_work_id);
  assert.ok(retainedChild);assert.equal(retainedChild.owner_status, "unavailable");
  const retainedPage = await peer.readNativeWorkHistoryPageComplete("owned", retainedChild.work.work_id, retainedChild.work.revision,
    {limit: 100}, {owner: "retained"});
  assert.equal(retainedPage.work.owner_status, "retained");assert.equal(retainedPage.history.source.history_hash, childPage.history.source.history_hash);
  passed.push("public-retained-child-inventory", "public-complete-retained-child-history-page");
  passed.push("confirmed-native-unload");console.log(JSON.stringify({driver: "opencode", cwd, passed, calls: calls.length}));
} catch (error) {console.log(JSON.stringify({driver: "opencode", cwd, stage, failed: true, code: error?.code ?? error?.rejection?.error?.code ?? "acceptance_failure", passed, calls: calls.length,
  terminals: events.filter(event => event.event_type === "turn.failed").map(event => ({turn: event.turn_id, code: event.data.error?.code ?? event.data.code})),
  tools: events.filter(event => event.event_type === "item.completed" && event.data.item_type === "tool_call").map(event => ({tool: event.data.summary, status: event.data.status, error: event.data.content?.error})),
  event_types: [...new Set(events.map(event => event.event_type))]}));process.exitCode = 1;}
finally {clearTimeout(deadline);if (runner) await runner.close().catch(() => {});for (const proxy of proxies) await proxy.close().catch(() => {});
  for (const socket of server.clients) socket.terminate();await new Promise(resolve => server.close(resolve));}
