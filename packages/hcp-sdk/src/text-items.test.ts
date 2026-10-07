import assert from "node:assert/strict";
import {test} from "node:test";
import {createHash} from "node:crypto";
import {projectHcpTextItems, HcpTextProjectionError} from "./text-items.js";
import {projectHcpTextItemsComplete} from "./text-content.js";
import {readHcpContent, HcpContentReadError} from "./content.js";
const event = (sequence: number, type: string, data: Record<string, unknown>, origin = "original") => ({session_id: "session", sequence, turn_id: origin, created_at: "2026-10-07T00:00:00Z", event_type: type, data});
const part = {message_reference: "native-message", index: 0};
const delta = (sequence: number, text = "preview") => event(sequence, "content.delta", {native_part: part, delta: text});
const completed = (sequence: number, content?: unknown) => event(sequence, "item.completed", {native_part: part, item_type: "text", ...(content === undefined ? {} : {content})});

test("text blocks retain Unicode previews and late complete native bodies without invented item or execution identity", () => {
  const a = delta(1, "🙂 preview"), b = completed(2), c = completed(3, "Authoritative replacement");
  const [item] = projectHcpTextItems([c, a, a, b], "session", "original");
  assert.equal(item!.streamed_text, "🙂 preview"); assert.equal(item!.completed_content, "Authoritative replacement");
  assert.equal(item!.item_id, undefined); assert.equal(item!.native_execution_reference, undefined); assert.deepEqual(item!.native_part, part);
  assert.equal(projectHcpTextItems([completed(1, "")], "session")[0]?.completed_content, "");
  item!.native_part!.index = 5; assert.equal(projectHcpTextItems([c], "session")[0]!.native_part!.index, 0);
});
test("text is scoped to its physical native item, phase and original root", () => {
  const events = [event(1, "content.delta", {item_id: "item", native_execution_reference: "first", delta: "first"}),
    event(2, "content.delta", {item_id: "item", native_execution_reference: "second", delta: "second"}, "other")];
  assert.equal(projectHcpTextItems(events, "session").length, 2);
  assert.equal(projectHcpTextItems(events, "session", "original")[0]?.streamed_text, "first");
  assert.equal(projectHcpTextItems(events, "foreign").length, 0);
  assert.equal(projectHcpTextItems([event(1, "content.delta", {delta: "unattributed"})], "session").length, 0);
});
test("conflicting source frames, changed complete bodies, late text and reasoning pointers refuse", () => {
  for (const events of [[delta(1), delta(1, "changed")], [completed(1), delta(2)], [completed(1, "first"), completed(2, "changed")],
    [event(1, "content.delta", {item_id: "item", delta: "text", native_segment: {kind: "summary", index: 0}})]])
    assert.throws(() => projectHcpTextItems(events, "session"), HcpTextProjectionError);
  assert.throws(() => projectHcpTextItems(Array.from({length: 129}, (_, index) => event(index + 1, "content.delta", {item_id: `item-${index}`, delta: "text"})), "session"), HcpTextProjectionError);
});
function fixture() {
  const text = "Complete 🙂 body ".repeat(8000), bytes = Buffer.from(text);
  const reference = {content_id: "a".repeat(64), sha256: createHash("sha256").update(bytes).digest("hex"), byte_length: bytes.length, format: "text" as const, expires_at: "2030-01-01T00:00:00Z"};
  let corrupt = false, calls = 0;
  const read: Parameters<typeof projectHcpTextItemsComplete>[3] = (ref, options) => readHcpContent(ref, async (offset, limit) => {
    calls++; const end = Math.min(bytes.length, offset + limit), chunk = Buffer.from(bytes.subarray(offset, end));
    if (corrupt && chunk.length) chunk[0] = chunk[0]! ^ 1;
    return {reference, offset, data_base64: chunk.toString("base64"), ...(end < bytes.length ? {next_offset: end} : {})};
  }, options);
  return {text, reference, read, get calls() {return calls;}, corrupt() {corrupt = true;}};
}
test("complete text hydration preserves source evidence and verifies scoped Unicode bodies and corruption", async () => {
  const f = fixture(), content = {truncated: true, summary: "incomplete", content_ref: f.reference};
  const [result] = await projectHcpTextItemsComplete([delta(1), completed(2, content)], "session", "original", f.read);
  assert.equal(result!.completed_content, f.text); assert.deepEqual(result!.source.completed_content, content); assert.equal(result!.source.streamed_text, "preview"); assert.ok(f.calls > 1);
  f.corrupt(); await assert.rejects(projectHcpTextItemsComplete([completed(1, content)], "session", "original", f.read), error => error instanceof HcpContentReadError && error.reason === "integrity");
});
test("missing full bodies, rewritten references and non-text JSON cannot promote previews", async () => {
  const f = fixture();
  await assert.rejects(projectHcpTextItemsComplete([completed(1, {truncated: true, summary: "preview"})], "session", "original", f.read), HcpTextProjectionError);
  await assert.rejects(projectHcpTextItemsComplete([completed(1, {truncated: true, summary: "preview", content_ref: f.reference})], "session", "original", async ref => {ref.sha256 = "f".repeat(64);return {reference: ref, format: "text", text: "wrong"};}), error => error instanceof HcpContentReadError && error.reason === "reference_changed");
  const ref = {...f.reference, format: "json" as const};
  await assert.rejects(projectHcpTextItemsComplete([completed(1, {truncated: true, summary: "preview", content_ref: ref})], "session", "original", async reference => ({reference, format: "json", value: {summary: ["reasoning"]}})), HcpTextProjectionError);
});
test("complete text hydration enforces aggregate limits and cancellation between retained bodies", async () => {
  const f = fixture(), content = {truncated: true, summary: "preview", content_ref: f.reference};
  await assert.rejects(projectHcpTextItemsComplete([completed(1, content)], "session", "original", f.read, {maxTotalBytes: 1}), error => error instanceof HcpContentReadError && error.reason === "limit"); assert.equal(f.calls, 0);
  const abort = new AbortController();
  await assert.rejects(projectHcpTextItemsComplete([completed(1, content)], "session", "original", async (reference, options) => {const result = await f.read(reference, options);abort.abort();return result;}, {signal: abort.signal}), /abort/i);
});
