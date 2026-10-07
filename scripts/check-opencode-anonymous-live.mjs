import assert from "node:assert/strict";
import {mkdtemp, mkdir, realpath} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {WebSocketServer} from "ws";
import {HcpHostConnection, HcpNativeSessions} from "@harness-control/sdk";
import {harnessTextDeltaEventDataSchema, harnessInputRequestedEventDataSchema, harnessNativeRequestIdentitySchema} from "@harness-control/protocol";
import {RunnerConnection} from "@harness-control/runner/connection";
import {RunnerConfigSchema} from "@harness-control/runner/config";
import {HarnessSessionManager} from "@harness-control/runner/harnesses";

if (process.env.HCP_OPENCODE_ANONYMOUS_LIVE !== "1") throw new Error("Set HCP_OPENCODE_ANONYMOUS_LIVE=1 for isolated native public-model acceptance.");
const cwd = await realpath(await mkdtemp(join(tmpdir(), "hcp-opencode-public-")));
for (const name of ["home", "config", "data", "state", "cache"]) await mkdir(join(cwd, name));
const env = {HOME: join(cwd, "home"), USERPROFILE: join(cwd, "home"), XDG_CONFIG_HOME: join(cwd, "config"),
  XDG_DATA_HOME: join(cwd, "data"), XDG_STATE_HOME: join(cwd, "state"), XDG_CACHE_HOME: join(cwd, "cache"),
  OPENCODE_AUTH_CONTENT: "{}", OPENCODE_API_KEY: "", OPENCODE_CONFIG_CONTENT: JSON.stringify({enabled_providers: ["opencode"],
    plugin: [], mcp: {}, instructions: [], autoupdate: false, share: "disabled"}), OPENCODE_DISABLE_PROJECT_CONFIG: "true",
  OPENCODE_PURE: "true", OPENCODE_DISABLE_DEFAULT_PLUGINS: "true", OPENCODE_DISABLE_CLAUDE_CODE: "true",
  OPENCODE_DISABLE_EXTERNAL_SKILLS: "true", OPENCODE_DISABLE_AUTOUPDATE: "true"};
const server = new WebSocketServer({host: "127.0.0.1", port: 0});
await new Promise(resolve => server.once("listening", resolve));
const config = RunnerConfigSchema.parse({runner_id: "anonymous-acceptance", control_plane_url: `ws://127.0.0.1:${server.address().port}`,
  workspaces: [{id: "workspace", path: cwd}], provider_instances: [{id: "opencode", driver_kind: "opencode", env,
    ...(process.env.HCP_LIVE_OPENCODE_EXECUTABLE ? {executable_path: process.env.HCP_LIVE_OPENCODE_EXECUTABLE} : {})}]});
const manager = new HarnessSessionManager(config);
const events = [], waiters = new Set();
let peer, runner, rejected, question, reply;
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
      if (event.event_type === "user_input.requested") {
        assert.equal(event.turn_id, "question"); assert.equal(question, undefined);
        question = harnessInputRequestedEventDataSchema.parse(event.data);
        const identity = harnessNativeRequestIdentitySchema.parse(question.native_request);
        assert.ok(identity.request_reference); assert.ok(identity.call_reference); assert.ok(identity.execution_reference);
        assert.notEqual(identity.request_reference, question.request_id);
        const fields = question.form_schema?.properties?.answers?.properties;
        assert.ok(fields && Object.keys(fields).length);
        const answers = Object.fromEntries(Object.entries(fields).map(([key, field]) => {
          const items = field.properties?.answers?.items;
          return [key, {answers: [items?.enum?.[0] ?? items?.const ?? "Alpha"]}];
        }));
        reply = peer.respondToInput({session_id: "public", turn_id: "question", request_id: question.request_id,
          actor_id: "acceptance", value: {answers}});
        void reply.catch(fail);
      }
    }
    flush();
  } catch (error) {fail(error);}});
});
const send = async (session_id, turn_id, input) => {
  const terminal = wait(() => events.find(event => event.session_id === session_id && event.turn_id === turn_id &&
    ["turn.completed", "turn.failed", "turn.cancelled", "turn.aborted"].includes(event.event_type)));
  await peer.sendTurn({session_id, turn_id, input});
  assert.equal((await terminal).event_type, "turn.completed");
  const admitted = events.find(event => event.session_id === session_id && event.turn_id === turn_id && event.event_type === "native.execution.admitted");
  assert.ok(admitted?.data.native_execution_reference, "No actual native prompt admission.");
  assert.ok(events.some(event => event.session_id === session_id && event.turn_id === turn_id && event.event_type === "native.execution.completed" &&
    event.data.admission_id === admitted.data.admission_id && event.data.status === "completed"), "No exact native prompt terminal proof.");
  const usage = events.findLast(event => event.session_id === session_id && event.turn_id === turn_id && event.event_type === "usage.updated" && event.data.actor === "root")?.data;
  assert.ok(usage, "No attributed root usage observation.");
  assert.equal(usage.native_reference, admitted.data.native_reference);
  assert.equal(usage.native_execution_reference, admitted.data.native_execution_reference);
  assert.equal(usage.scope, "turn");assert.equal(usage.status, "complete");
  assert.equal(usage.total_tokens, usage.input_tokens + usage.output_tokens);
  assert.ok(usage.cached_input_tokens + usage.cache_creation_input_tokens <= usage.input_tokens);
  assert.ok(usage.reasoning_output_tokens <= usage.output_tokens);
};
const output = turnId => events.filter(event => event.turn_id === turnId && event.event_type === "content.delta")
  .map(event => harnessTextDeltaEventDataSchema.parse(event.data).delta).join("");
