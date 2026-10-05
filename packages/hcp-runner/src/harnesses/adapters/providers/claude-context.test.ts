import assert from "node:assert/strict";
import {test} from "node:test";
import {claudeContextCapacity} from "./claude-context.js";
import {measuredContext, unavailableContext} from "./native-context.js";

test("Claude context capacity is bound to the root model and never inferred from alias or child usage", () => {
  const context = measuredContext({model: "sonnet"}, "claude.sdk.assistant.usage", 42);
  const usages = {"native-sonnet": {contextWindow: 200_000}, "native-child": {contextWindow: 1_000_000}};
  const bound = claudeContextCapacity(context, "native-sonnet", usages);
  assert.equal(bound.status === "measured" && bound.capacity_tokens, 200_000);
  assert.equal(bound.status === "measured" && bound.used_tokens, 42);
  assert.deepEqual(claudeContextCapacity(context, "sonnet", usages), context);
  assert.deepEqual(claudeContextCapacity(context, undefined, usages), context);
  assert.deepEqual(claudeContextCapacity(context, "native-sonnet", {"native-sonnet": {contextWindow: -1}}), context);
  const unavailable = unavailableContext({model: "sonnet"}, "missing");
  assert.deepEqual(claudeContextCapacity(unavailable, "native-sonnet", usages), unavailable);
});
