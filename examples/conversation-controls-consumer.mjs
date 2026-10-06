import assert from "node:assert/strict";
import {mkdtemp, rm, readFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import {WebSocketServer} from "ws";
import {HcpHostConnection} from "@harness-control/sdk";
import {harnessRateLimitObservationSchema} from "@harness-control/protocol";
import {RunnerConnection} from "@harness-control/runner/connection";
import {RunnerConfigSchema} from "@harness-control/runner/config";
import {HarnessSessionManager, HarnessAdapterRegistry} from "@harness-control/runner/harnesses";
import {ControlHarnessAdapter} from "./conversation-controls.js";

const cwd = await mkdtemp(join(tmpdir(), "hcp-controls-consumer-"));
const server = new WebSocketServer({host: "127.0.0.1", port: 0});
await new Promise(resolve => server.once("listening", resolve));
let peer, runner, failure;
let ready = false;
const events = [];
server.on("connection", socket => {
  peer = new HcpHostConnection({send: message => socket.send(JSON.stringify(message))});
  socket.on("message", raw => {
    try {
      const observation = peer.receive(raw.toString());
      if (observation.message.type === "host.hello") peer.accept({protocol_version: "hcp.v0", heartbeat_interval_seconds: 30});
      if (observation.message.type === "host.capabilities.updated") ready = true;
      if (observation.message.type === "harness.event") {
        assert.ok(["applied", "duplicate"].includes(observation.reduction.outcome)); events.push(observation.message.payload);
      }
    } catch (error) {failure = error; socket.close();}
  });
  socket.on("close", () => peer.disconnect());
});
async function until(predicate) {
  const deadline = Date.now() + 15_000;
  while (!predicate()) {if (failure) throw failure; if (Date.now() > deadline) throw new Error("Control fixture timed out"); await delay(10);}
}
try {
  const config = RunnerConfigSchema.parse({runner_id: "controls-consumer", control_plane_url: `ws://127.0.0.1:${server.address().port}`,
    workspaces: [{id: "workspace", path: cwd}], provider_instances: [{id: "provider", driver_kind: "example.controls"}]});
  const adapter = new ControlHarnessAdapter();
  const sessions = new HarnessSessionManager(config, {adapterRegistry: new HarnessAdapterRegistry([adapter])});
  runner = new RunnerConnection({config, runnerVersion: "fixture", harnessSessions: sessions});
  await runner.connect(); await until(() => ready);
  const start = {session_id: "session", workspace_id: "workspace", cwd, provider_instance_id: "provider", driver_kind: "example.controls",
    model_selection: {model: "fixture"}, approval_policy: "full_access", sandbox_mode: "read_only", continue_session: false,
    execution_profile: "interactive",
    continuation_group_key: "conversation", mcp_servers: [],
    instructions: {system: "Application instructions"},
    configuration_inheritance: {user_settings: false, project_settings: false, hooks: false, mcp_servers: false, plugins: false}};
  await peer.startSession(start);
  await peer.sendTurn({session_id: "session", turn_id: "turn", input: "wait-for-steering"});
  await until(() => events.some(event => event.event_type === "content.delta"));
  assert.deepEqual(adapter.instructionsSeen, start.instructions);
  assert.deepEqual(events.find(event => event.event_type === "session.configured").data.configuration_inheritance, start.configuration_inheritance);
  const steered = await peer.steerTurn("session", "turn", "steered"); assert.equal(steered.payload.turn_id, "turn");
  await until(() => events.some(event => event.turn_id === "turn" && event.event_type === "turn.completed"));
  adapter.emitObservation("session", "between-turns");
  await until(() => events.some(event => event.event_type === "extension.example.observation" && event.data.fields.phase === "between-turns"));
  assert.equal(events.filter(event => event.turn_id === "turn" && event.event_type === "turn.completed").length, 1);
  const lateRequest = adapter.requestLateInput("session", "turn");
  await until(() => events.some(event => event.event_type === "user_input.requested" && event.data.request_id === lateRequest));
  await assert.rejects(peer.respondToInput({session_id: "session", turn_id: "wrong-turn", request_id: lateRequest, actor_id: "app-user", value: {answer: "continue"}}));
  assert.equal(adapter.inputsReceived, 0);
  await peer.respondToInput({session_id: "session", turn_id: "turn", request_id: lateRequest, actor_id: "app-user", value: {answer: "continue"}});
  await until(() => events.some(event => event.event_type === "user_input.resolved" && event.data.request_id === lateRequest));
  assert.equal(adapter.inputsReceived, 1);
  const sessionRequest = adapter.requestLateInput("session");
  await until(() => events.some(event => event.event_type === "user_input.requested" && event.data.request_id === sessionRequest));
  const observedSessionInput = events.find(event => event.data.request_id === sessionRequest);
  assert.equal(observedSessionInput.turn_id, undefined);
  assert.equal(observedSessionInput.data.request_scope, "session");
  await assert.rejects(peer.respondToInput({session_id: "session", turn_id: "turn", request_id: sessionRequest, actor_id: "app-user", value: {answer: "continue"}}));
  await peer.respondToInput({session_id: "session", request_scope: "session", request_id: sessionRequest, actor_id: "app-user", value: {answer: "continue"}});
  await until(() => events.some(event => event.event_type === "user_input.resolved" && event.data.request_id === sessionRequest));
  assert.equal(adapter.inputsReceived, 2);
  const context = events.find(event => event.turn_id === "turn" && event.event_type === "context.updated").data;
  assert.equal(context.used_tokens, 160);
  assert.deepEqual(context.selection, start.model_selection);
  assert.deepEqual(events.find(event => event.turn_id === "turn" && event.event_type === "turn.completed").data.final_output.context, context);
  adapter.emitWork("session", "turn", "running");
  await until(() => events.some(event => event.event_type === "native.work.updated"));
  const children = await peer.readNativeWork("session");
  assert.equal(children.payload.work.items[0].owner_status, "active");
  const child = children.payload.work.items[0].work;
  const childHistory = await peer.readNativeWorkHistory("session", child.work_id, child.revision);
  assert.equal(childHistory.payload.work.action, "history");
  assert.equal(childHistory.payload.work.revision, child.revision);
  assert.equal(childHistory.payload.work.history.turns[0].items[0].text, "Owned child transcript");
  assert.equal(adapter.nativeCancellations, 0);
  const cancelled = await peer.cancelNativeWork("session", child.work_id, child.revision, {id: "cancel-child"});
  const cancelledAgain = await peer.cancelNativeWork("session", child.work_id, child.revision, {id: "cancel-child"});
  assert.deepEqual(cancelled.payload, cancelledAgain.payload);
  assert.equal(adapter.nativeCancellations, 1);
  const settledChild = (await peer.readNativeWork("session")).payload.work.items[0].work;
  assert.equal(settledChild.status, "cancelled");
  await peer.retireNativeWork("session", child.work_id, settledChild.revision);
  const reference = events.find(event => event.event_type === "turn.completed").data.final_output.content_ref;
  const chunks = []; let offset = 0;
  while (true) {
    const result = await peer.readContent("session", reference.content_id, offset);
    const chunk = result.payload.content; chunks.push(Buffer.from(chunk.data_base64, "base64"));
    if (chunk.next_offset === undefined) break; offset = chunk.next_offset;
  }
  assert.equal(Buffer.concat(chunks).toString("utf8"), "steered".repeat(30_000));
  await peer.compactConversation("session", "compact");
  await until(() => events.some(event => event.turn_id === "compact" && event.event_type === "turn.completed"));
  const loadedRead = await peer.readConversation("session");
  assert.equal(loadedRead.payload.history.turn_count, 2);
  assert.equal(sessions.activeSessionCount(), 1);
  const feedback = await peer.submitNativeFeedback("session", {classification: "bug", reason: "Fixture report", include_diagnostics: false}, {id: "fixture-feedback"});
  assert.deepEqual(feedback.payload.feedback, {source: "native", feedback_id: "fixture-feedback-receipt", classification: "bug", diagnostics_requested: false});
  assert.deepEqual((await peer.submitNativeFeedback("session", {classification: "bug", reason: "Fixture report", include_diagnostics: false}, {id: "fixture-feedback"})).payload, feedback.payload);
  assert.equal(adapter.feedbackSubmissions, 1);
  const quota = {source: "native", native_source: "example.native.quota", scope: "native_session", observed_at: new Date().toISOString(),
    windows: [{window_id: "five_hour", status: "allowed_warning", utilization: 0.9}]};
  assert.throws(() => adapter.observations.get("session")({event_type: "account.rate_limits.updated", data: {provider_instance_id: "foreign", observation: quota}}));
  adapter.observations.get("session")({event_type: "account.rate_limits.updated", data: {provider_instance_id: "provider", observation: quota}});
  await until(() => events.some(event => event.event_type === "account.rate_limits.updated"));
  const observedQuota = events.find(event => event.event_type === "account.rate_limits.updated");
  assert.equal(observedQuota.turn_id, undefined);
  assert.deepEqual(harnessRateLimitObservationSchema.parse(observedQuota.data.observation), quota);
  await peer.stopSession({session_id: "session"});
  const read = await peer.readConversation("session");
  assert.equal(read.payload.history.turns[0].portable_items[0].type, "message");
  assert.equal(read.payload.history.turns[0].portable_items[0].body.value, "steered");
  const injection = {expected_history_hash: read.payload.history.history_hash, messages: [{role: "user", content: "Independent context"}, {role: "assistant", content: "Previous answer"}]};
  const injectionResult = await peer.injectContext("session", injection, {id: "durable-injection"});
  assert.equal(injectionResult.payload.injection.outcome, "applied");
  assert.deepEqual((await peer.injectContext("session", injection, {id: "durable-injection"})).payload, injectionResult.payload);
  assert.equal(adapter.injectionDispatches, 1);
  assert.deepEqual(adapter.injectionsSeen, injection.messages);
  const fork = {target_session_id: "child", continuation_group_key: "child-key", expected_history_hash: read.payload.history.history_hash,
    last_turn_id: "turn"};
  const first = await peer.forkConversation("session", fork, {id: "durable-fork"});
  const duplicate = await peer.forkConversation("session", fork, {id: "durable-fork"});
  assert.deepEqual(first.payload, duplicate.payload); assert.equal(adapter.mutations, 1);
  const rolled = await peer.rollbackConversation("session", {num_turns: 1, expected_history_hash: read.payload.history.history_hash});
  assert.equal(rolled.payload.history.turn_count, 1); assert.equal(rolled.payload.filesystem_undo, false);
  await peer.startSession({...start, session_id: "child", continuation_group_key: "child-key", continue_session: true});
  await peer.sendTurn({session_id: "child", turn_id: "child-turn", input: "followup"});
  await until(() => events.some(event => event.turn_id === "child-turn" && event.event_type === "turn.completed"));
  adapter.emitWork("child", "child-turn", "running");
  const lostSessionInput = adapter.requestLateInput("child");
  adapter.loseWorkOwner("child");
  await until(() => events.some(event => event.session_id === "child" && event.event_type === "native.work.owner_lost"));
  const lostOwner = (await peer.readNativeWork("child")).payload.work;
  assert.equal(lostOwner.owner_status, "unavailable");
  assert.equal(lostOwner.items[0].owner_status, "unavailable");
  assert.equal(lostOwner.items[0].work.status, "running");
  await assert.rejects(peer.respondToInput({session_id: "child", request_scope: "session", request_id: lostSessionInput, actor_id: "app-user", value: {answer: "continue"}}), /No live native session input owner/);
  assert.equal(adapter.inputsReceived, 2);
  await assert.rejects(peer.cancelNativeWork("child", lostOwner.items[0].work.work_id, lostOwner.items[0].work.revision), /no live native cancellation owner/);
  assert.equal(adapter.nativeCancellations, 1);
  adapter.emitWork("child", "child-turn", "cancelled");
  await peer.stopSession({session_id: "child"}); await peer.retireConversation("child");
  await peer.startSession({...start, session_id: "files", continuation_group_key: "files"});
  const bytes = Buffer.from("Independent consumer attachment"), sha256 = createHash("sha256").update(bytes).digest("hex");
  const created = await peer.inputFile("files", {action: "create", filename: "note.txt", mime_type: "text/plain", byte_length: bytes.length, sha256}, {id: "file-create"});
  const file = created.payload.input_file.reference;
  await peer.inputFile("files", {action: "append", file_id: file.file_id, offset: 0, data_base64: bytes.toString("base64")});
  const sealed = await peer.inputFile("files", {action: "seal", file_id: file.file_id});
  assert.equal(sealed.payload.input_file.state, "sealed");
  await peer.sendTurn({session_id: "files", turn_id: "file-read", input: "Read selected attachment", files: [{reference: file, delivery: "file_context"}]});
  await until(() => events.some(event => event.turn_id === "file-read" && event.event_type === "turn.completed"));
  const text = events.find(event => event.turn_id === "file-read" && event.event_type === "turn.completed").data.final_output.final_text;
  const filePath = JSON.parse(text.slice(text.indexOf("[{")))[0].path;
  assert.equal(await readFile(filePath, "utf8"), bytes.toString());
  adapter.emitWork("files", "file-read", "running");
  await until(() => events.some(event => event.session_id === "files" && event.event_type === "native.work.updated"));
  await assert.rejects(peer.inputFile("files", {action: "release", file_id: file.file_id}), /retained by native history/);
  await assert.rejects(peer.stopSession({session_id: "files"}), /closure is unconfirmed/);
  assert.equal(await readFile(filePath, "utf8"), bytes.toString());
  adapter.emitWork("files", "file-read", "cancelled");
  await peer.stopSession({session_id: "files"});
  assert.equal(await readFile(filePath, "utf8"), bytes.toString());
  await peer.retireConversation("files");
  await assert.rejects(readFile(filePath), error => error.code === "ENOENT");
  console.log("Public SDK chunked file inputs, native context projection, background retention and retirement cleanup passed");
  await peer.startSession({...start, session_id: "context", continuation_group_key: "context"});
  const suppliedContext = {delivery: "prompt_context", messages: [{role: "user", content: "Earlier request"}, {role: "assistant", content: "Earlier answer"}]};
  await peer.sendTurn({session_id: "context", turn_id: "context-turn", input: "Continue", context: suppliedContext});
  await until(() => events.some(event => event.turn_id === "context-turn" && event.event_type === "turn.completed"));
  const prepared = events.find(event => event.turn_id === "context-turn" && event.event_type === "context.input.prepared");
  assert.equal(prepared.data.source, "app"); assert.equal(prepared.data.delivery, "prompt_context"); assert.equal(prepared.data.message_count, 2);
  const contextualText = events.find(event => event.turn_id === "context-turn" && event.event_type === "turn.completed").data.final_output.final_text;
  assert.ok(contextualText.includes(JSON.stringify(suppliedContext.messages)));
  assert.equal(adapter.instructionsSeen.system, start.instructions.system);
  await peer.stopSession({session_id: "context"}); await peer.retireConversation("context");
  console.log("Public SDK prompt context, app provenance and original instruction authority passed");
  const policySource = {...start, session_id: "policy-source", continuation_group_key: "policy-conversation"};
  await peer.startSession(policySource);
  await peer.sendTurn({session_id: policySource.session_id, turn_id: "policy-seed", input: "Retained policy context"});
  await until(() => events.some(event => event.session_id === policySource.session_id && event.event_type === "turn.completed"));
  const beforePolicy = (await peer.readConversation(policySource.session_id)).payload.history;
  await peer.stopSession({session_id: policySource.session_id});
  await peer.startSession({...policySource, session_id: "policy-target", continue_session: true, approval_policy: "ask",
    conversation_transition: {transition_id: "public-policy-transition", expected_history_hash: beforePolicy.history_hash}});
  await until(() => events.some(event => event.session_id === "policy-target" && event.event_type === "session.configured"));
  assert.deepEqual(events.find(event => event.session_id === "policy-target" && event.event_type === "session.configured").data.native_policy_readback,
    {source: "native", execution_profile: "interactive", approval_policy: "ask", sandbox_mode: "read_only"});
  assert.equal((await peer.readConversation("policy-target")).payload.history.history_hash, beforePolicy.history_hash);
  assert.equal(events.some(event => event.session_id === "policy-target" && event.turn_id), false);
  await peer.stopSession({session_id: "policy-target"}); await peer.retireConversation("policy-target");
  console.log("Public SDK no-model policy transition, native readback and retained conversation passed");
  console.log("Public SDK controls, session observations, native adapter hooks, content chunks, mutation receipts and fork resume passed");
} finally {
  await runner?.close(); for (const socket of server.clients) socket.terminate();
  await new Promise(resolve => server.close(resolve)); await rm(cwd, {recursive: true, force: true});
}
