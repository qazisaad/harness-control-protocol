import assert from "node:assert/strict";
import {test} from "node:test";
import {OpenCodeUsage, openCodeMessageId} from "./adapters/providers/opencode-usage.js";
import {harnessUsageSnapshotSchema} from "@harness-control/protocol";

const step = (id: string, messageID: string, sessionID = "session") => ({id, messageID, sessionID, type: "step-finish",
  cost: 0.5, tokens: {input: 10, output: 3, reasoning: 2, cache: {read: 20, write: 4}}});
const message = (id: string, parentID: string, sessionID = "session") => ({id, parentID, sessionID, role: "assistant"});

test("OpenCode usage correlates admission, tolerates reordered events, excludes unrelated steps and deduplicates", () => {
  const usage = new OpenCodeUsage("session", "prompt");
  usage.part(step("a", "answer")); usage.part(step("a", "answer"));
  assert.equal(usage.snapshot(), undefined);
  usage.message(message("answer", "prompt"));
  usage.message(message("old-answer", "old-prompt")); usage.part(step("old", "old-answer"));
  usage.message(message("foreign-answer", "prompt", "other-session")); usage.part(step("foreign", "foreign-answer", "other-session"));
  const measured = usage.snapshot();
  assert.deepEqual(measured, {scope: "turn", status: "complete", source: "opencode.message.step-finish",
    input_tokens: 34, output_tokens: 5, total_tokens: 39, cached_input_tokens: 20, cache_creation_input_tokens: 4, reasoning_output_tokens: 2, cost_usd: 0.5});
  harnessUsageSnapshotSchema.parse(measured);
  usage.part(step("unknown", "unknown-answer"));
  assert.equal(usage.snapshot()?.status, "partial");
  usage.message(message("unknown-answer", "another-prompt"));
  assert.equal(usage.snapshot()?.status, "complete");
});

test("conflicting repeated usage or ownership cannot turn an uncertain count into complete evidence", () => {
  const usage = new OpenCodeUsage("session", "prompt");
  usage.message(message("answer", "prompt")); usage.part(step("a", "answer"));
  usage.part({...step("a", "answer"), cost: 9}); usage.message(message("answer", "other"));
  assert.equal(usage.snapshot()?.status, "partial");
  assert.equal(usage.snapshot()?.cost_usd, 0.5);
});

test("admitted OpenCode message identities are ordered and unique", () => {
  const ids = Array.from({length: 10_000}, openCodeMessageId);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual([...ids].sort(), ids);
  assert.ok(ids.every(id => /^msg_[a-f0-9]{40}$/.test(id)));
});
