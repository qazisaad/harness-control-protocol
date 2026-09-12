import assert from "node:assert/strict";
import test from "node:test";
import { createHcpEnvelope, type HcpMessage } from "@harness-control/protocol";
import { HcpHostConnection, HcpOutcomeUnknownError } from "./index.js";

function connected() {
  const sent: HcpMessage[] = [];
  const peer = new HcpHostConnection({ send: message => sent.push(message) });
  peer.receive(createHcpEnvelope("host.hello", { runner_id: "runner", host_id: "host", runner_version: "test", supported_protocol_versions: ["hcp.v0"], capabilities: ["account_usage"] }));
  peer.accept({ protocol_version: "hcp.v0", heartbeat_interval_seconds: 10 });
  return { peer, sent };
}

test("account snapshots require the right host, request and complete selection; ACK cannot settle a read", async () => {
  const { peer } = connected();
  const result = peer.readAccounts({ provider_instance_ids: ["work"] }, { id: "read" });
  const snapshot = { request_id: "read", host_id: "host", providers: [{ provider_instance_id: "work", observation: {
    status: "unavailable" as const, observed_at: new Date().toISOString(), reason: "disabled" as const, message: "Disabled",
  } }] };
  let settled = false; void result.then(() => { settled = true; });
  peer.receive(createHcpEnvelope("hcp.command.ack", { command_id: "read", duplicate: false, accepted_at: new Date().toISOString() }));
  await Promise.resolve(); assert.equal(settled, false);
  assert.throws(() => peer.receive(createHcpEnvelope("host.accounts.snapshot", { ...snapshot, host_id: "other" })), /identity/);
  assert.throws(() => peer.receive(createHcpEnvelope("host.accounts.snapshot", { ...snapshot, providers: [] })), /selection/);
  peer.receive(createHcpEnvelope("host.accounts.snapshot", { ...snapshot, request_id: "unrelated" }));
  assert.equal(peer.accounts.snapshot().length, 0);
  peer.receive(createHcpEnvelope("host.accounts.snapshot", snapshot));
  assert.equal((await result).type, "host.accounts.snapshot");
  assert.equal(peer.accounts.snapshot().length, 1);
});

test("disconnect ends the pending read and fresh connection can share the canonical account projection", async () => {
  const { peer } = connected();
  const result = peer.readAccounts();
  peer.disconnect();
  await assert.rejects(result, HcpOutcomeUnknownError);
  const replacement = new HcpHostConnection({ send: () => {} }, { accounts: peer.accounts });
  assert.equal(replacement.accounts, peer.accounts);
});
