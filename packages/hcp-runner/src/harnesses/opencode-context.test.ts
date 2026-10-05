import assert from "node:assert/strict";
import {test} from "node:test";
import {openCodeContext} from "./adapters/providers/opencode-context.js";
import {harnessContextUsageSchema} from "@harness-control/protocol";

const selection = {model: "anthropic/claude", options: [{id: "variant", value: "high"}]};
const info = () => ({sessionID: "session", parentID: "prompt", role: "assistant", providerID: "anthropic", modelID: "claude", variant: "high",
  tokens: {input: 10, output: 3, reasoning: 2, cache: {read: 20, write: 4}}});

test("OpenCode context uses the final owned request's native counters rather than accumulated billing", () => {
  const result = openCodeContext(info(), "session", "prompt", selection);
  harnessContextUsageSchema.parse(result);
  assert.equal(result.status, "measured");
  if (result.status !== "measured") throw new Error("Expected measured context");
  assert.equal(result.used_tokens, 37);
  assert.equal(result.capacity_tokens, undefined);
  assert.equal(result.measurement_scope, "last_request");
  assert.deepEqual(result.selection, selection);
  const withTotal = openCodeContext({...info(), tokens: {...info().tokens, total: 52}}, "session", "prompt", selection);
  assert.equal(withTotal.status === "measured" && withTotal.used_tokens, 52);
  const zeroTotal = openCodeContext({...info(), tokens: {...info().tokens, total: 0}}, "session", "prompt", selection);
  assert.equal(zeroTotal.status === "measured" && zeroTotal.used_tokens, 37);
});

test("foreign, child, compaction and unconfirmed selection measurements remain unavailable", () => {
  for (const value of [{...info(), sessionID: "other"}, {...info(), parentID: "child-prompt"}, {...info(), role: "user"},
    {...info(), summary: true}, {...info(), modelID: "other"}, {...info(), variant: "low"}, {...info(), variant: undefined}, undefined]) {
    const result = openCodeContext(value, "session", "prompt", selection);
    assert.equal(result.status, "unavailable");
    assert.equal("used_tokens" in result, false);
  }
});

test("invalid native measurements cannot carry counts or terminate otherwise valid output", () => {
  for (const tokens of [{...info().tokens, input: -1}, {...info().tokens, output: NaN}, {...info().tokens, total: 0.5},
    {...info().tokens, input: Number.MAX_SAFE_INTEGER}, undefined]) {
    const result = openCodeContext({...info(), tokens}, "session", "prompt", selection);
    assert.equal(result.status, "unavailable");
    harnessContextUsageSchema.parse(result);
    assert.equal("used_tokens" in result, false);
  }
});
