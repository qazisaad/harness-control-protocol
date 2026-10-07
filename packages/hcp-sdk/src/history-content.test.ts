import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import type {HarnessContentReference, NativeConversationHistory} from "@harness-control/protocol";
import {readHcpContent, HcpContentReadError} from "./content.js";
import {resolveHcpHistoryPage} from "./history-content.js";

function fixture() {
  const bodies = new Map<string, Buffer>(), calls: string[] = [];
  const ref = (text: string, format: "json" | "text"): HarnessContentReference => {
    const bytes = Buffer.from(text), id = createHash("sha256").update(`${bodies.size}`).digest("hex");bodies.set(id, bytes);
    return {content_id: id, sha256: createHash("sha256").update(bytes).digest("hex"), byte_length: bytes.length, format, expires_at: "2030-01-01T00:00:00Z"};
  };
  const read: Parameters<typeof resolveHcpHistoryPage>[1] = (reference, options) => {
    calls.push(reference.content_id);
    return readHcpContent(reference, async (offset, limit) => {
      const bytes = bodies.get(reference.content_id)!;const end = Math.min(offset + limit, bytes.length);
      return {reference, offset, data_base64: bytes.subarray(offset, end).toString("base64"), ...(end < bytes.length ? {next_offset: end} : {})};
    }, options);
  };
  const page = (turn: NativeConversationHistory["turns"][number]): NativeConversationHistory => ({history_hash: "b".repeat(64), turn_count: 7,
    truncated: true, next_cursor: "older", turns: [turn]});
  return {ref, read, page, calls};
}

test("resolves native and portable containers plus nested values without upgrading source fidelity", async () => {
  const f = fixture(), body = f.ref("complete 😀 body", "text");
  const item = {id: "message", type: "message", role: "assistant", status: "completed", body: {storage: "reference", content_ref: body, preview: "incomplete"}};
  const history = f.page({id: "turn", status: "completed", items: [{preview: true}], items_ref: f.ref(JSON.stringify([{text: "native full"}]), "json"),
    portable_items_ref: f.ref(JSON.stringify([item, {...item, id: "duplicate-body"}, {id: "missing", type: "reasoning", status: "unknown", body: {storage: "unavailable", reason: "not_retained"}}]), "json"), portable_fidelity: "partial"});
  const result = await resolveHcpHistoryPage(history, f.read);
  assert.deepEqual(result.source, history);assert.equal(result.source.truncated, true);assert.equal(result.source.turns[0]!.portable_fidelity, "partial");
  assert.deepEqual(result.turns[0]!.native_items, [{text: "native full"}]);
  assert.deepEqual(result.turns[0]!.portable_items![0]!.values.body, {storage: "resolved", content_ref: body, value: "complete 😀 body"});
  assert.deepEqual(result.turns[0]!.portable_items![2]!.values.body, {storage: "unavailable", reason: "not_retained"});
  assert.equal(f.calls.filter(id => id === body.content_id).length, 1);assert.equal(history.turns[0]!.items[0]!.preview, true);
});

test("inline fields and absent portable projection stay distinct from an empty retained projection", async () => {
  const f = fixture(), source = f.page({id: "turn", status: "completed", items: [], portable_items: [{id: "command", type: "command", status: "completed",
    command: {storage: "inline", value: "pwd"}, output: {storage: "unavailable", reason: "unsupported_native_shape"}}]});
  const result = await resolveHcpHistoryPage(source, f.read);
  assert.deepEqual(result.turns[0]!.portable_items![0]!.values, {command: {storage: "inline", value: "pwd"}, output: {storage: "unavailable", reason: "unsupported_native_shape"}});
  const absent = await resolveHcpHistoryPage(f.page({id: "turn", status: "completed", items: []}), f.read);
  assert.equal("portable_items" in absent.turns[0]!, false);assert.equal(f.calls.length, 0);
});

