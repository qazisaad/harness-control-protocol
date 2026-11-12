// Independent public SDK fixture acceptance; synthetic source IDs are not native-provider evidence.
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {resolveHcpPortableItem, readHcpContent} from "@harness-control/sdk";
const bytes = Buffer.alloc(10 * 1024 * 1024, 7);
const media = {kind: "embedded", mime_type: "image/png", data_base64: bytes.toString("base64")};
const retained = Buffer.from(JSON.stringify(media));
const reference = {content_id: "a".repeat(64), sha256: createHash("sha256").update(retained).digest("hex"), byte_length: retained.length,
  format: "json", expires_at: "2026-10-08T00:00:00.000Z"};
const observation = {source: "native", native_reference: "fixture-thread", native_item_reference: "fixture-item", fidelity: "full",
  items: [{id: "fixture-display", type: "attachment", media_kind: "image", status: "unknown", body: {storage: "reference", content_ref: reference}}]};
const read = (ref, options) => {assert.deepEqual(ref, reference);return readHcpContent(ref, async (offset, limit) => {
  const end = Math.min(retained.length, offset + limit);return {reference, offset, data_base64: retained.subarray(offset, end).toString("base64"), ...(end < retained.length ? {next_offset: end} : {})};
}, options);};
const complete = await resolveHcpPortableItem(observation, read);
assert.equal(complete.source.native_item_reference, "fixture-item");assert.equal(complete.items[0].media.kind, "embedded");
assert.equal(createHash("sha256").update(Buffer.from(complete.items[0].media.data_base64, "base64")).digest("hex"), createHash("sha256").update(bytes).digest("hex"));
await assert.rejects(resolveHcpPortableItem(observation, read, {maxTotalBytes: retained.length - 1}));
await assert.rejects(resolveHcpPortableItem({...observation, items: [{...observation.items[0], body: {storage: "inline", value: {kind: "url", url: "file:///private/fixture"}}}]}, async () => {throw new Error("Media sources must not fetch URLs or files");}));
console.log("Packed public typed media fixture: complete binary image source, retained evidence, bounded hydration and unsupported-source refusal passed.");
