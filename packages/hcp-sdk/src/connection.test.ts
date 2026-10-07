import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {createHash} from "node:crypto";
import test from "node:test";
import { createHcpEnvelope, parseHcpMessage, type HcpMessage } from "@harness-control/protocol";
import { createCommand, parseCommand, HcpHostConnection, HcpCommandRejectedError, HcpOutcomeUnknownError } from "./index.js";

function fixture(name: string): HcpMessage {
  return parseHcpMessage(JSON.parse(readFileSync(new URL(`../../hcp-protocol/fixtures/conformance/valid/${name}.json`, import.meta.url), "utf8")));
}
function connected() {
  const sent: HcpMessage[] = [];
  const peer = new HcpHostConnection({ send: message => { sent.push(message); } });
  peer.receive(fixture("host-hello"));
  peer.accept({ protocol_version: "hcp.v0", heartbeat_interval_seconds: 30 });
  return { peer, sent };
}
function ack(id: string): HcpMessage {
  return createHcpEnvelope("hcp.command.ack", { command_id: id, duplicate: false, accepted_at: new Date().toISOString() });
}
const stop = () => createCommand({ type: "harness.session.stop", payload: { session_id: "session-1", reason: "done" } });
const nativeTerminal = (sequence: number, session_id = "session-1", origin = "original", execution = "native-phase") => createHcpEnvelope("harness.event", {
  session_id, sequence, created_at: "2026-10-07T00:00:00Z", event_type: "native.execution.completed", turn_id: origin,
  data: {source: "native", scope: "root", admission_id: `admit-${execution}`, native_reference: "native-root", native_execution_reference: execution, status: "completed"}});
test("session event wait is distinct from ACK and requires the caller's correlated native evidence", async () => {
  const {peer, sent} = connected();let settled = false;
  const waiting = peer.waitForSessionEvent("session-1", event => event.turn_id === "original" && event.event_type === "native.execution.completed"
    && (event.data as {native_execution_reference: string}).native_execution_reference === "native-phase");
  void waiting.then(() => {settled = true;});
  const command = peer.sendTurn({session_id: "session-1", turn_id: "original", input: "Hello"});
  peer.receive(ack(sent.at(-1)!.id));await command;
  peer.receive(nativeTerminal(1, "another-session"));
  peer.receive(nativeTerminal(1, "session-1", "another-origin"));
  peer.receive(nativeTerminal(2, "session-1", "original", "another-phase"));
  await Promise.resolve();assert.equal(settled, false);
  peer.receive(nativeTerminal(3));assert.equal((await waiting).sequence, 3);
});
test("session event waits use a subsequent boundary by default and permit explicit retained replay", async () => {
  const {peer} = connected();peer.receive(nativeTerminal(1));
  assert.equal((await peer.waitForSessionEvent("session-1", () => true, {afterSequence: 0})).sequence, 1);
  const subsequent = peer.waitForSessionEvent("session-1", () => true);
  peer.receive(nativeTerminal(1));peer.receive(nativeTerminal(2));assert.equal((await subsequent).sequence, 2);
});
for (const conflict of [false, true])
test(`session event wait refuses ${conflict ? "conflicting replay" : "a gap"} while unrelated session waits remain valid`, async () => {
  const {peer} = connected();peer.receive(nativeTerminal(1));
  const failed = peer.waitForSessionEvent("session-1", () => true), unrelated = peer.waitForSessionEvent("another-session", () => true);
  const rejected = assert.rejects(failed, {name: "HcpSessionEventWaitError", reason: "reconciliation_required"});
  peer.receive(conflict ? nativeTerminal(1, "session-1", "changed") : nativeTerminal(3));await rejected;
  peer.receive(nativeTerminal(1, "another-session"));assert.equal((await unrelated).session_id, "another-session");
});
test("an applied native snapshot can supply proof without promoting nonterminal session state into completion", async () => {
  const {peer} = connected(), event = nativeTerminal(1);
  if (event.type !== "harness.event") throw new Error("Expected event.");
  const waiting = peer.waitForSessionEvent("session-1", () => true);
  peer.receive(createHcpEnvelope("harness.session.snapshot", {command_id: "snapshot", session_id: "session-1", generated_at: event.sent_at,
    completeness: "complete", omission_semantics: "replace", from_sequence: 1, through_sequence: 1, events: [event.payload], tombstones: []}));
  assert.equal((await waiting).event_type, "native.execution.completed");
  const aborted = new AbortController(), empty = peer.waitForSessionEvent("another-session", event => event.event_type === "native.execution.completed", {signal: aborted.signal});
  peer.receive(createHcpEnvelope("harness.session.snapshot", {command_id: "nonterminal-snapshot", session_id: "another-session", generated_at: event.sent_at,
    completeness: "complete", omission_semantics: "replace", from_sequence: 1, through_sequence: 1, tombstones: [],
    events: [{session_id: "another-session", sequence: 1, event_type: "session.state.changed", created_at: event.sent_at, data: {state: "idle"}}]}));
  const rejected = assert.rejects(empty, {reason: "aborted"});aborted.abort();await rejected;
});
test("disconnect, timeout, cancellation and a bad predicate fail only observation without dispatching commands", async () => {
  const {peer, sent} = connected();
  await assert.rejects(peer.waitForSessionEvent("session-1", () => true, {timeoutMs: 1}), {reason: "timeout"});
  const predicate = peer.waitForSessionEvent("session-1", () => {throw new Error("Bad observer");});
  const predicateRejected = assert.rejects(predicate, /Bad observer/);peer.receive(nativeTerminal(1));await predicateRejected;
  const closed = peer.waitForSessionEvent("session-1", () => true), rejected = assert.rejects(closed, {reason: "disconnected"});
  peer.disconnect();await rejected;assert.equal(sent.filter(message => message.type !== "host.accepted").length, 0);
});
test("unavailable replay fails only the affected session's proof wait", async () => {
  const {peer} = connected();
  const waiting = peer.waitForSessionEvent("session-1", () => true), other = peer.waitForSessionEvent("other", () => true);
  const rejected = assert.rejects(waiting, {reason: "reconciliation_required"});
  peer.receive(createHcpEnvelope("host.replay.unavailable", {session_id: "session-1", requested_after_sequence: 0, reason: "no_retained_events"}));
  await rejected;peer.receive(nativeTerminal(1, "other"));assert.equal((await other).session_id, "other");
});
test("observer callbacks and returned events cannot rewrite retained native proof or another observer's evidence", async () => {
  const {peer} = connected();
  const mutating = peer.waitForSessionEvent("session-1", event => {event.turn_id = "changed";return true;}),
    another = peer.waitForSessionEvent("session-1", event => event.turn_id === "original");
  peer.receive(nativeTerminal(1));
  const observed = await mutating;assert.equal(observed.turn_id, "original");observed.turn_id = "changed-again";
  assert.equal((await another).turn_id, "original");assert.equal(peer.events.events()[0]?.turn_id, "original");
});

