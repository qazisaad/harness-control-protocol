import {test} from "node:test";
import assert from "node:assert/strict";
import type {Query} from "@anthropic-ai/claude-agent-sdk";
import {claudeEffortControl} from "./claude-effort.js";

test("Claude effort updates require effective native readback after a session flag update", async () => {
  const calls: string[] = [];
  const runtime = {async applyFlagSettings(settings: {effortLevel: string}) {calls.push(settings.effortLevel);},
    async getSettings() {calls.push("read"); return {applied: {model: "claude-sonnet", effort: "low"}, ignored: {secret: "never expose"}};}} as unknown as Query;
  assert.deepEqual(await claudeEffortControl(runtime, "low")(), {model: "claude-sonnet", effort: "low"});
  assert.deepEqual(calls, ["low", "read"]);
  await assert.rejects(claudeEffortControl(runtime, "max")(), /did not confirm/);
});

test("unsupported readback refuses effort changes and resets before any native mutation", () => {
  let mutations = 0;
  const runtime = {async applyFlagSettings() {mutations++;}} as unknown as Query;
  assert.throws(() => claudeEffortControl(runtime, "low"), /readback/);
  assert.throws(() => claudeEffortControl(runtime, undefined), /readback/);
  assert.equal(mutations, 0);
});

for (const restored of ["high", null] as const) test(`Claude effort reset confirms removed flag and reports native default ${restored}`, async () => {
  const calls: unknown[] = [];
  const runtime = {async applyFlagSettings(settings: unknown) {calls.push(settings);},
    async getSettings() {return {applied: {model: "claude-sonnet", effort: restored},
      sources: [{source: "flagSettings", settings: {disableAllHooks: true}},
        {source: "policySettings", settings: {effortLevel: "high"}}]};}} as unknown as Query;
  assert.deepEqual(await claudeEffortControl(runtime, undefined)(), {model: "claude-sonnet", effort: restored});
  assert.deepEqual(calls, [{effortLevel: null}]);
});

for (const sources of [undefined, [], [{source: "flagSettings", settings: {effortLevel: "low"}}],
  [{source: "flagSettings", settings: {effortLevel: null}}],
  [{source: "flagSettings", settings: {}}, {source: "flagSettings", settings: {}}]])
  test("Claude effort reset rejects absent, ambiguous or retained session override readback", async () => {
    const runtime = {async applyFlagSettings() {}, async getSettings() {
      return {applied: {model: "claude-sonnet", effort: "high"}, ...(sources ? {sources} : {})};
    }} as unknown as Query;
    await assert.rejects(claudeEffortControl(runtime, undefined)(), /removal/);
  });
