import assert from "node:assert/strict";
import {test} from "node:test";
import {query} from "@anthropic-ai/claude-agent-sdk";
import {mkdtemp, realpath} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {claudeEffortControl} from "./claude-effort.js";

test("installed Claude confirms thinking and ultracode opt-out without any model prompt", {
  skip: process.env.HCP_NATIVE_CLAUDE_OPTIONS !== "1", timeout: 25_000,
}, async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "hcp-native-claude-options-")));
  let finish: (() => void) | undefined;
  const prompt = {async *[Symbol.asyncIterator]() {await new Promise<void>(resolve => {finish = resolve;});}};
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), 20_000);
  const stream = query({prompt, options: {cwd, abortController, settingSources: [], settings: {disableAllHooks: true},
    strictMcpConfig: true, mcpServers: {}, persistSession: false,
    pathToClaudeCodeExecutable: process.env.HCP_LIVE_CLAUDE_EXECUTABLE ?? "/tmp/hcp-native-acceptance-tools/node_modules/.bin/claude"}});
  const observed: string[] = [];
  const pump = (async () => {for await (const message of stream) observed.push(message.type);})();
  void pump.catch(() => {});
  try {
    await stream.initializationResult();
    const effective = await claudeEffortControl(stream, undefined, {thinking: false, ultracode: false, fastMode: false})();
    assert.deepEqual(effective.booleans, {thinking: false, ultracode: false, fastMode: false});
    const reset = await claudeEffortControl(stream, undefined, {}, {thinking: false, ultracode: false, fastMode: false})();
    assert.equal(reset.booleans?.ultracode, false);
    assert.equal(observed.includes("assistant"), false); assert.equal(observed.includes("result"), false);
    console.log(JSON.stringify({driver: "claude", scenario: "no-model-native-options", cwd,
      passed: ["native-thinking-opt-out", "native-ultracode-opt-out", "native-fast-mode-opt-out", "flag-override-removal", "no-model-prompt"]}));
  } finally {clearTimeout(timer); finish?.(); stream.close(); abortController.abort(); await pump.catch(() => {});}
});
