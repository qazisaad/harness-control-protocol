// Independent public SDK fixture acceptance; these IDs are fixture labels, not native-provider evidence.
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {createHcpEnvelope, HCP_VERSION} from "@harness-control/protocol";
import {HcpHostConnection} from "@harness-control/sdk";

const body = "Complete 🙂 authoritative text ".repeat(10_000);
const bytes = Buffer.from(body);
const reference = {content_id: "a".repeat(64), sha256: createHash("sha256").update(bytes).digest("hex"), byte_length: bytes.length,
  format: "text", expires_at: "2030-01-01T00:00:00Z"};
let reads = 0, corrupt = false;
const peer = new HcpHostConnection({send(message) {
  if (message.type !== "harness.conversation.request") return;
  assert.equal(message.payload.session_id, "fixture-session");
  const operation = message.payload.operation;
  assert.equal(operation.kind, "content");assert.equal(operation.content_id, reference.content_id);
  const end = Math.min(bytes.length, operation.offset + operation.limit), chunk = Buffer.from(bytes.subarray(operation.offset, end));
  if (corrupt && chunk.length) chunk[0] ^= 1;
  reads++;
  queueMicrotask(() => peer.receive(createHcpEnvelope("harness.conversation.result", {command_id: message.id,
    session_id: "fixture-session", operation: "content", filesystem_undo: false, content: {reference, offset: operation.offset,
      data_base64: chunk.toString("base64"), ...(end < bytes.length ? {next_offset: end} : {})}})));
}});
peer.receive(createHcpEnvelope("host.hello", {runner_id: "fixture", host_id: "fixture", runner_version: "0.5.0",
  supported_protocol_versions: [HCP_VERSION], capabilities: []}));
peer.accept({protocol_version: HCP_VERSION, heartbeat_interval_seconds: 30});
const output = {final_text: "incomplete preview", final_text_truncated: true, final_text_ref: reference, content_ref: reference};
try {
  const result = await peer.readFinalTextComplete("fixture-session", output);
  assert.equal(result.availability, "complete");assert.equal(result.final_text, body);assert.deepEqual(result.source, output);assert.ok(reads > 1);
  corrupt = true;
  await assert.rejects(peer.readFinalTextComplete("fixture-session", output), error => error.name === "HcpContentReadError" && error.reason === "integrity");
  console.log("Packed public SDK final-result hydration: complete unicode body, scoped chunks, original evidence and corrupt-body refusal passed.");
} finally {peer.disconnect();}
