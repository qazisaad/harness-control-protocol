import assert from "node:assert/strict";
import {test} from "node:test";
import {createHash} from "node:crypto";
import {resolveHcpFinalText, HcpFinalTextReadError} from "./final-text.js";
import {readHcpContent, HcpContentReadError} from "./content.js";
const noRead = async () => {throw new Error("Inline evidence must not cause retained I/O.");};
test("final-text fidelity separates complete inline output from unavailable previews and legacy evidence", async () => {
  for (const text of ["", "complete 🙂", "[preview truncated]"]) {
    const output = {final_text: text, final_text_truncated: false};
    assert.deepEqual(await resolveHcpFinalText(output, noRead), {source: output, availability: "complete", final_text: text});
  }
  assert.equal((await resolveHcpFinalText({final_text: "legacy"}, noRead)).availability, "unconfirmed");
  assert.equal((await resolveHcpFinalText({final_text: "preview", final_text_truncated: true}, noRead)).availability, "unavailable");
  assert.equal((await resolveHcpFinalText({}, noRead)).availability, "unavailable");
});
function fixture() {
  const text = "Complete 🙂 final result ".repeat(10_000), bytes = Buffer.from(text);
  const ref = {content_id: "a".repeat(64), sha256: createHash("sha256").update(bytes).digest("hex"), byte_length: bytes.length, format: "text" as const, expires_at: "2030-01-01T00:00:00Z"};
  let corrupt = false;
  const read: Parameters<typeof resolveHcpFinalText>[1] = (reference, options) => readHcpContent(reference, async (offset, limit) => {
    const end = Math.min(bytes.length, offset + limit), chunk = Buffer.from(bytes.subarray(offset, end));
    if (corrupt && chunk.length) chunk[0] = chunk[0]! ^ 1;
    return {reference: ref, offset, data_base64: chunk.toString("base64"), ...(end < bytes.length ? {next_offset: end} : {})};
  }, options);
  return {text, ref, read, corrupt() {corrupt = true;}};
}
test("explicit final-text references hydrate complete Unicode results, preserve source previews and refuse corruption", async () => {
  const f = fixture(), output = {final_text: "preview", final_text_truncated: true, final_text_ref: f.ref};
  const resolved = await resolveHcpFinalText(output, f.read);
  assert.equal(resolved.availability, "complete"); assert.ok(resolved.availability === "complete"); assert.equal(resolved.final_text, f.text); assert.deepEqual(resolved.source, output);
  assert.equal((await resolveHcpFinalText({final_text: "legacy", content_ref: f.ref}, noRead)).availability, "unconfirmed");
  f.corrupt(); await assert.rejects(resolveHcpFinalText(output, f.read), error => error instanceof HcpContentReadError && error.reason === "integrity");
});
test("final-text limits, cancellation, source-reference substitution and contradictory bodies refuse", async () => {
  const f = fixture(), output = {final_text: "preview", final_text_truncated: true, final_text_ref: f.ref};
  await assert.rejects(resolveHcpFinalText(output, f.read, {maxBytes: 1}), error => error instanceof HcpContentReadError && error.reason === "limit");
  const abort = new AbortController(); abort.abort(); await assert.rejects(resolveHcpFinalText(output, f.read, {signal: abort.signal}), /abort/i);
  await assert.rejects(resolveHcpFinalText(output, async ref => {ref.sha256 = "f".repeat(64);return {reference: ref, format: "text", text: "wrong"};}), error => error instanceof HcpContentReadError && error.reason === "reference_changed");
  assert.equal(output.final_text_ref.sha256, f.ref.sha256);
  await assert.rejects(resolveHcpFinalText({...output, final_text_truncated: false}, f.read), HcpFinalTextReadError);
  const reference = {...f.ref, format: "json" as const};
  await assert.rejects(resolveHcpFinalText({final_text_ref: reference}, async ref => ({reference: ref, format: "json", value: {text: "untyped body"}})), HcpFinalTextReadError);
});
