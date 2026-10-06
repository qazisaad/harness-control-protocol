import assert from "node:assert/strict";
import {mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {HarnessSessionManager} from "@harness-control/runner/harnesses";
import {RunnerConfigSchema} from "@harness-control/runner/config";
import {JsonRunnerStateStore} from "@harness-control/runner/state";
import {hcpHarnessEventPayloadSchema} from "@harness-control/protocol";

if (process.env.HCP_NATIVE_LIVE !== "1") throw new Error("Set HCP_NATIVE_LIVE=1 to run authenticated native acceptance.");
const cwd = await mkdtemp(join(tmpdir(), "hcp-live-codex-commands-"));
const config = RunnerConfigSchema.parse({runner_id: "command-acceptance", control_plane_url: "ws://localhost:8787",
  workspaces: [{id: "workspace", path: cwd}], provider_instances: [{id: "codex", driver_kind: "codex"}]});
const manager = new HarnessSessionManager(config, {stateStore: new JsonRunnerStateStore(join(cwd, "state.json"))});
const events = [], passed = [];
const unsubscribe = manager.subscribeEvents(event => {hcpHarnessEventPayloadSchema.parse(event); events.push(event);});
const inventory = async () => (await manager.conversationOperation(randomUUID(), {session_id: "commands", operation: {kind: "work", action: "read"}})).work;
const wait = async predicate => {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100));}
  throw new Error("Owned command observation deadline expired.");
};
const send = async (turn_id, input) => {
  await manager.sendTurn({session_id: "commands", turn_id, input});
  assert.equal(events.findLast(event => event.turn_id === turn_id && ["turn.completed", "turn.failed", "turn.cancelled"].includes(event.event_type))?.event_type, "turn.completed");
};
const spawn = async turn => {
  await send(turn, "Use exec_command exactly once to run: sleep 35; printf 'HCP_COMMAND_DONE'. Set yield_time_ms to 1000. When it returns a still-running session, immediately reply ROOT_RETURNED. Do not wait, poll with write_stdin, spawn an agent or run any other tool.");
  const owned = (await inventory()).items.find(item => item.work.kind === "command" && item.work.origin_turn_id === turn && item.work.status === "running");
  assert.ok(owned, "No native background shell command remained after its root turn.");
  assert.equal(owned.work.background, true); return owned.work;
};
try {
  const model = process.env.HCP_LIVE_CODEX_MODEL ?? (await manager.providerDriverStatuses()).find(status => status.driver_kind === "codex")?.models.find(model => model.is_default)?.id;
  assert.ok(model);
  await manager.startSession({session_id: "commands", workspace_id: "workspace", cwd, provider_instance_id: "codex", driver_kind: "codex",
    model_selection: {model}, execution_profile: "interactive", approval_policy: "full_access", sandbox_mode: "danger_full_access",
    continue_session: false, continuation_group_key: "commands", mcp_servers: []});
  const first = await spawn("late-completion"); passed.push("owned-background-command");
  await send("independent-root", "Reply READY only. Use no tools and do not wait for background commands.");
  assert.ok((await inventory()).items.some(item => item.work.work_id === first.work_id)); passed.push("independent-followup-root");
  const completed = await wait(async () => (await inventory()).items.find(item => item.work.work_id === first.work_id && item.work.status === "completed")?.work);
  assert.equal(completed.origin_turn_id, "late-completion"); passed.push("late-terminal-origin");
  assert.ok(completed.content_ref); passed.push("owned-command-output");
  const second = await spawn("native-cancellation"); assert.equal(second.supports_cancel, true);
  const request = {session_id: "commands", operation: {kind: "work", action: "cancel", work_id: second.work_id, expected_revision: second.revision}};
  const result = await manager.conversationOperation("cancel-owned-command", request);
  assert.equal(result.work.accepted, true);
  assert.deepEqual(await manager.conversationOperation("cancel-owned-command", request), result); passed.push("native-cancellation-once");
  await wait(async () => (await inventory()).items.find(item => item.work.work_id === second.work_id && item.work.status === "cancelled")); passed.push("confirmed-command-termination");
  await manager.stopSession("commands", "acceptance-complete");
  assert.equal((await inventory()).closure_unconfirmed, undefined); passed.push("safe-unload");
  console.log(JSON.stringify({driver: "codex", cwd, passed}));
} catch (error) {console.log(JSON.stringify({driver: "codex", cwd, passed, failed: true, code: error?.code ?? "acceptance_failure"})); process.exitCode = 1;}
finally {unsubscribe(); try {await manager.stopSession("commands", "acceptance-cleanup");} catch {process.exitCode = 1;}}
