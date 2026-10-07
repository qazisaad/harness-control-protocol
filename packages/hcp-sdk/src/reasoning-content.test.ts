import assert from "node:assert/strict";
import {test} from "node:test";
import {createHash} from "node:crypto";
import type {HarnessContentReference} from "@harness-control/protocol";
import {readHcpContent, HcpContentReadError} from "./content.js";
import {projectHcpReasoningItemsComplete} from "./reasoning-content.js";

function fixture() {
  const bodies = new Map<string, Buffer>(), calls: string[] = [];
  const reference = (body: string, format: "text" | "json" = "json"): HarnessContentReference => {
    const bytes = Buffer.from(body), content_id = createHash("sha256").update(String(bodies.size)).digest("hex");
    bodies.set(content_id, bytes);
    return {content_id, sha256: createHash("sha256").update(bytes).digest("hex"), byte_length: bytes.length, format, expires_at: "2030-01-01T00:00:00Z"};
  };
  const read: Parameters<typeof projectHcpReasoningItemsComplete>[3] = (reference, options) => {
    calls.push(reference.content_id);
    return readHcpContent(reference, async (offset, limit) => {
      const bytes = bodies.get(reference.content_id)!, end = Math.min(bytes.length, offset + limit);
      return {reference, offset, data_base64: bytes.subarray(offset, end).toString("base64"), ...(end < bytes.length ? {next_offset: end} : {})};
    }, options);
  };
  const completion = (sequence: number, reference?: HarnessContentReference) => ({session_id: "session", turn_id: "original", sequence,
    created_at: "2026-10-07T00:00:00Z", event_type: "item.completed", data: {item_id: `actual-${sequence}`,
      native_execution_reference: "actual-phase", item_type: "reasoning", content: {truncated: true, summary: "preview", ...(reference ? {content_ref: reference} : {})}}});
  return {reference, read, calls, completion};
}
test("complete reasoning hydration verifies large unicode bodies and keeps deferred source evidence", async () => {
  const f = fixture(), body = {summary: ["😀 native summary ".repeat(12_000)], content: ["authoritative content"]};
  const reference = f.reference(JSON.stringify(body)), event = f.completion(1, reference);
  const [item] = await projectHcpReasoningItemsComplete([event], "session", "original", f.read, {chunkSize: 1024});
  assert.deepEqual(item!.completed_content, body);assert.deepEqual(item!.source.completed_content, event.data.content);
  assert.deepEqual(item!.source.segments, []);assert.equal(item!.source.native_execution_reference, "actual-phase");
  assert.equal(item!.source.item_id, "actual-1");assert.equal(item!.source.origin_turn_id, "original");
  assert.deepEqual(f.calls, [reference.content_id]);assert.equal(event.data.content.summary, "preview");
});
test("missing, malformed and corrupted completed bodies never fall back to a preview", async () => {
  const f = fixture(), reference = f.reference(JSON.stringify({summary: ["body"], content: []}));
  await assert.rejects(projectHcpReasoningItemsComplete([f.completion(1)], "session", undefined, f.read), {name: "HcpReasoningProjectionError"});
  await assert.rejects(projectHcpReasoningItemsComplete([f.completion(1, {...reference, sha256: "b".repeat(64)})], "session", undefined, f.read), error => error instanceof HcpContentReadError && error.reason === "integrity");
  await assert.rejects(projectHcpReasoningItemsComplete([f.completion(1, f.reference('{"summary":[4],"content":[]}'))], "session", undefined, f.read), {name: "HcpReasoningProjectionError"});
  await assert.rejects(projectHcpReasoningItemsComplete([f.completion(1, reference)], "session", undefined,
    async () => ({reference: {...reference, byte_length: reference.byte_length + 1}, format: "json", value: {summary: [], content: []}})), error => error instanceof HcpContentReadError && error.reason === "reference_changed");
});
test("repeated references save I/O while decoded output and reference counts remain bounded", async () => {
  const f = fixture(), a = f.reference("body", "text"), b = f.reference("second", "text");
  const inputs = [f.completion(1, a), f.completion(2, a)];
  assert.deepEqual((await projectHcpReasoningItemsComplete(inputs, "session", undefined, f.read)).map(item => item.completed_content), ["body", "body"]);
  assert.deepEqual(f.calls, [a.content_id]);f.calls.length = 0;
  await assert.rejects(projectHcpReasoningItemsComplete(inputs, "session", undefined, f.read, {maxTotalBytes: a.byte_length}), error => error instanceof HcpContentReadError && error.reason === "limit");
  assert.deepEqual(f.calls, [a.content_id]);f.calls.length = 0;
  await assert.rejects(projectHcpReasoningItemsComplete([f.completion(1, a), f.completion(2, b)], "session", undefined, f.read, {maxReferences: 1}), error => error instanceof HcpContentReadError && error.reason === "limit");
  assert.deepEqual(f.calls, [a.content_id]);
  await assert.rejects(projectHcpReasoningItemsComplete([f.completion(1, a), f.completion(2, {...a, sha256: "c".repeat(64)})], "session", undefined, f.read), error => error instanceof HcpContentReadError && error.reason === "reference_changed");
});
test("absent and empty native completion remain distinct and cancellation stops further reads", async () => {
  const f = fixture(), a = f.reference("first", "text"), b = f.reference("second", "text"), abort = new AbortController();
  await assert.rejects(projectHcpReasoningItemsComplete([f.completion(1, a), f.completion(2, b)], "session", undefined,
    async (reference, options) => {const value = await f.read(reference, options);abort.abort();return value;}, {signal: abort.signal}), /abort/i);
  assert.deepEqual(f.calls, [a.content_id]);
  const empty = f.completion(3) as ReturnType<typeof f.completion> & {data: Record<string, unknown>};
  const absent = structuredClone(empty);delete (absent.data as {content?: unknown}).content;
  const inline = {...empty, sequence: 4, data: {...empty.data, item_id: "native-empty", content: {summary: [], content: []}}};
  const resolved = await projectHcpReasoningItemsComplete([absent, inline], "session", undefined, f.read);
  assert.equal("completed_content" in resolved[0]!, false);assert.deepEqual(resolved[1]!.completed_content, {summary: [], content: []});
  for (const options of [{maxTotalBytes: 0}, {maxReferences: 0}, {maxReferences: 129}])
    await assert.rejects(projectHcpReasoningItemsComplete([], "session", undefined, f.read, options), error => error instanceof HcpContentReadError && error.reason === "limit");
});
