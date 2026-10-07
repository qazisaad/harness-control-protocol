import assert from "node:assert/strict";
import {test} from "node:test";
import {harnessUsageSnapshotSchema, type HarnessUsageSnapshot} from "@harness-control/protocol";
import {CodexRootUsage} from "./codex-root-usage.js";
const counts = (input = 10, output = 5) => ({inputTokens: input, outputTokens: output, totalTokens: input + output,
  cachedInputTokens: 2, reasoningOutputTokens: 1, cacheWriteInputTokens: 1});
test("Codex fresh-root usage accumulates cumulative deltas once and keeps physical phases separate", () => {
  const usage = new CodexRootUsage("root", true); usage.begin("one");
  usage.observe("one", counts(), counts()); usage.observe("one", counts(), counts());
  const total = {...counts(20, 10), cachedInputTokens: 4, reasoningOutputTokens: 2, cacheWriteInputTokens: 2};
  usage.observe("one", counts(), total);
  assert.equal(usage.snapshot().status, "partial");
  assert.deepEqual(usage.snapshot(true), {actor: "root", scope: "turn", source: "codex.thread.tokenUsage.owned_delta",
    native_reference: "root", native_execution_reference: "one", status: "complete", input_tokens: 20, output_tokens: 10,
    total_tokens: 30, cached_input_tokens: 4, reasoning_output_tokens: 2, cache_creation_input_tokens: 2});
  usage.begin("two"); assert.equal(usage.snapshot(true).status, "unavailable");
  usage.observe("two", counts(), {...counts(30, 15), cachedInputTokens: 6, reasoningOutputTokens: 3, cacheWriteInputTokens: 3});
  assert.equal((usage.snapshot(true) as HarnessUsageSnapshot).input_tokens, 10); harnessUsageSnapshotSchema.parse(usage.snapshot(true));
});
test("Codex retained or reset counters preserve only observed evidence and cannot claim complete", () => {
  const usage = new CodexRootUsage("root", false); usage.begin("one");
  usage.observe("one", counts(), counts(100, 50));
  assert.equal(usage.snapshot(true).status, "partial"); assert.equal((usage.snapshot(true) as HarnessUsageSnapshot).input_tokens, 10);
  usage.observe("one", counts(), counts());
  assert.equal((usage.snapshot(true) as HarnessUsageSnapshot).input_tokens, 20); assert.equal(usage.snapshot(true).status, "partial");
});
test("Codex foreign phase updates and malformed subsets cannot be charged to the live phase", () => {
  const usage = new CodexRootUsage("root", true); usage.begin("live");
  usage.observe("old", counts(), counts()); assert.equal(usage.snapshot(true).status, "unavailable");
  usage.observe("live", counts(), {...counts(), cachedInputTokens: 100});
  assert.equal(usage.snapshot(true).status, "unavailable");
  usage.observe("live", counts(), counts(20, 10));
  assert.equal(usage.snapshot(true).status, "partial"); assert.equal((usage.snapshot(true) as HarnessUsageSnapshot).input_tokens, 10);
});