test("reference and total-byte bounds refuse before excess I/O and never return previews", async () => {
  const f = fixture(), a = f.ref("first", "text"), b = f.ref("second", "text");
  const source = f.page({id: "turn", status: "completed", items: [], portable_items: [{id: "command", type: "command", status: "completed",
    command: {storage: "reference", content_ref: a}, output: {storage: "reference", content_ref: b}}]});
  for (const options of [{maxReferences: 1}, {maxTotalBytes: a.byte_length}]) {
    f.calls.length = 0;
    await assert.rejects(resolveHcpHistoryPage(source, f.read, options), error => error instanceof HcpContentReadError && error.reason === "limit");
    assert.deepEqual(f.calls, [a.content_id]);
  }
  for (const options of [{maxReferences: 0}, {maxTotalBytes: 0}]) await assert.rejects(resolveHcpHistoryPage(source, f.read, options));
});

test("same content ID with changed metadata and incompatible container shape refuse", async () => {
  const f = fixture(), a = f.ref("body", "text");
  const source = f.page({id: "turn", status: "completed", items: [], portable_items: [{id: "command", type: "command", status: "completed",
    command: {storage: "reference", content_ref: a}, output: {storage: "reference", content_ref: {...a, sha256: "c".repeat(64)}}}]});
  await assert.rejects(resolveHcpHistoryPage(source, f.read), error => error instanceof HcpContentReadError && error.reason === "reference_changed");
  assert.equal(f.calls.length, 1);
  await assert.rejects(resolveHcpHistoryPage(f.page({id: "turn", status: "completed", items: [], items_ref: a}), f.read), error => error instanceof HcpContentReadError && error.reason === "invalid_json");
  await assert.rejects(resolveHcpHistoryPage(f.page({id: "turn", status: "completed", items: [], portable_items_ref: f.ref(JSON.stringify([{unrecognized: true}]), "json")}), f.read));
});

test("abort after a completed reference prevents the next reference", async () => {
  const f = fixture(), abort = new AbortController();
  const source = f.page({id: "turn", status: "completed", items: [], items_ref: f.ref("[]", "json"), portable_items_ref: f.ref("[]", "json")});
  await assert.rejects(resolveHcpHistoryPage(source, async (reference, options) => {const value = await f.read(reference, options);abort.abort();return value;}, {signal: abort.signal}), /abort/i);
  assert.equal(f.calls.length, 1);
});

test("custom reader cannot rewrite the retained source reference through its argument", async () => {
  const f = fixture(), reference = f.ref("[]", "json"), original = structuredClone(reference);
  const history = f.page({id: "turn", status: "completed", items: [], items_ref: reference});
  await assert.rejects(resolveHcpHistoryPage(history, async passed => {
    passed.sha256 = "f".repeat(64);
    return {reference: passed, format: "json", value: []};
  }), error => error instanceof HcpContentReadError && error.reason === "reference_changed");
  assert.deepEqual(history.turns[0]!.items_ref, original);
});


test("portable attachments expose typed media sources and refuse unsupported hydrated bodies", async () => {
  const {resolveHcpPortableItem} = await import("./portable-items.js");
  const observation = {source: "native" as const, native_reference: "physical", native_item_reference: "actual-item", fidelity: "full" as const,
    items: [{id: "display", type: "attachment" as const, media_kind: "image" as const, status: "unknown" as const,
      body: {storage: "inline" as const, value: {kind: "embedded", mime_type: "image/png", data_base64: "AQID"}}}]};
  const result = await resolveHcpPortableItem(observation, async () => {throw new Error("Inline media must not fetch content");});
  assert.deepEqual(result.items[0]?.media, observation.items[0]!.body.value);assert.equal(result.source.native_item_reference, "actual-item");
  await assert.rejects(resolveHcpPortableItem({...observation, items: [{...observation.items[0]!, body: {storage: "inline", value: {kind: "url", url: "file:///private/input"}}}]}, async () => {throw new Error("Media must not fetch a URL");}));
});
