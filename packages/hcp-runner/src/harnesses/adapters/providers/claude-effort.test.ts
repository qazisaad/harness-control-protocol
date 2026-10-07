import assert from "node:assert/strict";
import {test} from "node:test";
import type {Query} from "@anthropic-ai/claude-agent-sdk";
import {claudeEffortControl} from "./claude-effort.js";
import {selectedEffort} from "./native-turn.js";

function fixture() {
  const flags: Record<string, unknown> = {};
  let clamp = false;
  const stream = {async applyFlagSettings(settings: Record<string, unknown>) {
    for (const [key, value] of Object.entries(settings)) if (value === null) delete flags[key]; else flags[key] = value;
  }, async reinitialize() {return {fast_mode_state: clamp ? "off" : flags.fastMode ? "on" : "off"};},
  async getSettings() {return {effective: {...flags}, applied: {model: "native-model", effort: flags.effortLevel ?? "high",
    ultracode: clamp ? false : flags.ultracode ?? false}, sources: [{source: "flagSettings", settings: {...flags}}]};}};
  return {stream: stream as unknown as Query, flags, clamp: () => {clamp = true;}};
}

test("session boolean options require exact native effective settings and preserve actual model", async () => {
  const f = fixture();
  const effective = await claudeEffortControl(f.stream, "xhigh", {thinking: false, ultracode: true})();
  assert.deepEqual(effective, {model: "native-model", effort: "xhigh", booleans: {thinking: false, ultracode: true}});
  assert.deepEqual(f.flags, {effortLevel: "xhigh", alwaysThinkingEnabled: false, ultracode: true});
});
test("removal clears the flag layer and reports observed native defaults", async () => {
  const f = fixture(); await claudeEffortControl(f.stream, "xhigh", {thinking: false, ultracode: true})();
  const effective = await claudeEffortControl(f.stream, undefined, {}, {thinking: false, ultracode: true})();
  assert.deepEqual(f.flags, {});
  assert.deepEqual(effective, {model: "native-model", effort: "high", booleans: {ultracode: false}});
});
test("native ultracode downgrade and missing effective thinking cannot be called confirmed", async () => {
  const f = fixture(); f.clamp();
  await assert.rejects(claudeEffortControl(f.stream, "xhigh", {ultracode: true})(), /effective ultracode/);
  const missing = {async applyFlagSettings() {}, async getSettings() {return {applied: {model: "model", effort: "high"},
    sources: [{source: "flagSettings", settings: {alwaysThinkingEnabled: false}}]};}} as unknown as Query;
  await assert.rejects(claudeEffortControl(missing, "high", {thinking: false})(), /native thinking/);
});
test("duplicate boolean options, non-boolean values and unknown options are refused", () => {
  assert.equal(selectedEffort({model: "model", options: [{id: "thinking", value: false}, {id: "ultracode", value: true}, {id: "effort", value: "xhigh"}]}, "claude"), "xhigh");
  for (const options of [[{id: "thinking", value: "false"}], [{id: "thinking", value: true}, {id: "thinking", value: false}], [{id: "other", value: true}]])
    assert.throws(() => selectedEffort({model: "model", options}, "claude"), /boolean|Duplicate|Unsupported/);
});
test("fast mode requires fresh native status and refuses account downgrades or cooldown", async () => {
  const f = fixture();
  assert.equal((await claudeEffortControl(f.stream, undefined, {fastMode: true})()).booleans?.fastMode, true);
  assert.equal((await claudeEffortControl(f.stream, undefined, {}, {fastMode: true})()).booleans?.fastMode, false);
  f.clamp(); await assert.rejects(claudeEffortControl(f.stream, undefined, {fastMode: true})(), /effective fast mode/);
  f.stream.reinitialize = async () => ({fast_mode_state: "cooldown"}) as never;
  await assert.rejects(claudeEffortControl(f.stream, undefined, {fastMode: true})(), /effective fast mode/);
});
