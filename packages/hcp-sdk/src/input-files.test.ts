import assert from "node:assert/strict";
import {test} from "node:test";
import {createHash} from "node:crypto";
import {uploadHcpInputFile, HcpInputFileUploadError} from "./input-files.js";
import type {HarnessInputFileReference} from "@harness-control/protocol";
function fixture() {
  const requests: Parameters<Parameters<typeof uploadHcpInputFile>[1]>[0][] = [];
  const parts: Buffer[] = [];let reference: HarnessInputFileReference;
  const perform: Parameters<typeof uploadHcpInputFile>[1] = async request => {
    requests.push(structuredClone(request));
    if (request.action === "create") {const {action, ...metadata} = request;reference = {...metadata, file_id: "a".repeat(64)};}
    if (request.action === "append") {assert.equal(request.offset, Buffer.concat(parts).byteLength);parts.push(Buffer.from(request.data_base64, "base64"));}
    if (request.action === "seal") assert.equal(createHash("sha256").update(Buffer.concat(parts)).digest("hex"), reference.sha256);
    return {reference: {...reference}, action: request.action, received_bytes: Buffer.concat(parts).byteLength, state: request.action === "seal" ? "sealed" : "uploading"};
  };
  return {perform, requests, parts};
}
test("owned uploads copy binary input and confirm each chunk and immutable seal identity", async () => {
  const f = fixture(), bytes = Uint8Array.from({length: 180_000}, (_, index) => index % 256), original = Buffer.from(bytes);
  const result = await uploadHcpInputFile({filename: "fixture.bin", mime_type: "application/octet-stream", bytes}, async (request, wait) => {
    bytes.fill(0);return f.perform(request, wait);
  });
  assert.deepEqual(Buffer.concat(f.parts), original);assert.deepEqual(f.requests.map(request => request.action), ["create", "append", "append", "append", "seal"]);
  assert.equal(result.reference.sha256, createHash("sha256").update(original).digest("hex"));assert.equal(result.result.state, "sealed");
});
test("empty owned files seal without inventing an empty append", async () => {
  const f = fixture();await uploadHcpInputFile({filename: "empty.txt", mime_type: "text/plain", bytes: new Uint8Array()}, f.perform);
  assert.deepEqual(f.requests.map(request => request.action), ["create", "seal"]);
});
test("upload bounds, metadata and initial cancellation refuse before any native mutation", async () => {
  const f = fixture(), input = {filename: "fixture.txt", mime_type: "text/plain", bytes: new Uint8Array([1])};
  for (const options of [{maxBytes: 0}, {chunkSize: 0}, {chunkSize: 65537}, {maxBytes: 52428801}]) await assert.rejects(uploadHcpInputFile(input, f.perform, options), HcpInputFileUploadError);
  await assert.rejects(uploadHcpInputFile({...input, filename: "../fixture"}, f.perform));
  const controller = new AbortController();controller.abort();await assert.rejects(uploadHcpInputFile(input, f.perform, {signal: controller.signal}), /abort/i);
  assert.equal(f.requests.length, 0);
});
test("unknown append outcomes preserve only the confirmed file reference and never retry or release", async () => {
  const f = fixture();let calls = 0;
  await assert.rejects(uploadHcpInputFile({filename: "fixture.txt", mime_type: "text/plain", bytes: new Uint8Array([1, 2, 3])}, async (request, wait) => {
    calls++;if (request.action === "append") throw new Error("Fixture unknown outcome");return f.perform(request, wait);
  }), error => error instanceof HcpInputFileUploadError && error.reason === "unconfirmed" && error.phase === "append" && error.reference?.file_id === "a".repeat(64));
  assert.equal(calls, 2);assert.deepEqual(f.requests.map(request => request.action), ["create"]);
});
test("upload reference substitution and incorrect progress refuse before any later mutation", async () => {
  for (const change of ["reference", "progress"] as const) {
    const f = fixture();await assert.rejects(uploadHcpInputFile({filename: "fixture.txt", mime_type: "text/plain", bytes: new Uint8Array([1, 2, 3])}, async (request, wait) => {
      const result = await f.perform(request, wait);
      if (request.action === "append") return change === "reference" ? {...result, reference: {...result.reference, file_id: "b".repeat(64)}} : {...result, received_bytes: 2};
      return result;
    }), error => error instanceof HcpInputFileUploadError && error.reason === "result_changed" && error.phase === "append");
    assert.deepEqual(f.requests.map(request => request.action), ["create", "append"]);
  }
});

test("tiny chunks cannot create an unbounded upload command sequence", async () => {
  const f = fixture();await assert.rejects(uploadHcpInputFile({filename: "fixture.bin", mime_type: "application/octet-stream", bytes: new Uint8Array(8193)}, f.perform, {chunkSize: 1}),
    error => error instanceof HcpInputFileUploadError && error.reason === "limit" && error.phase === "prepare");
  assert.equal(f.requests.length, 0);
});

test("owned image uploader returns typed native references beyond the inline bound", async () => {
  const {uploadHcpImageFile} = await import("./input-files.js"), f = fixture();
  const bytes = new Uint8Array(600_000).fill(7);
  const result = await uploadHcpImageFile({filename: "fixture.png", mime_type: "image/png", bytes}, f.perform);
  assert.equal(result.reference.mime_type, "image/png");assert.equal(result.reference.byte_length, bytes.byteLength);assert.deepEqual(Buffer.concat(f.parts), Buffer.from(bytes));
});
test("native image uploader refuses document MIME, empty bodies and over-limit bytes before any upload", async () => {
  const {uploadHcpImageFile} = await import("./input-files.js"), f = fixture();
  for (const input of [{filename: "fixture.pdf", mime_type: "application/pdf", bytes: new Uint8Array([1])},
    {filename: "fixture.png", mime_type: "image/png", bytes: new Uint8Array()}, {filename: "fixture.png", mime_type: "image/png", bytes: new Uint8Array(10 * 1024 * 1024 + 1)}])
    await assert.rejects(uploadHcpImageFile(input, f.perform));
  assert.equal(f.requests.length, 0);
});
