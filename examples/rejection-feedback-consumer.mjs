// Public wire fixture acceptance; native callback execution has separate provider evidence.
import assert from "node:assert/strict";
import {createHcpEnvelope, HCP_VERSION, harnessApprovalRequestedEventDataSchema, harnessApprovalResolvedEventDataSchema} from "@harness-control/protocol";
import {HcpHostConnection, createCommand} from "@harness-control/sdk";
const feedback = " Please keep this plan for review.  😀 ", sent = [];
const peer = new HcpHostConnection({send(message) {sent.push(message);if (message.type === "harness.approval.respond")
  queueMicrotask(() => peer.receive(createHcpEnvelope("hcp.command.ack", {command_id: message.id, duplicate: false, accepted_at: "2026-10-07T00:00:00Z"})));}});
peer.receive(createHcpEnvelope("host.hello", {runner_id: "fixture", host_id: "fixture", runner_version: "0.5.0", supported_protocol_versions: [HCP_VERSION], capabilities: []}));
peer.accept({protocol_version: HCP_VERSION, heartbeat_interval_seconds: 30});
const native_request = {source: "native", native_reference: "fixture-native", call_reference: "fixture-call"};
const request = harnessApprovalRequestedEventDataSchema.parse({session_id: "session", turn_id: "original", request_id: "fixture-request",
  workspace_id: "workspace", provider_instance_id: "fixture", driver_kind: "fixture", native_request, request_type: "other", risk_class: "high",
  action: {tool: "fixture"}, action_hash: "fixture-hash", allowed_decisions: ["decline", "cancel"], rejection_feedback_supported: true,
  expires_at: "2030-01-01T00:00:00Z", display: {title: "Fixture native approval"}});
try {
  const payload = {session_id: request.session_id, turn_id: request.turn_id, request_id: request.request_id,
    action_hash: request.action_hash, actor_id: "reviewer", decision: "decline", feedback};
  assert.throws(() => createCommand({type: "harness.approval.respond", payload: {...payload, decision: "accept"}}));
  await peer.send(createCommand({type: "harness.approval.respond", payload}));
  assert.deepEqual(sent.at(-1).payload, payload);
  const resolved = harnessApprovalResolvedEventDataSchema.parse({...payload, native_request});
  assert.equal(resolved.feedback, feedback);assert.deepEqual(resolved.native_request, native_request);
  console.log("Packed public rejection-feedback contract: exact text, request identity, denial-only response and resolution metadata passed.");
} finally {peer.disconnect();}
