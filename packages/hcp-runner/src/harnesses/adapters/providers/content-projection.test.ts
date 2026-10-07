import assert from "node:assert/strict";
import {test} from "node:test";
import {retainedFinalText} from "./content-projection.js";
import {BoundedHarnessContentStore} from "../../content-store.js";

test("small native final text explicitly reports a complete body, including empty text and literal preview words", () => {
  for (const text of ["", "complete 🙂", "[preview truncated]"])
    assert.deepEqual(retainedFinalText(text), {final_text: text, final_text_truncated: false});
});
test("large unpublished final text remains an explicit unavailable preview without broken Unicode", () => {
  const output = retainedFinalText("🙂".repeat(70_000));
  assert.equal(output.final_text_truncated, true); assert.equal(output.final_text_ref, undefined);
  assert.equal(Buffer.from(output.final_text!, "utf8").toString("utf8"), output.final_text);
  assert.ok(Buffer.byteLength(output.final_text!) < 40_000);
});
test("large final text publishes one scoped authoritative text body with an explicit final-text reference", () => {
  const store = new BoundedHarnessContentStore(), text = "🙂".repeat(70_000);
  let publications = 0;
  const output = retainedFinalText(text, value => {publications++;return store.publish({session_id: "session", provider_instance_id: "provider", provider_binding_hash: "hash", workspace_id: "workspace", cwd: "/workspace"}, value);});
  assert.equal(publications, 1); assert.equal(output.final_text_truncated, true); assert.deepEqual(output.final_text_ref, output.content_ref);
  assert.equal(output.final_text_ref?.format, "text"); assert.equal(output.final_text_ref?.byte_length, Buffer.byteLength(text));
  assert.throws(() => store.read("foreign", output.final_text_ref!.content_id, 0, 100), /another session/);
});
