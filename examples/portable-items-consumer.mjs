// Independent public SDK fixture acceptance; fixture references are not native acceptance evidence.
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {createHcpEnvelope, HCP_VERSION} from "@harness-control/protocol";
import {HcpHostConnection} from "@harness-control/sdk";
const body = {text: "complete 🙂 result ".repeat(10_000)}, bytes = Buffer.from(JSON.stringify(body));
const reference = {content_id: "a".repeat(64), sha256: createHash("sha256").update(bytes).digest("hex"), byte_length: bytes.length,
  format: "json", expires_at: "2030-01-01T00:00:00Z"};
let reads = 0, corrupt = false;
const peer = new HcpHostConnection({send(message) {
  if (message.type !== "harness.conversation.request") return;
  assert.equal(message.payload.session_id, "fixture-session");
  const operation = message.payload.operation;
  assert.equal(operation.kind, "content"); assert.equal(operation.content_id, reference.content_id);
  const end = Math.min(bytes.length, operation.offset + operation.limit), chunk = Buffer.from(bytes.subarray(operation.offset, end));
  if (corrupt && chunk.length) chunk[0] ^= 1;
  reads++;
  queueMicrotask(() => peer.receive(createHcpEnvelope("harness.conversation.result", {command_id: message.id,
    session_id: "fixture-session", operation: "content", filesystem_undo: false, content: {reference, offset: operation.offset,
      data_base64: chunk.toString("base64"), ...(end < bytes.length ? {next_offset: end} : {})}})));
}});
peer.receive(createHcpEnvelope("host.hello", {runner_id: "fixture", host_id: "fixture", runner_version: "0.5.0", supported_protocol_versions: [HCP_VERSION], capabilities: []}));
peer.accept({protocol_version: HCP_VERSION, heartbeat_interval_seconds: 30});
const observation = {source: "native", native_reference: "fixture-thread", native_item_reference: "fixture-part", native_call_reference: "fixture-call", fidelity: "partial",
  items: [{id: "fixture-call", type: "tool_call", tool_name: "custom", status: "running", arguments: {storage: "inline", value: {query: "fixture"}}},
    {id: "result:fixture-call", type: "tool_result", call_id: "fixture-call", status: "completed", result: {storage: "reference", content_ref: reference, preview: "incomplete"}}]};
try {
  const result = await peer.readPortableItemComplete("fixture-session", observation);
  assert.deepEqual(result.source, observation); assert.equal(result.source.fidelity, "partial");
  assert.deepEqual(result.items[1].values.result, {storage: "resolved", content_ref: reference, value: body}); assert.ok(reads > 1);
  corrupt = true;
  await assert.rejects(peer.readPortableItemComplete("fixture-session", observation), error => error.name === "HcpContentReadError" && error.reason === "integrity");
  console.log("Packed public portable item reader: scoped Unicode bodies, source fidelity and corruption refusal passed.");
} finally {peer.disconnect();}
