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
const driver = process.env.HCP_LIVE_PROVIDER ?? "claude";
assert.ok(["claude", "codex", "opencode"].includes(driver), "Unknown native work provider");
const cwd = await mkdtemp(join(tmpdir(), `hcp-live-${driver}-work-`));
const config = RunnerConfigSchema.parse({runner_id: "work-acceptance", control_plane_url: "ws://localhost:8787",
  workspaces: [{id: "workspace", path: cwd}], provider_instances: [{id: driver, driver_kind: driver}]});
const manager = new HarnessSessionManager(config, {stateStore: new JsonRunnerStateStore(join(cwd, "state.json"))});
const events = [], seen = new Set();
let interrupt;
const observe = event => {
  hcpHarnessEventPayloadSchema.parse(event); if (seen.has(event.sequence)) return; seen.add(event.sequence); events.push(event);
  if (event.turn_id === "interrupted-root" && event.event_type === "content.delta" && !interrupt) {
    interrupt = manager.cancelTurn("work", "interrupted-root");
    void interrupt.catch(() => {});
  }
};
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
const send = async (turn_id, input, options = {}) => {
  await manager.sendTurn({session_id: "work", turn_id, input, ...options}, observe);
  const terminal = events.findLast(event => event.turn_id === turn_id && ["turn.completed", "turn.failed", "turn.cancelled"].includes(event.event_type));
  assert.equal(terminal?.event_type, "turn.completed", JSON.stringify(terminal?.data));
};
const spawn = async (turn, seconds) => {
  const marker = randomUUID();
  console.log(JSON.stringify({driver, stage: turn, cwd}));
  const childPrompt = `Use Bash to run exactly: sleep ${seconds}; printf '%s' '${marker}'. Use no other tools, then return the command output.`;
  await send(turn, driver === "claude"
    ? `Use Agent exactly once with run_in_background: true and this exact child prompt: ${childPrompt}\nAfter launching it, immediately reply ROOT_RETURNED. Do not wait for it, call other tools, or perform the child's work yourself.`
    : driver === "opencode"
      ? `Use task exactly once with background: true, subagent_type: general and this exact child prompt: ${childPrompt}\nAfter launching, immediately reply ROOT_RETURNED. Do not wait, poll or use other tools.`
      : `Spawn exactly one native child agent with this prompt: Use a shell tool to run exactly sleep ${seconds}; printf '%s' '${marker}'. Use no other tools, then return the output.\nAfter launching it, immediately reply ROOT_RETURNED. Do not wait, send follow-up messages or perform the child's work yourself.`);
  const owned = (await work()).items.find(item => item.work.origin_turn_id === turn && !isNativeWorkTerminal(item.work.status));
  assert.ok(owned, "No owned background child remained after root completion");
  assert.equal(owned.work.background, true);
  return owned.work;
};
const passed = [];
try {
  const model = driver === "claude" ? process.env.HCP_LIVE_CLAUDE_MODEL ?? "sonnet"
    : driver === "opencode" ? process.env.HCP_LIVE_OPENCODE_MODEL ?? "opencode-go/glm-5.3-flash"
      : process.env.HCP_LIVE_CODEX_MODEL ?? (await manager.providerDriverStatuses()).find(status => status.driver_kind === driver)?.models.find(model => model.is_default)?.id;
  assert.ok(model, "No verified default native model was discovered");
  await manager.startSession({session_id: "work", workspace_id: "workspace", provider_instance_id: driver, driver_kind: driver, cwd,
    execution_profile: driver === "opencode" ? "background" : "interactive",
    ...(driver === "opencode" ? {configuration_inheritance: {user_settings: false, project_settings: false, hooks: false, mcp_servers: false, plugins: false}} : {}),
    sandbox_mode: "danger_full_access", approval_policy: "full_access", continue_session: false, continuation_group_key: "live-work-history",
    model_selection: {model}, mcp_servers: []});
  const settingsAcceptance = driver === "codex" && process.env.HCP_LIVE_SETTINGS === "1";
  const first = await spawn(driver === "opencode" ? "background-interruption" : "background-completion", settingsAcceptance ? 90 : 30);
  const history = await manager.conversationOperation("background-live-read", {session_id: "work", operation: {kind: "read"}});
  assert.ok(history.history?.turn_count >= 1, "A live background owner lost its readable root history");
  passed.push("live-history-with-background");
  await manager.sendTurn({session_id: "work", turn_id: "interrupted-root", input: "Without tools, print the integers from 1 through 10000, one per line. Start immediately and continue without commentary."}, observe);
  assert.ok(interrupt, "No streaming root was available to interrupt");
  await interrupt;
  assert.equal(events.findLast(event => event.turn_id === "interrupted-root" && ["turn.completed", "turn.failed", "turn.cancelled"].includes(event.event_type))?.event_type, "turn.cancelled");
  let completionChild = first;
  if (driver === "opencode") {
    await until(async () => (await work()).items.find(item => item.work.work_id === first.work_id && item.work.status === "cancelled"));
    passed.push("root-interruption-cancels-owned-background");
    completionChild = await spawn("background-completion", 30);
  } else {
    assert.ok((await work()).items.some(item => item.work.work_id === first.work_id && !isNativeWorkTerminal(item.work.status)), "Root interruption stopped its independent background child");
    passed.push("root-interruption-preserves-background");
  }
  if (settingsAcceptance) {
    for (const effort of ["low", "high", null]) {
      assert.ok((await work()).items.find(item => item.work.work_id === first.work_id && !isNativeWorkTerminal(item.work.status)), "Settings test requires a still-running child");
      const turn = effort ? `settings-${effort}` : "settings-reset";
      await send(turn, "Reply READY only. Use no tools and do not wait for any child.", {model_selection: {model, options: effort ? [{id: "reasoningEffort", value: effort}] : []}});
      const observed = events.find(event => event.turn_id === turn && event.event_type === "settings.effective");
      assert.ok(observed); assert.equal(observed.data.scope, "root");
      assert.deepEqual(observed.data.model_selection.options, effort ? [{id: "reasoningEffort", value: effort}] : []);
      assert.ok((await work()).items.find(item => item.work.work_id === first.work_id && !isNativeWorkTerminal(item.work.status)), "Changing root settings stopped or replaced its child");
      passed.push(effort ? `effective-effort-${effort}-with-background` : "effective-effort-reset-with-background");
    }
  }
  await send("followup", "Reply FOLLOWUP only. Do not use tools or wait for the child.");
  await until(async () => (await work()).items.find(item => item.work.work_id === completionChild.work_id && item.work.status === "completed"));
  if (driver === "opencode") {
    await until(async () => {
      const related = (await work()).items.filter(item => item.work.origin_turn_id === "background-completion");
      return related.some(item => item.work.kind === "task") && related.every(item => isNativeWorkTerminal(item.work.status));
    });
    passed.push("observed-parent-continuation");
  }
  passed.push("background-after-root", "followup-with-background", "observed-child-completion");
  const launchedSecond = await spawn("background-cancel", 60);
  const second = await until(async () => (await work()).items.find(item => item.work.work_id === launchedSecond.work_id && item.work.supports_cancel)?.work);
  const request = {session_id: "work", operation: {kind: "work", action: "cancel", work_id: second.work_id, expected_revision: second.revision}};
  const controlId = randomUUID(), receipt = await manager.conversationOperation(controlId, request);
  assert.deepEqual(await manager.conversationOperation(controlId, request), receipt);
  await until(async () => (await work()).items.find(item => item.work.work_id === second.work_id && item.work.status === "cancelled"));
  passed.push("child-cancel", "duplicate-cancel-receipt", "observed-child-cancellation");
  if (driver === "opencode") await spawn("background-unload", 60);
  await manager.stopSession("work", "live-work-complete");
  assert.equal(manager.activeSessionCount(), 0);
  passed.push("safe-unload");
  console.log(JSON.stringify({driver, passed, cwd, event_count: events.length}));
} catch (error) {
  process.exitCode = 1;
  console.error(JSON.stringify({driver, passed, cwd, failed: error instanceof Error ? error.message : String(error)}));
} finally {
  if (manager.activeSessionCount()) try {await manager.stopSession("work", "live-work-cleanup");} catch (error) {console.error(error.message); process.exitCode = 1;}
  unsubscribe(); await writeFile(join(cwd, "events.json"), JSON.stringify(events, null, 2));
}
