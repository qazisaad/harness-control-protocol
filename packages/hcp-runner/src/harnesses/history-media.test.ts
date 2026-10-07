import assert from "node:assert/strict";
import {test} from "node:test";
import {nativeHistoryMedia} from "./history-media.js";
import {portableHistoryItem} from "./portable-history.js";

test("native media normalization preserves known sources without reading files or resolving URLs", () => {
  const body = {kind: "embedded", mime_type: "image/png", data_base64: "AQID"};
  for (const [namespace, source] of [["codex", {type: "image", url: "data:image/png;base64,AQID"}],
    ["claude", {type: "image", source: {type: "base64", media_type: "image/png", data: "AQID"}}],
    ["opencode", {type: "file", mime: "image/png", url: "data:image/png;base64,AQID"}]] as const)
    assert.deepEqual(nativeHistoryMedia(source, namespace), {media_kind: "image", source: body});
  assert.deepEqual(nativeHistoryMedia({type: "localImage", path: "/native/fixture.png"}, "codex"), {media_kind: "image", source: {kind: "path", path: "/native/fixture.png"}});
  assert.deepEqual(nativeHistoryMedia({type: "image", fileId: "actual-native-file"}, "codex"), {media_kind: "image", source: {kind: "native_reference", reference: "actual-native-file"}});
  assert.deepEqual(nativeHistoryMedia({type: "file", mime: "application/pdf", filename: "Observed.pdf", url: "https://example.test/observed.pdf"}, "opencode"),
    {media_kind: "file", source: {kind: "url", mime_type: "application/pdf", filename: "Observed.pdf", url: "https://example.test/observed.pdf"}});
});
test("unknown or unsafe media records remain explicit extensions without invented native identity", () => {
  for (const block of [{type: "image", url: "javascript:alert(1)"}, {type: "image", url: "data:image/png;base64,AR=="},
    {type: "localImage", path: "bad\0path"}, {type: "image", fileId: ""}, {type: "unknown", url: "https://example.test/unknown"}]) {
    assert.equal(nativeHistoryMedia(block, "codex"), undefined);
    const rows = portableHistoryItem({id: "message", type: "userMessage", content: [block]}, "codex", "unused");
    assert.equal(rows[1]?.type, "extension");assert.equal(rows[1]?.native_item_reference, "message");
  }
  const row = portableHistoryItem({id: "display-only", type: "native_media", content: {type: "image", source: {type: "base64", media_type: "image/png", data: "AQID"}}}, "claude", "unused")[0]!;
  assert.equal(row.type, "attachment");assert.equal(row.native_item_reference, undefined);
});
