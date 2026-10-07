import assert from "node:assert/strict";
import {test} from "node:test";
import {createHash} from "node:crypto";
import {harnessImageFileReferenceSchema} from "@harness-control/protocol";
import {nativeTurnImages, validateNativeImageValues} from "./native-images.js";
const bytes = Buffer.alloc(600_000, 7);
const reference = harnessImageFileReferenceSchema.parse({file_id: "a".repeat(64), sha256: createHash("sha256").update(bytes).digest("hex"), filename: "fixture.png", mime_type: "image/png", byte_length: bytes.byteLength});
const payload = {session_id: "fixture", turn_id: "fixture", input: "", image_files: [reference]};
test("native image projection preserves exact owned bytes without relaxing the inline wire bound", () => {
  const images = nativeTurnImages({payload, inputFileImages: [{reference, data_base64: bytes.toString("base64")}]});
  assert.deepEqual(images, [{mime_type: "image/png", data_base64: bytes.toString("base64")}]);
  assert.throws(() => nativeTurnImages({payload: {session_id: "fixture", turn_id: "fixture", input: "", images}}), /exact bounded inline/);
});
test("native image projection refuses unresolved references, changed identity, corrupt bytes and oversized aggregate", () => {
  assert.throws(() => nativeTurnImages({payload}), /verified owned image bytes/);
  assert.throws(() => nativeTurnImages({payload, inputFileImages: [{reference: {...reference, filename: "changed.png"}, data_base64: bytes.toString("base64")}]}), /verified owned image bytes/);
  assert.throws(() => nativeTurnImages({payload, inputFileImages: [{reference, data_base64: Buffer.alloc(bytes.length, 8).toString("base64")}]}), /verified owned image bytes/);
  assert.throws(() => validateNativeImageValues([{mime_type: "application/pdf", data_base64: "AQ=="}]), /invalid/);
  assert.throws(() => validateNativeImageValues(Array.from({length: 101}, () => ({mime_type: "image/png", data_base64: "AQ=="}))), /invalid/);
});
