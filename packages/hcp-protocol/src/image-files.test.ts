import assert from "node:assert/strict";
import {test} from "node:test";
import {hcpTurnSendPayloadSchema, hcpSessionStartPayloadSchema} from "./index.js";
import {harnessImageFilesSchema, harnessOwnedImageInputsSchema} from "./image-files.js";
const reference = {file_id: "a".repeat(64), sha256: "b".repeat(64), filename: "fixture.png", mime_type: "image/png", byte_length: 600_000};
test("owned image references are bounded typed inputs and cannot accompany compaction or native goal resumption", () => {
  const turn = {session_id: "fixture", turn_id: "fixture", input: "", image_files: [reference]};
  assert.equal(hcpTurnSendPayloadSchema.safeParse(turn).success, true);
  assert.equal(hcpTurnSendPayloadSchema.safeParse({...turn, action: "compact"}).success, false);
  assert.equal(hcpTurnSendPayloadSchema.safeParse({...turn, goal: {action: "resume", expected_native_created_at: 1}}).success, false);
  for (const change of [{mime_type: "application/pdf"}, {byte_length: 0}, {byte_length: 10 * 1024 * 1024 + 1}, {path: "/untrusted/path"}])
    assert.equal(harnessImageFilesSchema.safeParse([{...reference, ...change}]).success, false);
  assert.equal(harnessOwnedImageInputsSchema.safeParse({max_bytes: 10 * 1024 * 1024, max_images: 100, max_total_bytes: 80 * 1024 * 1024, mime_types: ["image/png"]}).success, true);
});
test("owned and inline native images share one count and aggregate bound including first-turn admissions", () => {
  const owned = Array.from({length: 100}, () => ({...reference, byte_length: 1}));
  assert.equal(hcpTurnSendPayloadSchema.safeParse({session_id: "fixture", turn_id: "fixture", input: "", image_files: owned}).success, true);
  assert.equal(hcpTurnSendPayloadSchema.safeParse({session_id: "fixture", turn_id: "fixture", input: "", image_files: owned, images: [{mime_type: "image/png", data_base64: "AQ=="}]}).success, false);
  assert.equal(harnessImageFilesSchema.safeParse(Array.from({length: 9}, () => ({...reference, byte_length: 10 * 1024 * 1024}))).success, false);
  const start = {session_id: "fixture", workspace_id: "fixture", provider_instance_id: "fixture", driver_kind: "example", sandbox_mode: "read_only", approval_policy: "ask",
    continue_session: false, model_selection: {model: "fixture"}, mcp_servers: [], first_turn: {turn_id: "fixture", input: "", not_after: "2030-01-01T00:00:00Z", image_files: owned, images: [{mime_type: "image/png", data_base64: "AQ=="}]}};
  assert.equal(hcpSessionStartPayloadSchema.safeParse(start).success, false);
});
