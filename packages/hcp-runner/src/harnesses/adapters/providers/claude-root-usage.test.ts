import assert from "node:assert/strict";
import {test} from "node:test";
import {harnessUsageSnapshotSchema} from "@harness-control/protocol";
import {claudeRootUsage} from "./claude-root-usage.js";

const result = {subtype: "success", is_error: false, usage: {input_tokens: 10, output_tokens: 5,
  cache_read_input_tokens: 20, cache_creation_input_tokens: 4, output_tokens_details: {thinking_tokens: 2}},
  modelUsage: {other: {inputTokens: 999999}}, total_cost_usd: 123};
test("Claude root result billing includes cache subsets once and excludes child aggregates and total cost", () => {
  const value = claudeRootUsage("native-session", result, true);
  assert.deepEqual(value, {actor: "root", scope: "turn", source: "claude.sdk.result.usage", native_reference: "native-session",
    status: "complete", input_tokens: 34, output_tokens: 5, total_tokens: 39, cached_input_tokens: 20,
    cache_creation_input_tokens: 4, reasoning_output_tokens: 2});
  harnessUsageSnapshotSchema.parse(value);
});
test("Claude failures and missing cache evidence remain partial without invented zeros or execution IDs", () => {
  assert.equal(claudeRootUsage("native-session", {...result, subtype: "error_max_turns", is_error: true}, false).status, "partial");
  const partial = claudeRootUsage("native-session", {...result, usage: {input_tokens: 10, output_tokens: 5}}, true);
  assert.equal(partial.status, "partial"); assert.equal("input_tokens" in partial, false);
  assert.equal("native_execution_reference" in partial, false);
  harnessUsageSnapshotSchema.parse(partial);
});
test("Claude absent, malformed, overflowing or contradictory counters cannot become billing evidence", () => {
  for (const usage of [undefined, {}, {input_tokens: -1}, {output_tokens: 5, output_tokens_details: {thinking_tokens: 6}},
    {input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 5, cache_read_input_tokens: 1, cache_creation_input_tokens: 1}]) {
    const value = claudeRootUsage("native-session", {...result, usage}, true);
    assert.equal(value.status, "unavailable"); harnessUsageSnapshotSchema.parse(value);
  }
});
