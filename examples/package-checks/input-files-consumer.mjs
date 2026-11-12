// Public SDK wire-fixture acceptance; fixture receipts do not establish native-provider evidence.
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {createHcpEnvelope, HCP_VERSION} from "@harness-control/protocol";
import {HcpHostConnection, HcpInputFileUploadError} from "@harness-control/sdk";
const bytes = Uint8Array.from({length: 200_000}, (_, index) => index % 256), expected = Buffer.from(bytes);
let reference, stored = [], requests = [], corrupt = false;
const peer = new HcpHostConnection({send(message) {
  if (message.type !== "harness.conversation.request") return;
  assert.equal(message.payload.session_id, "fixture-session");assert.equal(message.payload.operation.kind, "input_file");
  const request = message.payload.operation.request;requests.push(request.action);
  if (request.action === "create") {
    const {action, ...metadata} = request;reference = {...metadata, file_id: "a".repeat(64)};stored = [];bytes.fill(0);
  }
  if (request.action === "append") {assert.equal(request.offset, Buffer.concat(stored).length);stored.push(Buffer.from(request.data_base64, "base64"));}
  if (request.action === "seal") assert.equal(createHash("sha256").update(Buffer.concat(stored)).digest("hex"), reference.sha256);
  const resultReference = corrupt && request.action === "append" ? {...reference, sha256: "b".repeat(64)} : reference;
  queueMicrotask(() => peer.receive(createHcpEnvelope("harness.conversation.result", {command_id: message.id, session_id: "fixture-session",
    operation: "input_file", filesystem_undo: false, input_file: {reference: resultReference, action: request.action,
      received_bytes: Buffer.concat(stored).length, state: request.action === "seal" ? "sealed" : "uploading"}})));
}});
peer.receive(createHcpEnvelope("host.hello", {runner_id: "fixture", host_id: "fixture", runner_version: "0.5.0", supported_protocol_versions: [HCP_VERSION], capabilities: []}));
peer.accept({protocol_version: HCP_VERSION, heartbeat_interval_seconds: 30});
try {
  const result = await peer.uploadInputFile("fixture-session", {filename: "fixture.bin", mime_type: "application/octet-stream", bytes});
  assert.deepEqual(Buffer.concat(stored), expected);assert.equal(result.result.state, "sealed");assert.equal(requests.at(-1), "seal");
  corrupt = true;requests = [];
  await assert.rejects(peer.uploadInputFile("fixture-session", {filename: "fixture.bin", mime_type: "application/octet-stream", bytes: new Uint8Array(expected)}),
    error => error instanceof HcpInputFileUploadError && error.reason === "result_changed" && error.phase === "append" && error.reference.file_id === "a".repeat(64));
  assert.deepEqual(requests, ["create", "append"]);
  console.log("Packed public owned-file upload: immutable binary bytes, scoped receipts, exact progress and seal, substitution refusal without replay or release passed.");
} finally {peer.disconnect();}