const stop = async session_id => {
  const count = events.filter(event => event.session_id === session_id && event.event_type === "session.exited").length;
  const exited = wait(() => events.filter(event => event.session_id === session_id && event.event_type === "session.exited").length > count);
  await peer.stopSession({session_id}); await exited;
};
try {
  const model = process.env.HCP_LIVE_OPENCODE_MODEL ?? "opencode/space-bunny-free";
  assert.ok(model.startsWith("opencode/"), "Anonymous acceptance requires the native public provider.");
  runner = new RunnerConnection({config, runnerVersion: "anonymous-native-acceptance", harnessSessions: manager});
  await runner.connect(); await wait(() => ready);
  const start = {session_id: "public", workspace_id: "workspace", cwd, provider_instance_id: "opencode", driver_kind: "opencode",
    execution_profile: "interactive", configuration_inheritance: {user_settings: false, project_settings: false, hooks: false, mcp_servers: false, plugins: false},
    model_selection: {model}, sandbox_mode: "danger_full_access", approval_policy: "ask", continue_session: false,
    continuation_group_key: "public-native-owner", mcp_servers: []};
  const marker = `HCP_PUBLIC_${randomUUID()}`;
  await peer.startSession(start);
  console.log(JSON.stringify({driver: "opencode", stage: "anonymous-start", cwd}));
  await send("public", "remember", `Remember the toy marker ${marker}. Reply exactly READY. Use no tools.`);
  await send("public", "recall", "Reply with the exact toy marker from my previous message. Use no tools.");
  assert.ok(output("recall").includes(marker));
  await send("public", "question", "Use the question tool exactly once to ask which toy label I prefer, with options Alpha and Beta. Use no other tools. After I choose, reply with that label and finish.");
  assert.ok(question, "The actual native model did not ask the requested question."); await reply;
  assert.deepEqual(events.find(event => event.event_type === "user_input.resolved" && event.data.request_id === question.request_id)?.data.native_request, question.native_request);
  await stop("public");
  const read = (await peer.readConversation("public", {limit: 100})).payload.history;
  assert.ok(read.turn_count >= 2); assert.equal(read.truncated, false);
  const fork = {target_session_id: "fork", continuation_group_key: "public-native-fork", expected_history_hash: read.history_hash};
  const forked = await peer.forkConversation("public", fork, {id: "native-fork"});
  assert.deepEqual((await peer.forkConversation("public", fork, {id: "native-fork"})).payload, forked.payload);
  const forkOwner = new HcpNativeSessions(peer);
  await forkOwner.open({...start, session_id: "fork", continuation_group_key: fork.continuation_group_key, continue_session: true, expected_native_reference: forked.payload.fork.native_reference});
  await send("fork", "fork-recall", "Reply with the exact toy marker I asked you to remember. Use no tools.");
  assert.ok(output("fork-recall").includes(marker));
  await forkOwner.close("fork");assert.equal(forkOwner.state("fork").phase, "closed");forkOwner.dispose();
  const rolled = (await peer.rollbackConversation("public", {num_turns: 1, expected_history_hash: read.history_hash})).payload;
  assert.equal(rolled.filesystem_undo, false); assert.equal(rolled.history.turn_count, read.turn_count - 1);
  await peer.startSession({...start, session_id: "resumed", continue_session: true, ...(rolled.native_reference ? {expected_native_reference: rolled.native_reference} : {})});
  await send("resumed", "rollback-recall", "Reply with the exact toy marker I asked you to remember. Use no tools.");
  assert.ok(output("rollback-recall").includes(marker));
  await stop("resumed");
  console.log(JSON.stringify({driver: "opencode", authentication: "native_anonymous", cwd, passed: ["controlled-anonymous-start", "native-zero-cost-dispatch",
    "actual-prompt-admission", "exact-prompt-terminal", "native-root-billing", "native-root-billing-identity", "native-billing-subsets", "native-question", "native-request-identity", "public-sdk-reply", "resolved-request-identity", "public-sdk-stream", "followup-recall", "confirmed-unload", "retained-history",
    "hash-checked-fork", "duplicate-fork-receipt", "fork-recall", "hash-checked-rollback", "retained-anonymous-resume", "rollback-recall"]}));
} finally {
  clearTimeout(deadline); if (runner) await runner.close().catch(() => {});
  for (const socket of server.clients) socket.terminate(); await new Promise(resolve => server.close(resolve));
}
