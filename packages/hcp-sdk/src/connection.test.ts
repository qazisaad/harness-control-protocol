import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
