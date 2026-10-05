import assert from "node:assert/strict";
import {mkdtemp, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {HarnessSessionManager} from "@harness-control/runner/harnesses";
import {RunnerConfigSchema} from "@harness-control/runner/config";
import {JsonRunnerStateStore} from "@harness-control/runner/state";
import {hcpHarnessEventPayloadSchema, isNativeWorkTerminal} from "@harness-control/protocol";

if (process.env.HCP_NATIVE_LIVE !== "1") throw new Error("Set HCP_NATIVE_LIVE=1 to run authenticated native acceptance.");
const cwd = await mkdtemp(join(tmpdir(), "hcp-live-claude-work-"));
const config = RunnerConfigSchema.parse({runner_id: "work-acceptance", control_plane_url: "ws://localhost:8787",
  workspaces: [{id: "workspace", path: cwd}], provider_instances: [{id: "claude", driver_kind: "claude"}]});
const manager = new HarnessSessionManager(config, {stateStore: new JsonRunnerStateStore(join(cwd, "state.json"))});
const events = [], seen = new Set();
const observe = event => {hcpHarnessEventPayloadSchema.parse(event); if (seen.has(event.sequence)) return; seen.add(event.sequence); events.push(event);};
const unsubscribe = manager.subscribeEvents(observe);
const work = async () => {
  const result = await manager.conversationOperation(randomUUID(), {session_id: "work", operation: {kind: "work", action: "read"}});
  assert.equal(result.work?.action, "read"); return result.work;
};
const until = async (predicate, deadline = 120000) => {
  const end = Date.now() + deadline;
  while (Date.now() < end) {const result = await predicate(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 200));}
  throw new Error("Native work did not reach its expected observation before the deadline");
};
const send = async (turn_id, input) => {
  await manager.sendTurn({session_id: "work", turn_id, input}, observe);
  const terminal = events.findLast(event => event.turn_id === turn_id && ["turn.completed", "turn.failed", "turn.cancelled"].includes(event.event_type));
  assert.equal(terminal?.event_type, "turn.completed", JSON.stringify(terminal?.data));
};
const spawn = async (turn, seconds) => {
  const marker = randomUUID();
  console.log(JSON.stringify({driver: "claude", stage: turn, cwd}));
  const childPrompt = `Use Bash to run exactly: sleep ${seconds}; printf '%s' '${marker}'. Use no other tools, then return the command output.`;
  await send(turn, `Use Agent exactly once with run_in_background: true and this exact child prompt: ${childPrompt}\nAfter launching it, immediately reply ROOT_RETURNED. Do not wait for it, call other tools, or perform the child's work yourself.`);
  const owned = (await work()).items.find(item => item.work.origin_turn_id === turn && !isNativeWorkTerminal(item.work.status));
  assert.ok(owned, "No owned background child remained after root completion");
  assert.equal(owned.work.background, true);
  return owned.work;
};
const passed = [];
try {
  await manager.startSession({session_id: "work", workspace_id: "workspace", provider_instance_id: "claude", driver_kind: "claude", cwd,
    execution_profile: "interactive", sandbox_mode: "danger_full_access", approval_policy: "full_access", continue_session: false,
    model_selection: {model: process.env.HCP_LIVE_CLAUDE_MODEL ?? "sonnet"}, mcp_servers: []});
  const first = await spawn("background-completion", 15);
  await send("followup", "Reply FOLLOWUP only. Do not use tools or wait for the child.");
  await until(async () => (await work()).items.find(item => item.work.work_id === first.work_id && item.work.status === "completed"));
  passed.push("background-after-root", "followup-with-background", "observed-child-completion");
  const second = await spawn("background-cancel", 60);
  const request = {session_id: "work", operation: {kind: "work", action: "cancel", work_id: second.work_id, expected_revision: second.revision}};
  const controlId = randomUUID(), receipt = await manager.conversationOperation(controlId, request);
  assert.deepEqual(await manager.conversationOperation(controlId, request), receipt);
  await until(async () => (await work()).items.find(item => item.work.work_id === second.work_id && item.work.status === "cancelled"));
  passed.push("child-cancel", "duplicate-cancel-receipt", "observed-child-cancellation");
  await manager.stopSession("work", "live-work-complete");
  assert.equal(manager.activeSessionCount(), 0);
  passed.push("safe-unload");
  console.log(JSON.stringify({driver: "claude", passed, cwd, event_count: events.length}));
} catch (error) {
  process.exitCode = 1;
  console.error(JSON.stringify({driver: "claude", passed, cwd, failed: error instanceof Error ? error.message : String(error)}));
} finally {
  if (manager.activeSessionCount()) try {await manager.stopSession("work", "live-work-cleanup");} catch (error) {console.error(error.message); process.exitCode = 1;}
  unsubscribe(); await writeFile(join(cwd, "events.json"), JSON.stringify(events, null, 2));
}
