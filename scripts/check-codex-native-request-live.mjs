import assert from "node:assert/strict";
import {mkdtemp, realpath} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {WebSocketServer} from "ws";
import {HcpHostConnection} from "@harness-control/sdk";
import {harnessNativeRequestIdentitySchema} from "@harness-control/protocol";
import {RunnerConnection} from "@harness-control/runner/connection";
import {RunnerConfigSchema} from "@harness-control/runner/config";
import {HarnessSessionManager} from "@harness-control/runner/harnesses";

if (process.env.HCP_NATIVE_REQUEST_LIVE !== "1") throw new Error("Set HCP_NATIVE_REQUEST_LIVE=1 for installed native request acceptance.");
const cwd = await realpath(await mkdtemp(join(tmpdir(), "hcp-native-request-")));
const server = new WebSocketServer({host: "127.0.0.1", port: 0});
await new Promise(resolve => server.once("listening", resolve));
const config = RunnerConfigSchema.parse({runner_id: "native-request-acceptance", control_plane_url: `ws://127.0.0.1:${server.address().port}`,
  workspaces: [{id: "workspace", path: cwd}], provider_instances: [{id: "codex", driver_kind: "codex"}]});
const manager = new HarnessSessionManager(config);
let peer, ready, finish, exited, rejectReady, rejectFinish, rejectExited, runner, reply, requested;
const events = [];
const handshake = new Promise((resolve, reject) => {ready = resolve; rejectReady = reject;});
const terminal = new Promise((resolve, reject) => {finish = resolve; rejectFinish = reject;});
const stopped = new Promise((resolve, reject) => {exited = resolve; rejectExited = reject;});
for (const pending of [handshake, terminal, stopped]) void pending.catch(() => {});
const fail = error => {rejectReady(error); rejectFinish(error); rejectExited(error);};
const deadline = setTimeout(() => fail(new Error("Native request acceptance exceeded its deadline.")), 60_000);
server.on("connection", socket => {
  peer = new HcpHostConnection({send: message => socket.send(JSON.stringify(message))});
  socket.on("message", raw => {try {
    const observed = peer.receive(raw.toString());
    if (observed.message.type === "host.hello") peer.accept({protocol_version: "hcp.v0", heartbeat_interval_seconds: 30});
    if (observed.message.type === "host.capabilities.updated") ready();
    if (observed.message.type !== "harness.event") return;
    if (observed.reduction.outcome === "duplicate") return;
    if (observed.reduction.outcome !== "applied") throw new Error("Native event stream requires reconciliation.");
    const event = observed.message.payload; events.push(event);
    if (event.event_type === "user_input.requested") {
      assert.equal(event.turn_id, "question"); assert.equal(requested, undefined);
      requested = event;
      const identity = harnessNativeRequestIdentitySchema.parse(event.data.native_request);
      assert.ok(identity.request_reference); assert.ok(identity.execution_reference); assert.ok(identity.item_reference);
      assert.notEqual(identity.request_reference, event.data.request_id);
      const fields = event.data.form_schema?.properties?.answers?.properties;
      assert.ok(fields && Object.keys(fields).length);
      const answers = Object.fromEntries(Object.entries(fields).map(([key, field]) => {
        const items = field.properties?.answers?.items;
        return [key, {answers: [items?.enum?.[0] ?? items?.const ?? "Alpha"]}];
      }));
      reply = peer.respondToInput({session_id: "session", turn_id: "question", request_id: event.data.request_id,
        actor_id: "acceptance", value: {answers}});
      void reply.catch(fail);
    }
    if (event.turn_id === "question" && event.event_type === "turn.completed") finish();
    if (event.turn_id === "question" && ["turn.failed", "turn.cancelled", "turn.aborted"].includes(event.event_type))
      throw new Error(`Native question ended with ${event.event_type}.`);
    if (event.event_type === "session.exited") exited();
  } catch (error) {fail(error);}});
  socket.on("close", () => peer.disconnect());
});
try {
  const model = process.env.HCP_LIVE_CODEX_MODEL ?? (await manager.providerDriverStatuses()).find(provider => provider.driver_kind === "codex")?.models.find(model => model.is_default)?.id;
  assert.ok(model);
  runner = new RunnerConnection({config, runnerVersion: "native-acceptance", harnessSessions: manager});
  await runner.connect(); await handshake;
  await peer.startSession({session_id: "session", workspace_id: "workspace", cwd, provider_instance_id: "codex", driver_kind: "codex",
    execution_profile: "interactive", model_selection: {model}, sandbox_mode: "read_only", approval_policy: "ask", continue_session: false, mcp_servers: []});
  await peer.sendTurn({session_id: "session", turn_id: "question", mode: "plan",
    input: "Use request_user_input exactly once to ask which toy label I prefer, with options Alpha and Beta. Do not use files, shell commands, agents, network or any other tool. After I choose, reply with the chosen label and finish."});
  await terminal; assert.ok(requested, "The installed native model did not ask a question."); await reply;
  const identity = harnessNativeRequestIdentitySchema.parse(requested.data.native_request);
  const phase = events.find(event => event.event_type === "native.execution.admitted" && event.data.native_execution_reference === identity.execution_reference);
  assert.ok(phase); assert.equal(phase.data.native_reference, identity.native_reference);
  const resolved = events.find(event => event.event_type === "user_input.resolved" && event.data.request_id === requested.data.request_id);
  assert.deepEqual(resolved?.data.native_request, identity);
  assert.ok(events.some(event => event.event_type === "native.execution.completed" && event.data.admission_id === phase.data.admission_id && event.data.status === "completed"));
  await peer.stopSession({session_id: "session"}); await stopped;
  console.log(JSON.stringify({driver: "codex", scenario: "public-native-request-identity", cwd,
    passed: ["actual-native-question", "actual-rpc-request", "native-execution-scope", "hcp-token-separation", "public-sdk-reply", "native-resolved-evidence", "native-phase-terminal", "confirmed-unload"]}));
} finally {
  clearTimeout(deadline);
  if (runner) await runner.close().catch(() => {});
  for (const socket of server.clients) socket.terminate();
  await new Promise(resolve => server.close(resolve));
}
