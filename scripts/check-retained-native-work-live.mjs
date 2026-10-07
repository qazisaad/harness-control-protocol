import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {HarnessSessionManager} from "@harness-control/runner/harnesses";
import {RunnerConfigSchema} from "@harness-control/runner/config";
import {JsonRunnerStateStore} from "@harness-control/runner/state";

if (process.env.HCP_NATIVE_RETAINED_WORK_LIVE !== "1") throw new Error("Set HCP_NATIVE_RETAINED_WORK_LIVE=1 with a private completed acceptance workspace.");
const driver = process.env.HCP_LIVE_PROVIDER;
assert.ok(["codex", "opencode"].includes(driver));
const cwd = process.env.HCP_NATIVE_RETAINED_WORK_CWD, statePath = process.env.HCP_NATIVE_RETAINED_WORK_STATE;
assert.ok(cwd && statePath, "Select private acceptance workspace and state explicitly.");
const model = driver === "opencode" ? process.env.HCP_LIVE_OPENCODE_MODEL : process.env.HCP_LIVE_CODEX_MODEL;
assert.ok(model, "Select the previously accepted native model explicitly.");
const config = RunnerConfigSchema.parse({runner_id: "work-acceptance", control_plane_url: "ws://localhost:8787",
  workspaces: [{id: "workspace", path: cwd}], provider_instances: [{id: driver, driver_kind: driver}]});
const make = () => new HarnessSessionManager(config, {stateStore: new JsonRunnerStateStore(statePath)});
const manager = make();
const inventory = () => manager.conversationOperation(randomUUID(), {session_id: "work", operation: {kind: "work", action: "read"}});
const before = (await inventory()).work;
const child = before.items.find(item => item.work.kind === "agent" && item.work.status === "completed")?.work;
assert.ok(child, "The selected private acceptance state has no completed owned native child.");
const history = (await manager.conversationOperation(randomUUID(), {session_id: "work", operation: {kind: "work", action: "history",
  owner: "retained", work_id: child.work_id, expected_revision: child.revision}})).work;
assert.equal(history.owner_status, "retained"); assert.ok(history.history.turn_count > 0);
assert.equal(manager.activeSessionCount(), 0); assert.deepEqual((await inventory()).work, before);
const targetSession = randomUUID(), targetKey = randomUUID(), commandId = randomUUID();
const request = {session_id: "work", operation: {kind: "work", action: "fork", work_id: child.work_id,
  expected_revision: child.revision, expected_history_hash: history.history.history_hash,
  target_session_id: targetSession, continuation_group_key: targetKey}};
const fork = (await manager.conversationOperation(commandId, request)).work;
assert.equal(fork.action, "fork"); assert.notEqual(fork.fork.native_reference, child.native_reference);
const restarted = make();
assert.deepEqual((await restarted.conversationOperation(commandId, request)).work, fork);
const targetHistory = await restarted.conversationOperation(randomUUID(), {session_id: targetSession, operation: {kind: "read"}});
if (driver === "codex") assert.equal(targetHistory.history.history_hash, history.history.history_hash);
  else {
    // OpenCode assigns fresh message/part IDs on fork; compare every retained field except those IDs.
    const context = value => {
      assert.equal(value.truncated, false); assert.equal(value.turns.length, value.turn_count);
      return value.turns.map(turn => {
        assert.equal(turn.items_ref, undefined);
        return {status: turn.status, items: turn.items.map(({id: _id, ...item}) => item)};
      });
    };
    assert.deepEqual(context(targetHistory.history), context(history.history));
  }
try {
  await restarted.startSession({session_id: targetSession, workspace_id: "workspace", provider_instance_id: driver, driver_kind: driver,
    cwd, execution_profile: driver === "opencode" ? "background" : "interactive", sandbox_mode: "danger_full_access", approval_policy: "full_access",
    ...(driver === "opencode" ? {configuration_inheritance: {user_settings: false, project_settings: false, hooks: false, mcp_servers: false, plugins: false}} : {}),
    continue_session: true, continuation_group_key: targetKey, model_selection: {model}, mcp_servers: []});
  const events = await restarted.sendTurn({session_id: targetSession, turn_id: "fork-followup", input: "Reply FORK_READY only. Use no tools."});
  assert.ok(events.some(event => event.event_type === "turn.completed"));
  assert.equal(restarted.activeSessionCount(), 1);
} finally {if (restarted.activeSessionCount()) await restarted.stopSession(targetSession, "retained-fork-acceptance");}
assert.deepEqual((await restarted.conversationOperation(randomUUID(), {session_id: "work", operation: {kind: "work", action: "read"}})).work, before);
console.log(JSON.stringify({driver, cwd, passed: ["retained-child-history-after-restart", "retained-read-preserves-execution-unavailability",
  "hash-checked-child-fork", "independent-native-fork", "durable-fork-receipt-after-restart", "verified-fork-context", "independent-fork-continuation", "unchanged-source-custody", "confirmed-fork-unload"]}));
