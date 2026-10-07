import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import test from "node:test";
import {readHcpContent, HcpContentReadError} from "./index.js";
import type {HarnessContentChunk, HarnessContentReference} from "@harness-control/protocol";

function fixture(bytes: Buffer, format: "text" | "json" = "text") {
  const reference: HarnessContentReference = {content_id: "a".repeat(64), sha256: createHash("sha256").update(bytes).digest("hex"), byte_length: bytes.length,
    format, expires_at: "2026-10-08T00:00:00Z"};
  const reads: number[] = [];
  const read = async (offset: number, limit: number): Promise<HarnessContentChunk> => {
    reads.push(offset);const end = Math.min(bytes.length, offset + limit);
    return {reference, offset, data_base64: bytes.subarray(offset, end).toString("base64"), ...(end < bytes.length ? {next_offset: end} : {})};
  };
  return {reference, read, reads};
}
test("complete content verifies bytes before decoding split Unicode text, JSON and empty objects", async () => {
  for (const [text, format] of [["Hello é 世界🙂", "text"], ["\uFEFFliteral BOM", "text"], ['{"message":"é 世界🙂"}', "json"], ["", "text"]] as const) {
    const f = fixture(Buffer.from(text), format), result = await readHcpContent(f.reference, f.read, {chunkSize: 1});
    assert.equal(result.format, format);assert.deepEqual(result.reference, f.reference);
    if (result.format === "text") assert.equal(result.text, text);else assert.deepEqual(result.value, JSON.parse(text));
    assert.equal(f.reads[0], 0);assert.equal(f.reads.length, Math.max(1, f.reference.byte_length));
  }
});
test("reference and offset changes refuse a partial result", async () => {
  const f = fixture(Buffer.from("abcdefgh"));
  for (const change of [{sha256: "b".repeat(64)}, {format: "json" as const}, {content_id: "b".repeat(64)}, {expires_at: "2026-10-09T00:00:00Z"}])
    await assert.rejects(readHcpContent(f.reference, async (offset, limit) => ({...await f.read(offset, limit), reference: {...f.reference, ...change}})), error => error instanceof HcpContentReadError && error.reason === "reference_changed");
  await assert.rejects(readHcpContent(f.reference, async () => ({reference: f.reference, offset: 1, data_base64: Buffer.from("bcdefgh").toString("base64")})), error => error instanceof HcpContentReadError && error.reason === "offset_changed");
});
test("corrupt bytes, invalid UTF-8 and malformed JSON never become complete content", async () => {
  const f = fixture(Buffer.from("original"));
  await assert.rejects(readHcpContent(f.reference, async () => ({reference: f.reference, offset: 0, data_base64: Buffer.from("modified").toString("base64")})), error => error instanceof HcpContentReadError && error.reason === "integrity");
  const invalidUtf8 = fixture(Buffer.from([0xc3, 0x28]));
  await assert.rejects(readHcpContent(invalidUtf8.reference, invalidUtf8.read), error => error instanceof HcpContentReadError && error.reason === "invalid_utf8");
  const invalidJson = fixture(Buffer.from('{"private_invalid_json"'), "json");
  await assert.rejects(readHcpContent(invalidJson.reference, invalidJson.read), error => error instanceof HcpContentReadError && error.reason === "invalid_json" && !error.message.includes("private_invalid_json"));
});
test("content byte/chunk bounds refuse before dispatch and short chunks cannot evade the count", async () => {
  const f = fixture(Buffer.from("abcdefgh"));
  for (const options of [{maxBytes: 7}, {maxBytes: 0}, {chunkSize: 0}, {chunkSize: 65537}, {maxChunks: 8193}, {chunkSize: 1, maxChunks: 7}])
    await assert.rejects(readHcpContent(f.reference, async () => {assert.fail("Bound exceeded before dispatch");}, options), error => error instanceof HcpContentReadError && error.reason === "limit");
  await assert.rejects(readHcpContent(f.reference, offset => f.read(offset, 1), {maxChunks: 2}), error => error instanceof HcpContentReadError && error.reason === "limit");
  assert.deepEqual(f.reads, [0, 1]);
});
test("content cancellation after a chunk stops subsequent reads without retry", async () => {
  const f = fixture(Buffer.from("abcdefgh")), abort = new AbortController();
  await assert.rejects(readHcpContent(f.reference, async (offset, limit) => {const result = await f.read(offset, limit);abort.abort();return result;}, {chunkSize: 1, signal: abort.signal}), /abort/i);
  assert.deepEqual(f.reads, [0]);
});
