import assert from "node:assert/strict";
import {createHcpEnvelope} from "@harness-control/protocol";
import {HcpHostConnection, HcpNativeSessions, HcpNativeSessionError} from "@harness-control/sdk";

// Independent wire fixture: no native model execution or provider credentials.
const sent = [], sequences = new Map();let peer;
const event = (session_id, event_type, data) => {
  const sequence = (sequences.get(session_id) ?? 0) + 1;sequences.set(session_id, sequence);
  peer.receive(createHcpEnvelope("harness.event", {session_id, sequence, event_type, created_at: "2026-10-07T00:00:00Z", data}));
};
peer = new HcpHostConnection({send(message) {
  sent.push(message);
  if (!["harness.session.start", "harness.session.stop"].includes(message.type)) return;
  if (message.type === "harness.session.start") event(message.payload.session_id, "session.configured", {execution_profile: "interactive"});
  peer.receive(createHcpEnvelope("hcp.command.ack", {command_id: message.id, duplicate: false, accepted_at: "2026-10-07T00:00:00Z"}));
}});
peer.receive(createHcpEnvelope("host.hello", {runner_id: "fixture", host_id: "fixture", runner_version: "0.5.0", capabilities: [], supported_protocol_versions: ["hcp.v0"]}));
peer.accept({protocol_version: "hcp.v0", heartbeat_interval_seconds: 30});
const sessions = new HcpNativeSessions(peer);
const payload = {session_id: "physical", workspace_id: "workspace", provider_instance_id: "native", driver_kind: "claude", cwd: "/fixture",
  execution_profile: "interactive", continuation_group_key: "conversation", model_selection: {model: "fixture"},
  sandbox_mode: "danger_full_access", approval_policy: "ask", continue_session: false, mcp_servers: []};
try {
  assert.equal((await sessions.open(payload, {readiness: "configured"})).phase, "reserved");
  event("physical", "session.configured", {execution_profile: "interactive", native_reference: "fixture-native-thread", native_conversation_ready: true});
  assert.equal(sessions.state("physical").phase, "active");
  const closing = sessions.close("physical");
  event("physical", "session.exited", {provider_instance_id: "native", reason: "logical retirement"});
  await Promise.resolve();assert.equal(sessions.state("physical").phase, "closing");
  await assert.rejects(sessions.open({...payload, session_id: "successor"}, {readiness: "configured"}), error => error instanceof HcpNativeSessionError && error.outcome === "not_sent");
  event("physical", "session.exited", {provider_instance_id: "native", native_owner_closed: true});
  assert.equal((await closing).phase, "closed");await sessions.close("physical");
  assert.equal(sent.filter(message => message.type === "harness.session.stop").length, 1);
  assert.equal((await sessions.open({...payload, session_id: "successor", continue_session: true}, {readiness: "configured"})).phase, "reserved");
  peer.disconnect();assert.equal(sessions.state("successor").phase, "unconfirmed");
  assert.equal(sent.filter(message => message.type === "harness.session.stop").length, 1);
  console.log("Packed public SDK ownership: lazy reservation, native readiness, logical-exit refusal, closure proof, successor ownership and disconnect fence passed.");
} finally {sessions.dispose();peer.disconnect();}
