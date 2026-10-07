import assert from "node:assert/strict";
import {mkdtemp, realpath, writeFile} from "node:fs/promises";
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
let steering;
let deadline;
try {
  await manager.startSession(start);
  deadline = setTimeout(() => {void manager.cancelTurn("goal", "original").catch(() => {});}, 60_000);
  const result = await manager.sendTurn({session_id: "goal", turn_id: "original",
    input: "For this first turn, reply GOAL_FIRST only. Leave the native goal active so it can continue on an autonomous turn. Do not use tools in this first turn.",
    goal: {action: "start", objective: "On a subsequent autonomous turn, reply GOAL_SECOND and mark the native goal complete. Use no files, shell commands, agents or external tools.", token_budget: process.env.HCP_NATIVE_GOAL_TOKEN_BUDGET === undefined ? (process.env.HCP_NATIVE_GOAL_RESUME === "1" ? 20000 : 4000) : Number(process.env.HCP_NATIVE_GOAL_TOKEN_BUDGET)}},
    event => {
      observed.push(event);
      if (process.env.HCP_NATIVE_GOAL_STEER === "1" && event.event_type === "native.execution.completed" && !steering) {
        steering = manager.conversationOperation("steer-next-goal-phase", {session_id: "goal", operation: {kind: "steer", turn_id: "original",
          input: "On this next phase, reply GOAL_STEERED and mark the native goal complete. Use no files, shell, agents or external tools."}});
        void steering.catch(() => {});
      }
    });
  clearTimeout(deadline);
  if (process.env.HCP_NATIVE_GOAL_STEER === "1") {assert.ok(steering); await steering;}
  const terminal = [...observed, ...result].findLast(event => ["turn.completed", "turn.failed", "turn.cancelled"].includes(event.event_type));
  assert.equal(terminal?.event_type, "turn.completed", JSON.stringify(terminal?.data));
  if (process.env.HCP_NATIVE_PUBLIC_EVENTS_PATH)
    await writeFile(process.env.HCP_NATIVE_PUBLIC_EVENTS_PATH, JSON.stringify(observed, null, 2));
  const retained = state.nativeWorkState("goal");
  const job = retained.goals.at(-1);
  assert.equal(job.phase, "confirmed"); assert.equal(job.snapshot.status, "complete");
  assert.ok(retained.root_executions.length >= 2, "The native runtime must actually admit an autonomous phase.");
  assert.ok(retained.root_executions.every(phase => phase.phase_status === "completed"));
  assert.equal(observed.filter(event => event.event_type === "native.execution.completed").length, retained.root_executions.length);
  assert.ok(retained.root_executions.every(phase => phase.origin_turn_id === "original" && phase.goal_admission_id === job.admission_id && phase.native_execution_reference));
  assert.equal(new Set(retained.root_executions.map(phase => phase.native_execution_reference)).size, retained.root_executions.length);
  assert.ok(observed.some(event => event.event_type === "native.goal.updated" && event.data.status === "complete"));
  const generation = job.snapshot.native_created_at;
  const control = (id, operation, owner = manager) => owner.conversationOperation(id, {session_id: "goal", operation: {kind: "goal", ...operation}});
  const inspected = await control("inspect-goal", {action: "read"});
  assert.equal(inspected.goal.goal.native_created_at, generation); assert.equal(inspected.goal.goal.status, "complete");
  const paused = await control("pause-goal", {action: "pause", expected_native_created_at: generation});
  assert.equal(paused.goal.goal.status, "paused"); assert.equal(paused.goal.goal.tokens_used, inspected.goal.goal.tokens_used);
  if (process.env.HCP_NATIVE_GOAL_RESUME === "1") {
    const resumedEvents = [];
    const resumeDeadline = setTimeout(() => {void manager.cancelTurn("goal", "resumed-origin").catch(() => {});}, 60_000);
    try {
      const resumed = await manager.sendTurn({session_id: "goal", turn_id: "resumed-origin", input: "",
        goal: {action: "resume", expected_native_created_at: generation}}, event => resumedEvents.push(event));
      const terminal = [...resumedEvents, ...resumed].findLast(event => ["turn.completed", "turn.failed", "turn.cancelled"].includes(event.event_type));
      assert.equal(terminal?.event_type, "turn.completed", JSON.stringify(terminal?.data));
      const stateAfterResume = state.nativeWorkState("goal"), newJob = stateAfterResume.goals.at(-1);
      assert.notEqual(newJob.admission_id, job.admission_id); assert.equal(newJob.origin_turn_id, "resumed-origin");
      assert.equal(newJob.snapshot.native_created_at, generation); assert.equal(newJob.snapshot.objective, job.objective);
      assert.equal(newJob.snapshot.token_budget, job.token_budget); assert.ok(newJob.snapshot.tokens_used >= job.snapshot.tokens_used);
      assert.equal(newJob.snapshot.status, "complete");
      assert.ok(stateAfterResume.root_executions.some(phase => phase.origin_turn_id === "resumed-origin" && phase.goal_admission_id === newJob.admission_id && phase.native_execution_reference));
      console.log(JSON.stringify({driver: "codex", scenario: "native-goal-explicit-resume", cwd,
        passed: ["requested-generation", "new-app-origin", "new-admission", "preserved-objective-budget-usage", "native-first-phase", "native-completion"]}));
    } finally {clearTimeout(resumeDeadline);}
  }
  const cleared = await control("clear-goal", {action: "clear", expected_native_created_at: generation});
  assert.equal(cleared.goal.goal, null);
  const noGoal = await control("inspect-clear", {action: "read"}); assert.equal(noGoal.goal.goal, null);
  const replayOwner = new HarnessSessionManager(RunnerConfigSchema.parse({runner_id: "native-goal-replay", control_plane_url: "ws://localhost:1",
    workspaces: [{id: "workspace", path: cwd}], provider_instances: [{id: "codex", driver_kind: "codex"}]}),
    {stateStore: new JsonRunnerStateStore(join(cwd, "state.json")), adapterRegistry: createDefaultHarnessAdapterRegistry()});
  assert.deepEqual(await control("clear-goal", {action: "clear", expected_native_created_at: generation}, replayOwner), cleared);
  await replayOwner.close();
  await manager.stopSession("goal", "confirmed-goal-unload");
  assert.equal(manager.activeSessionCount(), 0);
  console.log(JSON.stringify({driver: "codex", scenario: "native-goal-execution", cwd,
    phase_count: retained.root_executions.length, passed: ["pending-goal-admission", "native-generation-readback",
      "actual-autonomous-phase", "original-app-origin", "native-phase-identities", "native-phase-completions", ...(steering ? ["between-phase-steering"] : []), "native-goal-completion", "native-goal-read", "explicit-pause", "explicit-clear", "retained-clear-replay", "confirmed-unload"]}));
} finally {
  if (deadline) clearTimeout(deadline);
  try {await manager.stopSession("goal", "acceptance-cleanup");} catch (error) {
    if (error?.code !== "session_not_found") console.error(JSON.stringify({cleanup: "ownership-unconfirmed", code: error?.code}));
  }
  await manager.close().catch(error => console.error(JSON.stringify({close: "ownership-unconfirmed", code: error?.code})));
}