test("public complete-content reader scopes every byte request and captures its immutable reference", async () => {
  const {peer, sent} = connected(), bytes = Buffer.from("Hello é🙂");
  const reference = {content_id: "a".repeat(64), sha256: createHash("sha256").update(bytes).digest("hex"), byte_length: bytes.length,
    format: "text" as const, expires_at: "2026-10-08T00:00:00Z"};
  const expected = {...reference}, commands = new Set<string>();
  const pending = peer.readContentComplete("session-1", reference, {chunkSize: 2});
  reference.content_id = "b".repeat(64);
  for (let offset = 0; offset < bytes.length; offset += 2) {
    const command = sent.at(-1)!;
    assert.equal(command.type, "harness.conversation.request");
    if (command.type !== "harness.conversation.request") throw new Error("Expected content read");
    assert.deepEqual(command.payload, {session_id: "session-1", operation: {kind: "content", content_id: expected.content_id, offset, limit: 2}});
    assert.equal(commands.has(command.id), false);commands.add(command.id);
    const end = Math.min(offset + 2, bytes.length);
    peer.receive(createHcpEnvelope("harness.conversation.result", {command_id: command.id, session_id: "session-1", operation: "content", filesystem_undo: false,
      content: {reference: expected, offset, data_base64: bytes.subarray(offset, end).toString("base64"), ...(end < bytes.length ? {next_offset: end} : {})}}));
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.deepEqual(await pending, {reference: expected, format: "text", text: bytes.toString("utf8")});
  peer.disconnect();
});

test("an accepted goal command does not fabricate native job admission or a token budget", async () => {
  const {peer, sent} = connected();
  const pending = peer.startNativeGoal("session-1", "turn-1", {objective: "Finish the explicit goal"});
  const command = sent.at(-1)!;
  assert.equal(command.type, "harness.turn.send");
  if (command.type !== "harness.turn.send") throw new Error("Expected a goal admission command");
  assert.deepEqual(command.payload.goal, {action: "start", objective: "Finish the explicit goal"});
  peer.receive(ack(command.id)); await pending;
  assert.equal(peer.events.events().length, 0);
  const event = fixture("native-goal-updated");
  if (event.type !== "harness.event") throw new Error("Expected native goal evidence");
  peer.receive({...event, payload: {...event.payload, sequence: 1}});
  assert.equal(peer.events.events()[0]?.event_type, "native.goal.updated");
});

test("file results require the requested action, reference and confirmed upload offset", async () => {
  const {peer, sent} = connected();
  const file = {file_id: "a".repeat(64), sha256: "b".repeat(64), filename: "note.txt", mime_type: "text/plain", byte_length: 1};
  const pending = peer.inputFile("session", {action: "append", file_id: file.file_id, offset: 0, data_base64: "eA=="});
  const id = sent.at(-1)!.id;
  let settled = false; void pending.then(() => {settled = true;});
  const result = (action: "append" | "read", received_bytes: number, reference = file) => createHcpEnvelope("harness.conversation.result", {
    command_id: id, session_id: "session", operation: "input_file", filesystem_undo: false,
    input_file: {action, reference, received_bytes, state: "uploading"}});
  peer.receive(result("read", 1)); peer.receive(result("append", 0));
  peer.receive(result("append", 1, {...file, file_id: "c".repeat(64)}));
  await Promise.resolve(); assert.equal(settled, false);
  peer.receive(result("append", 1)); assert.equal((await pending).payload.input_file?.received_bytes, 1);
});

test("context injection waits for its matching confirmed outcome and cannot resolve from an ACK or partial application", async () => {
  const {peer, sent} = connected();
  const waiting = peer.injectContext("session", {expected_history_hash: "a".repeat(64), messages: [{role: "user", content: "Context"}, {role: "assistant", content: "Answer"}]});
  const command = sent.at(-1)!;
  let settled = false;
  void waiting.then(() => {settled = true;});
  peer.receive(ack(command.id));
  const receipt = {command_id: command.id, session_id: "session", operation: "inject" as const, filesystem_undo: false as const};
  peer.receive(createHcpEnvelope("harness.conversation.result", {...receipt, injection: {outcome: "applied", message_count: 1}}));
  await Promise.resolve(); assert.equal(settled, false);
  peer.receive(createHcpEnvelope("harness.conversation.result", {...receipt, injection: {outcome: "applied", message_count: 2}}));
  assert.equal((await waiting).payload.injection?.outcome, "applied");
});

test("steering results must name the requested active turn", async () => {
  const {peer, sent} = connected();
  const waiting = peer.steerTurn("session", "turn", "new input");
  const command = sent.at(-1)!;
  let settled = false;
  void waiting.then(() => {settled = true;});
  const receipt = {command_id: command.id, session_id: "session", operation: "steer" as const, filesystem_undo: false as const};
  peer.receive(createHcpEnvelope("harness.conversation.result", {...receipt, turn_id: "another-turn"}));
  await Promise.resolve(); assert.equal(settled, false);
  peer.receive(createHcpEnvelope("harness.conversation.result", {...receipt, turn_id: "turn"}));
  assert.equal((await waiting).payload.turn_id, "turn");
});

test("native feedback completion requires the matching native receipt and explicit diagnostics selection", async () => {
  const {peer, sent} = connected();
  const waiting = peer.submitNativeFeedback("session", {classification: "bug", include_diagnostics: false});
  const command = sent.at(-1)!; let settled = false;
  void waiting.then(() => {settled = true;});
  const receipt = {command_id: command.id, session_id: "session", operation: "feedback" as const, filesystem_undo: false as const};
  peer.receive(ack(command.id));
  for (const feedback of [{source: "native" as const, feedback_id: "receipt", classification: "other", diagnostics_requested: false},
    {source: "native" as const, feedback_id: "receipt", classification: "bug", diagnostics_requested: true}])
    peer.receive(createHcpEnvelope("harness.conversation.result", {...receipt, feedback}));
  await Promise.resolve(); assert.equal(settled, false);
  peer.receive(createHcpEnvelope("harness.conversation.result", {...receipt,
    feedback: {source: "native", feedback_id: "receipt", classification: "bug", diagnostics_requested: false}}));
  assert.equal((await waiting).payload.feedback?.feedback_id, "receipt");
});

test("native work results must name the requested action and owned work ID", async () => {
  const {peer, sent} = connected();
  const waiting = peer.cancelNativeWork("session", "child", 4);
  const command = sent.at(-1)!;
  let settled = false;
  void waiting.then(() => {settled = true;});
  const receipt = {command_id: command.id, session_id: "session", operation: "work" as const, filesystem_undo: false as const};
  peer.receive(createHcpEnvelope("harness.conversation.result", {...receipt, work: {action: "retire", work_id: "child", retired: true}}));
  peer.receive(createHcpEnvelope("harness.conversation.result", {...receipt, work: {action: "cancel", work_id: "another-child", accepted: true}}));
  await Promise.resolve(); assert.equal(settled, false);
  peer.receive(createHcpEnvelope("harness.conversation.result", {...receipt, work: {action: "cancel", work_id: "child", accepted: true}}));
  assert.equal((await waiting).payload.work?.action, "cancel");
});

test("content results must name the requested object and byte offset", async () => {
  const {peer, sent} = connected();
  const contentId = "a".repeat(64);
  const waiting = peer.readContent("session", contentId, 5, 10);
  const command = sent.at(-1)!;
  let settled = false;
  void waiting.then(() => {settled = true;});
  const receipt = {command_id: command.id, session_id: "session", operation: "content" as const, filesystem_undo: false as const,
    content: {reference: {content_id: contentId, sha256: "b".repeat(64), byte_length: 6, format: "text" as const, expires_at: new Date(Date.now() + 60_000).toISOString()}, offset: 5, data_base64: "eA=="}};
  peer.receive(createHcpEnvelope("harness.conversation.result", {...receipt, content: {...receipt.content, offset: 0, next_offset: 1}}));
  await Promise.resolve(); assert.equal(settled, false);
  peer.receive(createHcpEnvelope("harness.conversation.result", receipt));
  assert.equal((await waiting).payload.content?.offset, 5);
});

test("public command boundary rejects wrong direction and mismatched payload", () => {
  assert.throws(() => parseCommand(fixture("host-hello")), /app-to-runner/);
  assert.throws(() => parseCommand({ ...stop(), payload: { prompt: "bad" } }));
  const command = createCommand({ type: "harness.session.stop", payload: { session_id: "session-1" } }, { id: "durable-1", sentAt: "2026-01-01T00:00:00Z" });
  assert.equal(command.id, "durable-1");
  assert.deepEqual(parseCommand(JSON.parse(JSON.stringify(command))), command);
});

test("requires hello and explicit acceptance; rejects unexpected direction and identity", () => {
  const peer = new HcpHostConnection({ send: () => {} });
  assert.throws(() => peer.send(stop()), /not connected/);
  assert.throws(() => peer.accept({ protocol_version: "hcp.v0", heartbeat_interval_seconds: 30 }), /authorize/);
  peer.receive(fixture("host-hello"));
  assert.throws(() => peer.receive(fixture("host-hello")), /Duplicate/);
  peer.accept({ protocol_version: "hcp.v0", heartbeat_interval_seconds: 30 });
  assert.throws(() => peer.receive(stop()), /runner-to-app/);
  assert.throws(() => peer.receive(createHcpEnvelope("host.heartbeat", { host_id: "other", status: "online", active_sessions: 0 })), /identity/);
  peer.disconnect();
  assert.throws(() => peer.receive(fixture("host-hello")), /closed/);
});

test("registers correlation before send and resolves synchronous ACK", async () => {
  let peer: HcpHostConnection;
  peer = new HcpHostConnection({ send: message => { if (message.type === "harness.session.stop") peer.receive(ack(message.id)); } });
  peer.receive(fixture("host-hello"));
  peer.accept({ protocol_version: "hcp.v0", heartbeat_interval_seconds: 30 });
  const result = await peer.send(stop());
  assert.equal(result.type, "hcp.command.ack");
});

test("NACK preserves the runner's error", async () => {
  const { peer } = connected();
  const command = stop();
  const result = peer.send(command);
  peer.receive(createHcpEnvelope("hcp.command.nack", { command_id: command.id, rejected_at: new Date().toISOString(), error: { code: "denied", message: "Policy denied", retryable: false } }));
  await assert.rejects(result, (error: unknown) => error instanceof HcpCommandRejectedError && error.rejection.error.code === "denied");
});

test("workspace completion requires its matching result, not ACK or unrelated result", async () => {
  const { peer } = connected();
  const command = createCommand({ type: "host.workspaces.request", payload: { operation: { kind: "list" }, expected_revision: "r1", expires_at: "2999-01-01T00:00:00Z" } });
  let settled = false;
  const result = peer.send(command).then(message => { settled = true; return message; });
  peer.receive(ack(command.id));
  peer.receive(createHcpEnvelope("host.workspaces.result", { request_id: "other", outcome: { kind: "success" }, management: { revision: "r1", allowed_roots: [] }, workspaces: [] }));
  await Promise.resolve();
  assert.equal(settled, false);
  peer.receive(createHcpEnvelope("host.workspaces.result", { request_id: command.id, outcome: { kind: "error", message: "Stale revision" }, management: { revision: "r2", allowed_roots: [] }, workspaces: [] }));
  assert.equal((await result).payload.outcome.kind, "error");
});

test("snapshot matches command_id and uses the canonical reducer for gap recovery", async () => {
  const { peer } = connected();
  const gap = peer.receive(fixture("provider-event"));
  assert.ok("reduction" in gap && gap.reduction.outcome === "gap");
  const command = createCommand({ type: "harness.session.snapshot.request", payload: { session_id: "session-1" } });
  const result = peer.send(command);
  const snapshot = fixture("session-snapshot");
  assert.equal(snapshot.type, "harness.session.snapshot");
  if (snapshot.type !== "harness.session.snapshot") throw new Error("Wrong fixture");
  peer.receive({ ...snapshot, payload: { ...snapshot.payload, command_id: command.id } });
  assert.equal((await result).type, "harness.session.snapshot");
  const applied = peer.receive(fixture("provider-event"));
  assert.ok("reduction" in applied && applied.reduction.outcome === "applied");
  const duplicate = peer.receive(fixture("provider-event"));
  assert.ok("reduction" in duplicate && duplicate.reduction.outcome === "duplicate");
});

test("local actions correlate by payload request_id rather than envelope id", async () => {
  const { peer } = connected();
  const command = parseCommand(fixture("local-action-shell-exec"));
  const response = fixture("local-action-response");
  const result = peer.send(command);
  peer.receive(response);
  assert.equal((await result).type, "local.action.response");
});

test("disconnect rejects all waits as unknown and never retries", async () => {
  const { peer, sent } = connected();
  const command = stop();
  const result = peer.send(command);
  assert.throws(() => peer.send(command), /already pending/);
  peer.disconnect();
  await assert.rejects(result, HcpOutcomeUnknownError);
  assert.equal(sent.filter(m => m.type === command.type).length, 1);
});

test("timeout and abort stop waiting without emitting a remote cancellation", async () => {
  const { peer, sent } = connected();
  await assert.rejects(peer.send(stop(), { timeoutMs: 5 }), HcpOutcomeUnknownError);
  const abort = new AbortController();
  const result = peer.send(stop(), { signal: abort.signal });
  abort.abort();
  await assert.rejects(result, HcpOutcomeUnknownError);
  assert.equal(sent.filter(m => m.type === "harness.turn.cancel").length, 0);
});

test("transport failure preserves its cause and clears the pending wait", async () => {
  const cause = new Error("socket failure");
  const peer = new HcpHostConnection({ send: message => { if (message.type === "harness.session.stop") throw cause; } });
  peer.receive(fixture("host-hello"));
  peer.accept({ protocol_version: "hcp.v0", heartbeat_interval_seconds: 30 });
  await assert.rejects(peer.send(stop()), (error: unknown) => error instanceof HcpOutcomeUnknownError && error.cause === cause);
  peer.disconnect();
});

test("child history waits for its exact owned revision instead of an ACK or stale snapshot", async () => {
  const {peer, sent} = connected();
  const pending = peer.readNativeWorkHistory("session", "child", 4);
  const id = sent.at(-1)!.id;
  let settled = false; void pending.then(() => {settled = true;});
  const result = (revision: number, work_id = "child") => createHcpEnvelope("harness.conversation.result", {
    command_id: id, session_id: "session", operation: "work", filesystem_undo: false,
    work: {action: "history", work_id, revision, source: "native", owner_status: "active",
      history: {history_hash: "a".repeat(64), turn_count: 0, truncated: false, turns: []}}});
  peer.receive(ack(id)); peer.receive(result(3)); peer.receive(result(4, "foreign"));
  await Promise.resolve(); assert.equal(settled, false);
  peer.receive(result(4)); assert.equal((await pending).payload.work?.action, "history");
});

test("retained history waits for transcript custody rather than a physical-owner claim", async () => {
  const {peer, sent} = connected();
  const pending = peer.readRetainedNativeWorkHistory("session", "child", 4);
  const id = sent.at(-1)!.id;
  let settled = false; void pending.then(() => {settled = true;});
  const receipt = (owner_status: "active" | "retained") => createHcpEnvelope("harness.conversation.result", {
    command_id: id, session_id: "session", operation: "work", filesystem_undo: false,
    work: {action: "history", work_id: "child", revision: 4, source: "native", owner_status,
      history: {history_hash: "a".repeat(64), turn_count: 0, truncated: false, turns: []}}});
  peer.receive(receipt("active")); await Promise.resolve(); assert.equal(settled, false);
  peer.receive(receipt("retained")); assert.equal((await pending).payload.work?.action, "history");
});

test("child fork waits for exact source revision and independent destination binding", async () => {
  const {peer, sent} = connected();
  const pending = peer.forkNativeWork("session", {work_id: "child", expected_revision: 4, expected_history_hash: "a".repeat(64),
    target_session_id: "target", continuation_group_key: "target-key"});
  const id = sent.at(-1)!.id;
  let settled = false; void pending.then(() => {settled = true;});
  const receipt = (revision: number, session_id = "target", continuation_group_key = "target-key") => createHcpEnvelope("harness.conversation.result", {
    command_id: id, session_id: "session", operation: "work", filesystem_undo: false,
    work: {action: "fork", work_id: "child", revision, source: "native", fork: {session_id, continuation_group_key, native_reference: "independent"}}});
  peer.receive(receipt(3)); peer.receive(receipt(4, "foreign")); peer.receive(receipt(4, "target", "foreign"));
  await Promise.resolve(); assert.equal(settled, false);
  peer.receive(receipt(4)); assert.equal((await pending).payload.work?.action, "fork");
});

test("native goal controls require exact action and generation evidence; ACK alone cannot settle", async () => {
  const {peer, sent} = connected();
  const pending = peer.pauseNativeGoal("session", 100);
  const command = sent.at(-1)!; let settled = false;
  void pending.then(() => {settled = true;});
  const result = {command_id: command.id, session_id: "session", operation: "goal" as const, filesystem_undo: false as const};
  const observation = {source: "native" as const, scope: "root" as const, native_reference: "native-root", native_created_at: 100,
    native_updated_at: 101, objective: "Goal", status: "paused" as const, tokens_used: 10, time_used_seconds: 1};
  peer.receive(ack(command.id));
  peer.receive(createHcpEnvelope("harness.conversation.result", {...result, goal: {action: "read", source: "native", native_reference: "native-root", goal: observation}}));
  peer.receive(createHcpEnvelope("harness.conversation.result", {...result, goal: {action: "pause", source: "native", native_reference: "native-root",
    target_native_created_at: 200, goal: {...observation, native_created_at: 200}}}));
  await Promise.resolve(); assert.equal(settled, false);
  peer.receive(createHcpEnvelope("harness.conversation.result", {...result, goal: {action: "pause", source: "native", native_reference: "native-root",
    target_native_created_at: 100, goal: observation}}));
  assert.equal((await pending).payload.goal?.action, "pause");
  const resumed = peer.resumeNativeGoal("session", "resume-origin", 100);
  const resume = sent.at(-1)!; assert.equal(resume.type, "harness.turn.send");
  if (resume.type !== "harness.turn.send") throw new Error("Expected resume");
  assert.deepEqual(resume.payload, {session_id: "session", turn_id: "resume-origin", input: "", goal: {action: "resume", expected_native_created_at: 100}});
  peer.receive(ack(resume.id)); await resumed;
});

function inventoryFixture(pages: import("@harness-control/protocol").NativeConversationHistory[]) {
  let reads = 0;
  const commands: HcpMessage[] = [];
  const peer = new HcpHostConnection({send(message) {
    commands.push(message);
    if (message.type !== "harness.conversation.request") return;
    const page = pages[reads++];
    queueMicrotask(() => {
      if (!page) {peer.disconnect(); return;}
      peer.receive(createHcpEnvelope("harness.conversation.result", {command_id: message.id, session_id: message.payload.session_id,
        operation: "read", filesystem_undo: false, history: page}));
    });
  }});
  peer.receive(fixture("host-hello")); peer.accept({protocol_version: "hcp.v0", heartbeat_interval_seconds: 30});
  return {peer, commands, get reads() {return reads;}};
}
const inventoryPage = (ids: string[], cursor?: string): import("@harness-control/protocol").NativeConversationHistory => ({
  history_hash: "a".repeat(64), turn_count: 4, truncated: true,
  turns: ids.map(id => ({id, status: "retained", items: [], portable_fidelity: "partial"})), ...(cursor ? {next_cursor: cursor} : {})});

type WorkPage = Extract<NonNullable<import("@harness-control/protocol").HcpConversationResultPayload["work"]>, {action: "read"}>;
const workPage = (ids: string[], cursor?: string): WorkPage => ({action: "read", owner_status: "unavailable",
  observation_hash: "a".repeat(64), total_count: 2, closure_unconfirmed: true,
  items: ids.map(work_id => ({owner_status: "unavailable", work: {work_id, native_reference: `native-${work_id}`,
    origin_turn_id: "original", kind: "agent", background: true, status: "unknown", supports_cancel: false, revision: 4}})),
  ...(cursor ? {next_cursor: cursor} : {})});
function workInventoryFixture(pages: WorkPage[]) {
  let reads = 0;
  const peer = new HcpHostConnection({send(message) {
    if (message.type !== "harness.conversation.request") return;
    const page = pages[reads++];
    queueMicrotask(() => {
      if (!page) {peer.disconnect();return;}
      peer.receive(createHcpEnvelope("harness.conversation.result", {command_id: message.id, session_id: message.payload.session_id,
        operation: "work", filesystem_undo: false, work: page}));
    });
  }});
  peer.receive(fixture("host-hello"));peer.accept({protocol_version: "hcp.v0", heartbeat_interval_seconds: 30});
  return {peer, get reads() {return reads;}};
}
test("native work inventory preserves revisions, original turns and unresolved closure across pages", async () => {
  const f = workInventoryFixture([workPage(["child-a"], "next"), workPage(["child-b"])]);
  const roster = await f.peer.readNativeWorkInventory("session-1", {pageSize: 1});
  assert.equal(roster.closure_unconfirmed, true);assert.equal(roster.owner_status, "unavailable");
  assert.deepEqual(roster.items.map(row => [row.work.work_id, row.work.revision, row.work.origin_turn_id, row.work.status]),
    [["child-a", 4, "original", "unknown"], ["child-b", 4, "original", "unknown"]]);
  assert.equal(f.reads, 2);
});
for (const drift of ["hash", "count", "owner", "closure", "duplicate", "cursor", "missing"] as const)
test(`native work inventory refuses ${drift} without combining incompatible rosters`, async () => {
  const second = workPage([drift === "duplicate" ? "child-a" : "child-b"]);
  if (drift === "hash") second.observation_hash = "b".repeat(64);
  if (drift === "count") second.total_count = 3;
  if (drift === "owner") second.owner_status = "active";
  if (drift === "closure") delete second.closure_unconfirmed;
  if (drift === "cursor") second.next_cursor = "next";
  if (drift === "missing") second.items = [];
  const f = workInventoryFixture([workPage(["child-a"], "next"), second]);
  await assert.rejects(f.peer.readNativeWorkInventory("session-1"), {name: "HcpNativeWorkInventoryError"});
  assert.equal(f.reads, 2);
});
test("native work inventory preserves empty unconfirmed rosters and stops at caller bounds", async () => {
  const empty = workInventoryFixture([{...workPage([]), total_count: 0}]);
  const roster = await empty.peer.readNativeWorkInventory("session-1");
  assert.equal(roster.total_count, 0);assert.equal(roster.closure_unconfirmed, true);
  const limited = workInventoryFixture([workPage(["a"], "next")]);
  await assert.rejects(limited.peer.readNativeWorkInventory("session-1", {maxPages: 1}), /limit/);assert.equal(limited.reads, 1);
  const invalid = workInventoryFixture([]);
  await assert.rejects(invalid.peer.readNativeWorkInventory("session-1", {pageSize: 33}), /limit/);assert.equal(invalid.reads, 0);
  const count = workInventoryFixture([workPage(["a"], "next")]);
  await assert.rejects(count.peer.readNativeWorkInventory("session-1", {maxItems: 1}), /limit/);assert.equal(count.reads, 1);
});
for (const owner of ["live", "retained"] as const)
test(`complete ${owner} child history retains custody and partial page evidence while verifying Unicode body bytes`, async () => {
  const bytes = Buffer.from("Child é🙂"), reference = {content_id: "a".repeat(64), sha256: createHash("sha256").update(bytes).digest("hex"),
    byte_length: bytes.length, format: "text" as const, expires_at: "2026-10-08T00:00:00Z"};
  const operations: unknown[] = [];
  const peer = new HcpHostConnection({send(message) {
    if (message.type !== "harness.conversation.request") return;
    const operation = message.payload.operation;operations.push(operation);
    queueMicrotask(() => {
      const result = {command_id: message.id, session_id: message.payload.session_id, filesystem_undo: false as const};
      if (operation.kind === "work" && operation.action === "history") {
        peer.receive(createHcpEnvelope("harness.conversation.result", {...result, operation: "work", work: {
          action: "history", work_id: "child", revision: 4, source: "native", owner_status: owner === "live" ? "active" : "retained",
          history: {history_hash: "b".repeat(64), turn_count: 2, truncated: true, next_cursor: "older",
            turns: [{id: "child-turn", status: "completed", items: [], portable_fidelity: "partial",
              portable_items: [{id: "child-message", type: "message", status: "completed", role: "assistant", body: {storage: "reference", content_ref: reference}}]}]}}}));
      } else if (operation.kind === "content") {
        const end = Math.min(bytes.length, operation.offset + operation.limit);
        peer.receive(createHcpEnvelope("harness.conversation.result", {...result, operation: "content", content: {reference,
          offset: operation.offset, data_base64: bytes.subarray(operation.offset, end).toString("base64"),
          ...(end < bytes.length ? {next_offset: end} : {})}}));
      }
    });
  }});
  peer.receive(fixture("host-hello"));peer.accept({protocol_version: "hcp.v0", heartbeat_interval_seconds: 30});
  const result = await peer.readNativeWorkHistoryPageComplete("session-1", "child", 4, {limit: 1}, {owner, chunkSize: 2});
  assert.deepEqual(result.work, {action: "history", work_id: "child", revision: 4, source: "native", owner_status: owner === "live" ? "active" : "retained"});
  assert.equal(result.history.source.truncated, true);assert.equal(result.history.source.next_cursor, "older");
  assert.deepEqual(result.history.turns[0]?.portable_items?.[0]?.values.body, {storage: "resolved", content_ref: reference, value: bytes.toString("utf8")});
  assert.deepEqual(operations[0], {kind: "work", action: "history", work_id: "child", expected_revision: 4, limit: 1,
    ...(owner === "retained" ? {owner} : {})});
});

test("history inventory assembles chronological native boundaries without claiming previewed content is complete", async () => {
  const f = inventoryFixture([inventoryPage(["native-3", "native-4"], "older"), inventoryPage(["native-1", "native-2"])]);
  assert.deepEqual(await f.peer.readConversationInventory("session-1", {pageSize: 2}), {history_hash: "a".repeat(64), turn_count: 4,
    turn_ids: ["native-1", "native-2", "native-3", "native-4"]});
  const reads = f.commands.filter(message => message.type === "harness.conversation.request");
  assert.equal(reads.length, 2); assert.notEqual(reads[0]!.id, reads[1]!.id);
  assert.deepEqual(reads.map(message => message.payload.operation), [{kind: "read", limit: 2}, {kind: "read", limit: 2, cursor: "older"}]);
});

for (const drift of ["hash", "count", "duplicate", "cursor", "missing"] as const)
test(`history inventory refuses ${drift} rather than returning a checkpoint boundary`, async () => {
  const second = inventoryPage(drift === "duplicate" ? ["native-1", "native-3"] : ["native-1", "native-2"]);
  if (drift === "hash") second.history_hash = "b".repeat(64);
  if (drift === "count") second.turn_count = 5;
  if (drift === "cursor") second.next_cursor = "older";
  if (drift === "missing") second.turns.pop();
  const f = inventoryFixture([inventoryPage(["native-3", "native-4"], "older"), second]);
  await assert.rejects(f.peer.readConversationInventory("session-1"), {name: "HcpHistoryInventoryError"});
  assert.equal(f.reads, 2);
});

test("history inventory applies caller bounds before requesting another page and retains empty native histories", async () => {
  const f = inventoryFixture([inventoryPage(["native-3", "native-4"], "older")]);
  await assert.rejects(f.peer.readConversationInventory("session-1", {maxTurns: 3}), /limit/); assert.equal(f.reads, 1);
  const limited = inventoryFixture([inventoryPage(["native-3", "native-4"], "older")]);
  await assert.rejects(limited.peer.readConversationInventory("session-1", {maxPages: 1}), /limit/); assert.equal(limited.reads, 1);
  const empty = inventoryFixture([{history_hash: "a".repeat(64), turn_count: 0, truncated: false, turns: []}]);
  assert.deepEqual(await empty.peer.readConversationInventory("session-1"), {history_hash: "a".repeat(64), turn_count: 0, turn_ids: []});
  const invalid = inventoryFixture([]);
  await assert.rejects(invalid.peer.readConversationInventory("session-1", {pageSize: 101}), /limit/); assert.equal(invalid.reads, 0);
});

test("complete reasoning reader filters original ownership and scopes verified retained-body requests", async () => {
  const {peer, sent} = connected(), content = {summary: ["😀 native completed body"], content: ["exact content"]}, bytes = Buffer.from(JSON.stringify(content));
  const reference = {content_id: "a".repeat(64), sha256: createHash("sha256").update(bytes).digest("hex"), byte_length: bytes.length,
    format: "json" as const, expires_at: "2026-10-08T00:00:00Z"};
  const event = {session_id: "session-1", turn_id: "original", sequence: 1, created_at: "2026-10-07T00:00:00Z", event_type: "item.completed",
    data: {item_id: "native-item", native_execution_reference: "native-phase", item_type: "reasoning", content: {truncated: true, summary: "preview", content_ref: reference}}};
  const pending = peer.readReasoningItemsComplete("session-1", [event, {...event, session_id: "foreign"}], "original", {chunkSize: 11});
  for (let offset = 0; offset < bytes.length; offset += 11) {
    const command = sent.at(-1)!;
    if (command.type !== "harness.conversation.request") throw new Error("Expected content read");
    assert.deepEqual(command.payload, {session_id: "session-1", operation: {kind: "content", content_id: reference.content_id, offset, limit: 11}});
    const end = Math.min(offset + 11, bytes.length);
    peer.receive(createHcpEnvelope("harness.conversation.result", {command_id: command.id, session_id: "session-1", operation: "content", filesystem_undo: false,
      content: {reference, offset, data_base64: bytes.subarray(offset, end).toString("base64"), ...(end < bytes.length ? {next_offset: end} : {})}}));
    await new Promise(resolve => setImmediate(resolve));
  }
  const resolved = await pending;
  assert.equal(resolved.length, 1);assert.deepEqual(resolved[0]!.completed_content, content);assert.deepEqual(resolved[0]!.source.completed_content, event.data.content);
  peer.disconnect();
});

test("public approval commands preserve exact rejection feedback and refuse feedback on acceptance before dispatch", async () => {
  const {peer, sent} = connected(), feedback = " Please revise  😀 ";
  const payload = {request_id: "request", session_id: "session-1", turn_id: "original", action_hash: "original-hash", actor_id: "reviewer",
    decision: "decline" as const, feedback};
  assert.throws(() => createCommand({type: "harness.approval.respond", payload: {...payload, decision: "accept"}}));
  const command = createCommand({type: "harness.approval.respond", payload});
  const waiting = peer.send(command);const actual = sent.at(-1)!;
  assert.equal(actual.type, "harness.approval.respond");assert.deepEqual(actual.payload, payload);
  peer.receive(ack(command.id));await waiting;
  peer.receive(createHcpEnvelope("harness.event", {session_id: "session-1", turn_id: "original", sequence: 1,
    created_at: "2026-10-07T00:00:00Z", event_type: "approval.resolved", data: {...payload,
      native_request: {source: "native", native_reference: "actual-session", call_reference: "actual-call"}}}));
  const event = peer.events.events()[0]!;
  assert.equal((event.data as {feedback?: string}).feedback, feedback);peer.disconnect();
});
