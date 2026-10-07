import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import type {HarnessContentReference, HarnessPortableItemObservation, HarnessPortableHistoryItem} from "@harness-control/protocol";
import {resolveHcpPortableItem} from "./portable-items.js";
import {readHcpContent, HcpContentReadError} from "./content.js";

function fixture() {
  const bodies = new Map<string, Buffer>(), calls: string[] = [];
  const ref = (value: unknown): HarnessContentReference => {
    const bytes = Buffer.from(JSON.stringify(value)), id = createHash("sha256").update(String(bodies.size)).digest("hex"); bodies.set(id, bytes);
    return {content_id: id, sha256: createHash("sha256").update(bytes).digest("hex"), byte_length: bytes.length, format: "json", expires_at: "2030-01-01T00:00:00Z"};
  };
  const read: Parameters<typeof resolveHcpPortableItem>[1] = (reference, options) => {
    calls.push(reference.content_id);
    return readHcpContent(reference, async (offset, limit) => {
      const bytes = bodies.get(reference.content_id)!, end = Math.min(bytes.length, offset + limit);
      return {reference, offset, data_base64: bytes.subarray(offset, end).toString("base64"), ...(end < bytes.length ? {next_offset: end} : {})};
    }, options);
  };
  const source = (items: HarnessPortableHistoryItem[]): HarnessPortableItemObservation => ({source: "native", native_reference: "thread", native_item_reference: "call", fidelity: "partial", items});
  return {ref, read, calls, source};
}

test("live item reader resolves containers and shared bodies without upgrading fidelity or native identity", async () => {
  const f = fixture(), body = f.ref({text: "complete 🙂"});
  const items = [{id: "call", type: "tool_call", status: "running", tool_name: "custom", arguments: {storage: "reference", content_ref: body, preview: "incomplete"}},
    {id: "result:call", type: "tool_result", status: "completed", call_id: "call", result: {storage: "reference", content_ref: body}}];
  const {items: _items, ...base} = f.source([]) as Extract<HarnessPortableItemObservation, {items: unknown}>;
  const source = {...base, items_ref: f.ref(items)};
  const result = await resolveHcpPortableItem(source, f.read);
  assert.deepEqual(result.source, source); assert.equal(result.source.fidelity, "partial");
  assert.deepEqual(result.items[0]?.values.arguments, {storage: "resolved", content_ref: body, value: {text: "complete 🙂"}});
  assert.equal(f.calls.filter(id => id === body.content_id).length, 1);
});

test("live item resolution preserves unavailable values and refuses reference substitution or excess I/O", async () => {
  const f = fixture(), ref = f.ref("body");
  const source = f.source([{id: "command", type: "command", status: "unknown", command: {storage: "unavailable", reason: "not_retained"}, output: {storage: "reference", content_ref: ref}}]);
  const result = await resolveHcpPortableItem(source, f.read);
  assert.deepEqual(result.items[0]?.values.command, {storage: "unavailable", reason: "not_retained"});
  await assert.rejects(resolveHcpPortableItem(source, f.read, {maxTotalBytes: 1}), error => error instanceof HcpContentReadError && error.reason === "limit");
  await assert.rejects(resolveHcpPortableItem(source, async passed => {passed.sha256 = "f".repeat(64); return {reference: passed, format: "json", value: "wrong"};}), error => error instanceof HcpContentReadError && error.reason === "reference_changed");
});

test("live item resolution cancels before another body and rejects incompatible retained containers", async () => {
  const f = fixture(), a = f.ref("first"), b = f.ref("second"), abort = new AbortController();
  const source = f.source([{id: "command", type: "command", status: "running", command: {storage: "reference", content_ref: a}, output: {storage: "reference", content_ref: b}}]);
  await assert.rejects(resolveHcpPortableItem(source, async (ref, options) => {const result = await f.read(ref, options); abort.abort(); return result;}, {signal: abort.signal}), /abort/i);
  assert.deepEqual(f.calls, [a.content_id]);
  const {items: _items, ...base} = f.source([]) as Extract<HarnessPortableItemObservation, {items: unknown}>;
  const bad = {...base, items_ref: f.ref([{vendorUnknown: true}])};
  await assert.rejects(resolveHcpPortableItem(bad, f.read));
});
