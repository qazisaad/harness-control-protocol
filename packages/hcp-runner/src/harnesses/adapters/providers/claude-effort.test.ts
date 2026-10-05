import {test} from "node:test";
import assert from "node:assert/strict";
import type {Query} from "@anthropic-ai/claude-agent-sdk";
import {claudeEffortControl} from "./claude-effort.js";

test("Claude effort updates require effective native readback after a session flag update", async () => {
  const calls: string[] = [];
  const runtime = {async applyFlagSettings(settings: {effortLevel: string}) {calls.push(settings.effortLevel);},
    async getSettings() {calls.push("read"); return {applied: {effort: "low"}, sources: {secret: "never expose"}};}} as unknown as Query;
  await claudeEffortControl(runtime, "low")();
  assert.deepEqual(calls, ["low", "read"]);
  await assert.rejects(claudeEffortControl(runtime, "max")(), /did not confirm/);
});

test("unsupported readback and effort reset are refused before any native mutation", () => {
  let mutations = 0;
  const runtime = {async applyFlagSettings() {mutations++;}} as unknown as Query;
  assert.throws(() => claudeEffortControl(runtime, "low"), /readback/);
  assert.throws(() => claudeEffortControl(runtime, undefined), /reset/);
  assert.equal(mutations, 0);
});
