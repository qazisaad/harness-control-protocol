// Independent public SDK fixture acceptance; these IDs are fixture labels, not native-provider evidence.
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {createHcpEnvelope, HCP_VERSION} from "@harness-control/protocol";
import {HcpHostConnection} from "@harness-control/sdk";

const body = "😀 authoritative proposed plan  ".repeat(10_000), bytes = Buffer.from(body);
const reference = {content_id: "a".repeat(64), sha256: createHash("sha256").update(bytes).digest("hex"), byte_length: bytes.length,
  format: "text", expires_at: "2030-01-01T00:00:00Z"};
let reads = 0, corrupt = false;
const peer = new HcpHostConnection({send(message) {
  if (message.type !== "harness.conversation.request") return;
  assert.equal(message.payload.session_id, "fixture-session");
  const operation = message.payload.operation;
  assert.equal(operation.kind, "content");assert.equal(operation.content_id, reference.content_id);
  const currentReference = reference, currentBytes = bytes;
  const end = Math.min(bytes.length, operation.offset + operation.limit), chunk = Buffer.from(bytes.subarray(operation.offset, end));
  if (corrupt && chunk.length) chunk[0] ^= 1;
  reads++;
  queueMicrotask(() => peer.receive(createHcpEnvelope("harness.conversation.result", {command_id: message.id,
    session_id: "fixture-session", operation: "content", filesystem_undo: false, content: {reference: currentReference, offset: operation.offset,
      data_base64: chunk.toString("base64"), ...(end < currentBytes.length ? {next_offset: end} : {})}})));
}});
peer.receive(createHcpEnvelope("host.hello", {runner_id: "fixture", host_id: "fixture", runner_version: "0.5.0",
  supported_protocol_versions: [HCP_VERSION], capabilities: []}));
peer.accept({protocol_version: HCP_VERSION, heartbeat_interval_seconds: 30});
const event = {session_id: "fixture-session", turn_id: "fixture-origin", sequence: 1, created_at: "2026-10-07T00:00:00Z",
  event_type: "turn.proposed.completed", data: {item_id: "fixture-native-item", native_execution_reference: "fixture-native-phase", status: "completed",
    plan: {truncated: true, summary: "incomplete preview", content_ref: reference}}};
try {
  const result = await peer.readProposedPlansComplete("fixture-session", [event], "fixture-origin");
  assert.equal(result.length, 1);assert.equal(result[0].completed_plan, body);assert.deepEqual(result[0].source.completed, event.data.plan);
  assert.equal(result[0].source.item_id, "fixture-native-item");assert.equal(result[0].source.native_execution_reference, "fixture-native-phase");
  assert.equal(result[0].source.origin_turn_id, "fixture-origin");assert.ok(reads > 1);
  corrupt = true;
  await assert.rejects(peer.readProposedPlansComplete("fixture-session", [event], "fixture-origin"), error => error.name === "HcpContentReadError" && error.reason === "integrity");
  console.log("Packed public SDK proposed-plan hydration: exact complete unicode body, scoped chunks, source evidence and corrupt-body refusal passed.");
} finally {peer.disconnect();}
