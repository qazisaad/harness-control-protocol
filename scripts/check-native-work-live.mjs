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
  const admitted = events.filter(event => event.turn_id === turn_id && event.event_type === "native.execution.admitted");
  assert.ok(admitted.length >= 1, "Native root execution identity was not observed");
  for (const event of admitted) {
    const retained = manager.stateStore().nativeWorkState("work").root_executions.find(value => value.admission_id === event.data.admission_id);
    assert.equal(retained.native_execution_reference, event.data.native_execution_reference);
    assert.equal(retained.origin_turn_id, turn_id);
  }
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
const childHistoryAcceptance = process.env.HCP_LIVE_CHILD_HISTORY === "1";
const readChildHistory = async (workId, requireItems = false) => until(async () => {
  const current = (await work()).items.find(item => item.work.work_id === workId)?.work;
  assert.ok(current);
  try {
    const result = await manager.conversationOperation(randomUUID(), {session_id: "work", operation: {
      kind: "work", action: "history", work_id: workId, expected_revision: current.revision, limit: 1}});
    assert.equal(result.work?.action, "history"); assert.equal(result.work.work_id, workId);
    assert.equal(result.work.source, "native"); assert.equal(result.work.owner_status, "active");
    assert.equal(result.work.revision, current.revision);
    assert.ok(result.work.history.turn_count >= 1);
    assert.equal(result.work.history.turns.length, 1);
    assert.ok(Array.isArray(result.work.history.turns[0].portable_items));
    if (requireItems) assert.ok(result.work.history.turns[0].portable_items.length);
    return result.work.history;
  } catch (error) {
    if (["native_work_changed", "native_history_changed"].includes(error?.code)) return false;
    throw error;
  }
}, 15000);
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
  const settingsAcceptance = ["codex", "opencode"].includes(driver) && process.env.HCP_LIVE_SETTINGS === "1";
  const first = await spawn(driver === "opencode" ? "background-interruption" : "background-completion", settingsAcceptance ? 90 : 30);
  const history = await manager.conversationOperation("background-live-read", {session_id: "work", operation: {kind: "read"}});
  assert.ok(history.history?.turn_count >= 1, "A live background owner lost its readable root history");
  passed.push("live-history-with-background");
  if (childHistoryAcceptance) {
    await readChildHistory(first.work_id);
    assert.ok((await work()).items.some(item => item.work.work_id === first.work_id && !isNativeWorkTerminal(item.work.status)));
    passed.push("live-owned-child-history", "child-history-preserves-background");
  }
  await manager.sendTurn({session_id: "work", turn_id: "interrupted-root", input: "Without tools, print the integers from 1 through 10000, one per line. Start immediately and continue without commentary."}, observe);
  assert.ok(interrupt, "No streaming root was available to interrupt");
  await interrupt;
  assert.equal(events.findLast(event => event.turn_id === "interrupted-root" && ["turn.completed", "turn.failed", "turn.cancelled"].includes(event.event_type))?.event_type, "turn.cancelled");
  let completionChild = first;
  if (driver === "opencode") {
    await until(async () => (await work()).items.find(item => item.work.work_id === first.work_id && item.work.status === "cancelled"));
    passed.push("root-interruption-cancels-owned-background");
    completionChild = await spawn("background-completion", settingsAcceptance ? 90 : 30);
  } else {
    assert.ok((await work()).items.some(item => item.work.work_id === first.work_id && !isNativeWorkTerminal(item.work.status)), "Root interruption stopped its independent background child");
    passed.push("root-interruption-preserves-background");
  }
  if (settingsAcceptance && driver === "codex") {
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
  if (settingsAcceptance && driver === "opencode") {
    const alternative = process.env.HCP_LIVE_OPENCODE_ALTERNATIVE_MODEL ?? "opencode-go/glm-5.3";
    const status = (await manager.providerDriverStatuses()).find(value => value.driver_kind === driver);
    assert.ok(status.models.some(value => value.id === alternative), "The alternate model is not in the current native catalog");
    for (const [turn, selected] of [["model-changed", alternative], ["model-restored", model]]) {
      assert.ok((await work()).items.find(item => item.work.work_id === completionChild.work_id && !isNativeWorkTerminal(item.work.status)), "Model test requires the same running child");
      await send(turn, "Reply READY only. Do not use tools or wait for a child.", {model_selection: {model: selected}});
      const observed = events.find(event => event.turn_id === turn && event.event_type === "settings.options.effective");
      assert.ok(observed); assert.equal(observed.data.scope, "root"); assert.equal(observed.data.source, "native");
      assert.equal(observed.data.model_selection.model, selected);
      assert.ok((await work()).items.find(item => item.work.work_id === completionChild.work_id && !isNativeWorkTerminal(item.work.status)), "Model update stopped or replaced the child");
      passed.push(`${turn}-with-background`);
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
  if (driver === "claude" && process.env.HCP_LIVE_ASYNC_OUTPUT === "1") {
    const output = await until(async () => events.find(event => event.event_type === "native.output.updated"), 60000);
    assert.equal(output.turn_id, undefined); assert.equal(output.data.output.correlation, "unattributed");
    const content = await manager.conversationOperation("native-async-output", {session_id: "work", operation: {
      kind: "content", content_id: output.data.output.content_ref.content_id, offset: 0, limit: 65536}});
    assert.equal(JSON.parse(Buffer.from(content.content.data_base64, "base64").toString()).role, "assistant");
    passed.push("native-session-output", "unattributed-output-content");
  }
  if (childHistoryAcceptance) {await readChildHistory(completionChild.work_id, true); passed.push("completed-child-history");}
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
  if (process.env.HCP_LIVE_RETAINED_CHILD_HISTORY === "1" || process.env.HCP_LIVE_CHILD_FORK === "1") {
    assert.ok(["codex", "opencode"].includes(driver), "This retained/fork acceptance requires Codex or controlled OpenCode");
    const retained = new HarnessSessionManager(config, {stateStore: new JsonRunnerStateStore(join(cwd, "state.json"))});
    const before = await retained.conversationOperation(randomUUID(), {session_id: "work", operation: {kind: "work", action: "read"}});
    const child = before.work.items.find(item => item.work.work_id === completionChild.work_id).work;
    const history = await retained.conversationOperation(randomUUID(), {session_id: "work", operation: {kind: "work", action: "history",
      owner: "retained", work_id: child.work_id, expected_revision: child.revision}});
    assert.equal(history.work.owner_status, "retained");
    assert.ok(history.work.history.turn_count > 0);
    assert.equal(retained.activeSessionCount(), 0);
    const after = await retained.conversationOperation(randomUUID(), {session_id: "work", operation: {kind: "work", action: "read"}});
    assert.deepEqual(after.work, before.work, "Transcript inspection must not change execution ownership or status");
    passed.push("retained-child-history-after-runner-restart", "retained-history-does-not-recover-execution");
    if (process.env.HCP_LIVE_CHILD_FORK === "1") {
      const targetSession = randomUUID(), targetKey = randomUUID(), forkCommand = randomUUID();
      const forkRequest = {session_id: "work", operation: {kind: "work", action: "fork", work_id: child.work_id,
        expected_revision: child.revision, expected_history_hash: history.work.history.history_hash,
        target_session_id: targetSession, continuation_group_key: targetKey}};
      const fork = await retained.conversationOperation(forkCommand, forkRequest);
      assert.equal(fork.work.action, "fork");
      assert.notEqual(fork.work.fork.native_reference, child.native_reference);
      const restarted = new HarnessSessionManager(config, {stateStore: new JsonRunnerStateStore(join(cwd, "state.json"))});
      assert.deepEqual(await restarted.conversationOperation(forkCommand, forkRequest), fork);
      const targetHistory = await restarted.conversationOperation(randomUUID(), {session_id: targetSession, operation: {kind: "read"}});
      if (driver === "codex") assert.equal(targetHistory.history.history_hash, history.work.history.history_hash);
  else {
    // OpenCode assigns fresh message/part IDs on fork; compare every retained field except those IDs.
    const context = value => {
      assert.equal(value.truncated, false); assert.equal(value.turns.length, value.turn_count);
      return value.turns.map(turn => {
        assert.equal(turn.items_ref, undefined);
        return {status: turn.status, items: turn.items.map(({id: _id, ...item}) => item)};
      });
    };
    assert.deepEqual(context(targetHistory.history), context(history.work.history));
  }
      await restarted.startSession({session_id: targetSession, workspace_id: "workspace", provider_instance_id: driver,
        driver_kind: driver, cwd, execution_profile: driver === "opencode" ? "background" : "interactive", sandbox_mode: "danger_full_access", approval_policy: "full_access",
        ...(driver === "opencode" ? {configuration_inheritance: {user_settings: false, project_settings: false, hooks: false, mcp_servers: false, plugins: false}} : {}),
        continue_session: true, continuation_group_key: targetKey, model_selection: {model}, mcp_servers: []});
      try {
        const output = await restarted.sendTurn({session_id: targetSession, turn_id: "fork-followup",
          input: "Reply FORK_READY only. Use no tools."});
        assert.ok(output.some(event => event.event_type === "turn.completed"));
        assert.equal(restarted.activeSessionCount(), 1);
      } finally {await restarted.stopSession(targetSession, "fork-acceptance-complete");}
      assert.deepEqual((await restarted.conversationOperation(randomUUID(), {session_id: "work", operation: {kind: "work", action: "read"}})).work,
        before.work, "Fork/continuation must not revive or mutate source child execution");
      passed.push("child-fork-retains-selected-history", "child-fork-durable-receipt", "independent-child-fork-continuation");
    }
  }
  console.log(JSON.stringify({driver, passed, cwd, event_count: events.length}));
} catch (error) {
  process.exitCode = 1;
  console.error(JSON.stringify({driver, passed, cwd, failed: true, code: error?.code ?? "acceptance_failure"}));
} finally {
  if (manager.activeSessionCount()) try {await manager.stopSession("work", "live-work-cleanup");} catch {console.error(JSON.stringify({driver, cleanup_failed: true})); process.exitCode = 1;}
  unsubscribe(); await writeFile(join(cwd, "events.json"), JSON.stringify(events, null, 2));
}
