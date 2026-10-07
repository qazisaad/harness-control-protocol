import assert from "node:assert/strict";
import {mkdtemp, realpath} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {HarnessSessionManager, createDefaultHarnessAdapterRegistry} from "@harness-control/runner/harnesses";
import {RunnerConfigSchema} from "@harness-control/runner/config";
import {JsonRunnerStateStore} from "@harness-control/runner/state";

if (process.env.HCP_NATIVE_GOAL_LIVE !== "1") throw new Error("Set HCP_NATIVE_GOAL_LIVE=1 for native goal execution acceptance.");
const cwd = await realpath(await mkdtemp(join(tmpdir(), "hcp-native-goal-execution-")));
const state = new JsonRunnerStateStore(join(cwd, "state.json"));
const registry = createDefaultHarnessAdapterRegistry();
assert.equal(registry.require("codex").executionProfiles.find(profile => profile.id === "interactive").native_goals, true);
const manager = new HarnessSessionManager(RunnerConfigSchema.parse({runner_id: "native-goal-acceptance", control_plane_url: "ws://localhost:1",
  workspaces: [{id: "workspace", path: cwd}], provider_instances: [{id: "codex", driver_kind: "codex"}]}),
{stateStore: state, adapterRegistry: registry});
const model = process.env.HCP_LIVE_CODEX_MODEL ?? (await manager.providerDriverStatuses()).find(provider => provider.driver_kind === "codex")?.models.find(model => model.is_default)?.id;
assert.ok(model);
const start = {session_id: "goal", continuation_group_key: "goal-conversation", workspace_id: "workspace", cwd,
  provider_instance_id: "codex", driver_kind: "codex", model_selection: {model}, execution_profile: "interactive",
  sandbox_mode: "workspace_write", approval_policy: "auto_edits", continue_session: false, mcp_servers: []};

const observed = [];
let cancellation, deadline;
try {
  await manager.startSession(start);
  const observe = event => {
    observed.push(event);
    if (event.turn_id === "cancel-origin" && event.event_type === "content.delta" && !cancellation) {
      cancellation = manager.cancelTurn("goal", "cancel-origin"); void cancellation.catch(() => {});
    }
  };
  deadline = setTimeout(() => {if (!cancellation) {cancellation = manager.cancelTurn("goal", "cancel-origin"); void cancellation.catch(() => {});}}, 45_000);
  const result = await manager.sendTurn({session_id: "goal", turn_id: "cancel-origin",
    input: "Write a numbered list from 1 to 500, one line per number, so the user can stop the response. Do not use tools, files or shell commands.",
    goal: {action: "start", objective: "Continue the numbered list on autonomous turns until the user explicitly stops. Use no tools, files or shell commands.", token_budget: 10000}}, observe);
  clearTimeout(deadline); assert.ok(cancellation); await cancellation;
  const terminal = [...observed, ...result].findLast(event => ["turn.completed", "turn.failed", "turn.cancelled"].includes(event.event_type));
  assert.equal(terminal?.event_type, "turn.cancelled", JSON.stringify(terminal?.data));
  const retained = state.nativeWorkState("goal"), job = retained.goals.at(-1);
  assert.equal(job.phase, "confirmed"); assert.equal(job.snapshot.status, "paused");
  assert.ok(retained.root_executions.every(phase => phase.phase_status === "interrupted" || phase.phase_status === "completed"));
  assert.ok(observed.some(event => event.event_type === "native.execution.completed"));
  assert.ok(retained.root_executions.every(phase => phase.origin_turn_id === "cancel-origin" && phase.goal_admission_id === job.admission_id && phase.native_execution_reference));
  const goalRead = await manager.conversationOperation("read-paused", {session_id: "goal", operation: {kind: "goal", action: "read"}});
  assert.equal(goalRead.goal.goal.status, "paused"); assert.equal(goalRead.goal.goal.native_created_at, job.snapshot.native_created_at);
  const clear = await manager.conversationOperation("clear-after-cancel", {session_id: "goal", operation: {kind: "goal", action: "clear",
    expected_native_created_at: job.snapshot.native_created_at}});
  assert.equal(clear.goal.goal, null);
  await manager.stopSession("goal", "cancelled-goal-unload"); assert.equal(manager.activeSessionCount(), 0);
  console.log(JSON.stringify({driver: "codex", scenario: "native-goal-cancellation", cwd,
    passed: ["actual-model-output", "root-cancellation", "native-goal-pause", "original-admission", "native-phase-terminal-proof", "read-paused-native-job", "explicit-clear-after-cancel", "confirmed-unload"]}));
} finally {
  if (deadline) clearTimeout(deadline);
  await manager.close().catch(error => console.error(JSON.stringify({close: "ownership-unconfirmed", code: error?.code})));
}
