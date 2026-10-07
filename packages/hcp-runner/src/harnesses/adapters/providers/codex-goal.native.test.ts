import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtemp, realpath} from "node:fs/promises";
import {tmpdir, homedir} from "node:os";
import {join} from "node:path";
import {CodexRpc} from "./codex-rpc.js";
import {CodexGoalOwner, codexGoalSchema} from "./codex-goal.js";
import {materializeEmptyCodexConversation} from "./codex-runtime.js";
import {z} from "zod";

// A no-model native contract check. Autonomous execution has separate acceptance.
test("installed Codex admits a durable paused goal without dispatching a model turn", {
  skip: process.env.HCP_NATIVE_GOAL_CONTROL !== "1", timeout: 30_000,
}, async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "hcp-native-goal-controls-")));
  const rpc = new CodexRpc(process.env.HCP_LIVE_CODEX_EXECUTABLE ?? join(homedir(), ".local/bin/codex"), cwd, process.env);
  const evidence: string[] = [];
  let inspector: CodexRpc | undefined;
  const turns: string[] = [];
  rpc.observeNotifications(message => {if (message.method?.startsWith("turn/")) turns.push(message.method);});
  try {
    const signal = AbortSignal.timeout(20_000);
    await rpc.request("initialize", {clientInfo: {name: "hcp-native-goal-controls", version: "0.5.0"},
      capabilities: {experimentalApi: true}}, {signal});
    rpc.notify("initialized");
    const threadId = z.object({thread: z.object({id: z.string()})}).parse(await rpc.request("thread/start", {
      cwd, sandbox: "workspace-write", approvalPolicy: "on-request", approvalsReviewer: "user",
      ephemeral: false, dynamicTools: [], config: {"features.apps": false},
    }, {signal})).thread.id;
    await materializeEmptyCodexConversation(rpc, threadId, cwd);
    const owner = new CodexGoalOwner(rpc, threadId, {reserve() {evidence.push("reserve");},
      confirm() {evidence.push("confirm");}, updated() {evidence.push("update");}});
    const admitted = await owner.prepare("Inspect a paused goal; do not execute it.", 50, signal);
    assert.equal(admitted.status, "paused"); assert.equal(admitted.tokenBudget, 50);
    const readback = z.object({goal: codexGoalSchema}).parse(await rpc.request("thread/goal/get", {threadId}, {signal})).goal;
    assert.equal(readback.createdAt, admitted.createdAt); assert.equal(readback.tokensUsed, 0);
    assert.equal(readback.timeUsedSeconds, 0); assert.equal(owner.active, false);
    await owner.pause(); assert.deepEqual(evidence, ["reserve", "confirm"]);
    await rpc.process.stop();
    inspector = new CodexRpc(process.env.HCP_LIVE_CODEX_EXECUTABLE ?? join(homedir(), ".local/bin/codex"), cwd, process.env);
    await inspector.request("initialize", {clientInfo: {name: "hcp-native-goal-inspector", version: "0.5.0"},
      capabilities: {experimentalApi: true}}, {signal}); inspector.notify("initialized");
    const retained = z.object({goal: codexGoalSchema}).parse(await inspector.request("thread/goal/get", {threadId}, {signal})).goal;
    assert.equal(retained.createdAt, admitted.createdAt); assert.equal(retained.status, "paused"); assert.equal(retained.tokensUsed, 0);
    await inspector.request("thread/goal/clear", {threadId}, {signal});
    assert.equal(z.object({goal: z.null().optional()}).parse(await inspector.request("thread/goal/get", {threadId}, {signal})).goal ?? null, null);
    assert.deepEqual(turns, []);
    console.log(JSON.stringify({driver: "codex", scenario: "paused-native-goal-control", cwd,
      passed: ["paused-creation", "native-generation-readback", "explicit-token-budget", "zero-model-usage", "read-before-native-resume", "explicit-clear"]}));
  } finally {await rpc.process.stop(); await inspector?.process.stop();}
});
