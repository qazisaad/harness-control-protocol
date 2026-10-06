import assert from "node:assert/strict";
import {mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {query} from "@anthropic-ai/claude-agent-sdk";
import {claudeEffortControl} from "../packages/hcp-runner/dist/harnesses/adapters/providers/claude-effort.js";

if (process.env.HCP_NATIVE_LIVE !== "1") throw new Error("Set HCP_NATIVE_LIVE=1 for native acceptance.");
const cwd = await mkdtemp(join(tmpdir(), "hcp-live-claude-options-"));
let unblock;
const gate = new Promise(resolve => {unblock = resolve;});
const prompt = (async function* () {await gate;})();
const stream = query({prompt, options: {cwd, model: process.env.HCP_LIVE_CLAUDE_MODEL ?? "sonnet", effort: "low",
  settingSources: [], settings: {disableAllHooks: true}, strictMcpConfig: true, mcpServers: {}, persistSession: false}});
let expired = false;
const timer = setTimeout(() => {expired = true; stream.close(); unblock();}, 30_000);
const passed = [];
try {
  await stream.initializationResult();
  for (const effort of ["low", "high"]) {
    const effective = await claudeEffortControl(stream, effort)();
    assert.equal(effective.effort, effort);
    passed.push(`${effort}-native-readback`);
  }
  const reset = await claudeEffortControl(stream, undefined)();
  assert.ok(reset.model);
  passed.push("removed-session-override", "restored-native-default", "zero-model-turns");
  assert.equal(expired, false);
  console.log(JSON.stringify({driver: "claude", passed, cwd, restored_effort: reset.effort}));
} finally {clearTimeout(timer); stream.close(); unblock();}
