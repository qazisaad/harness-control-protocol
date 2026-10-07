// Independent public SDK fixture acceptance; these IDs are fixture labels, not native-provider evidence.
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {createHcpEnvelope, HCP_VERSION} from "@harness-control/protocol";
import {HcpHostConnection} from "@harness-control/sdk";

const body = [{index: 0, text: "😀 authoritative todo ".repeat(10_000), status: "running", native_status: "in_progress"}];
const bytes = Buffer.from(JSON.stringify(body));
const reference = {content_id: "a".repeat(64), sha256: createHash("sha256").update(bytes).digest("hex"), byte_length: bytes.length,
  format: "json", expires_at: "2030-01-01T00:00:00Z"};
const explanation = "😀 exact native explanation  ".repeat(8000), explanationBytes = Buffer.from(explanation);
const explanationRef = {...reference, content_id: "b".repeat(64), format: "text", byte_length: explanationBytes.length,
  sha256: createHash("sha256").update(explanationBytes).digest("hex")};
let reads = 0, corrupt = false;
const peer = new HcpHostConnection({send(message) {
  if (message.type !== "harness.conversation.request") return;
  assert.equal(message.payload.session_id, "fixture-session");
  const operation = message.payload.operation;
  assert.equal(operation.kind, "content");assert.ok([reference.content_id, explanationRef.content_id].includes(operation.content_id));
  const currentReference = operation.content_id === reference.content_id ? reference : explanationRef;
  const currentBytes = operation.content_id === reference.content_id ? bytes : explanationBytes;
  const end = Math.min(currentBytes.length, operation.offset + operation.limit), chunk = Buffer.from(currentBytes.subarray(operation.offset, end));
  if (corrupt && chunk.length) chunk[0] ^= 1;
  reads++;
  queueMicrotask(() => peer.receive(createHcpEnvelope("harness.conversation.result", {command_id: message.id,
    session_id: "fixture-session", operation: "content", filesystem_undo: false, content: {reference: currentReference, offset: operation.offset,
      data_base64: chunk.toString("base64"), ...(end < currentBytes.length ? {next_offset: end} : {})}})));
}});
peer.receive(createHcpEnvelope("host.hello", {runner_id: "fixture", host_id: "fixture", runner_version: "0.5.0",
  supported_protocol_versions: [HCP_VERSION], capabilities: []}));
peer.accept({protocol_version: HCP_VERSION, heartbeat_interval_seconds: 30});
const event = {session_id: "fixture-session", turn_id: "fixture-origin", sequence: 1, created_at: "2026-10-07T00:00:00Z", event_type: "turn.plan.updated",
  data: {native_plan: {source: "native", kind: "todo_list", observation: "tool_input", native_reference: "fixture-native-session", native_item_reference: "fixture-call",
    explanation: {truncated: true, summary: "partial explanation", content_ref: explanationRef},
    steps: {truncated: true, summary: "incomplete preview", content_ref: reference}}}};
try {
  const result = await peer.readNativePlanObservationsComplete("fixture-session", [event], "fixture-origin");
  assert.equal(result.length, 1);assert.deepEqual(result[0].steps, body);assert.equal(result[0].explanation, explanation);
  assert.deepEqual(result[0].source.native_plan.explanation, event.data.native_plan.explanation);
  assert.deepEqual(result[0].source.native_plan.steps, event.data.native_plan.steps);assert.equal(result[0].source.native_plan.native_execution_reference, undefined);
  assert.equal(result[0].source.native_plan.observation, "tool_input");assert.equal(result[0].source.native_plan.native_item_reference, "fixture-call");
  assert.equal(result[0].source.origin_turn_id, "fixture-origin");assert.ok(reads > 1);
  corrupt = true;
  await assert.rejects(peer.readNativePlanObservationsComplete("fixture-session", [event], "fixture-origin"), error => error.name === "HcpContentReadError" && error.reason === "integrity");
  console.log("Packed public SDK native todo hydration: complete unicode body, scoped chunks, original evidence and corrupt-body refusal passed.");
} finally {peer.disconnect();}
