import assert from "node:assert/strict";
import {mkdtemp, realpath} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {HarnessSessionManager, createDefaultHarnessAdapterRegistry} from "@harness-control/runner/harnesses";
import {RunnerConfigSchema} from "@harness-control/runner/config";
import {JsonRunnerStateStore} from "@harness-control/runner/state";

if (process.env.HCP_NATIVE_CLAUDE_GOAL_OBSERVATIONS !== "1") throw new Error("Set HCP_NATIVE_CLAUDE_GOAL_OBSERVATIONS=1 for installed transcript acceptance.");
const cwd = await realpath(await mkdtemp(join(tmpdir(), "hcp-native-claude-goal-observations-")));
const registry = createDefaultHarnessAdapterRegistry();
const profile = registry.require("claude").executionProfiles.find(profile => profile.id === "interactive");
assert.equal(profile.native_goal_observations, "native_transcript");
assert.notEqual(profile.native_goals, true);
const manager = new HarnessSessionManager(RunnerConfigSchema.parse({runner_id: "goal-observations", control_plane_url: "ws://localhost:1",
  workspaces: [{id: "workspace", path: cwd}], provider_instances: [{id: "claude", driver_kind: "claude",
    executable_path: process.env.HCP_LIVE_CLAUDE_EXECUTABLE ?? "/tmp/hcp-native-acceptance-tools/node_modules/.bin/claude"}]}),
  {stateStore: new JsonRunnerStateStore(join(cwd, "state.json")), adapterRegistry: registry});
const observed = [];
manager.subscribeEvents(event => observed.push(event));
let deadline;
try {
  await manager.startSession({session_id: "observation", continuation_group_key: "observation", workspace_id: "workspace", cwd,
    provider_instance_id: "claude", driver_kind: "claude", execution_profile: "interactive", model_selection: {model: "claude-haiku-4-5"},
    approval_policy: "ask", sandbox_mode: "danger_full_access", continue_session: false, mcp_servers: []});
  deadline = setTimeout(() => {void manager.cancelTurn("observation", "read").catch(() => {});}, 20_000);
  const result = await manager.sendTurn({session_id: "observation", turn_id: "read", input: "/goal"});
  clearTimeout(deadline);
  assert.equal(result.at(-1)?.event_type, "turn.completed", JSON.stringify(result.at(-1)));
  const goals = observed.filter(event => event.event_type === "native.goal.observed");
  assert.equal(goals.length, 1); assert.equal(goals[0].turn_id, undefined);
  assert.equal(goals[0].data.source, "native_transcript"); assert.equal(goals[0].data.scope, "session");
  assert.equal(goals[0].data.goal, null); assert.ok(goals[0].data.native_message_reference);
  assert.equal(observed.some(event => event.event_type === "native.goal.updated"), false);
  const admitted = observed.filter(event => event.event_type === "native.execution.admitted");
  const completed = observed.filter(event => event.event_type === "native.execution.completed");
  assert.equal(admitted.length, 1); assert.equal(completed.length, 1);
  assert.equal(completed[0].data.admission_id, admitted[0].data.admission_id);
  assert.equal(completed[0].data.native_execution_reference, admitted[0].data.native_execution_reference);
  assert.equal(completed[0].data.status, "completed");
  assert.ok(observed.filter(event => event.event_type === "context.updated").every(event => event.data.status === "unavailable"));
  await manager.stopSession("observation", "confirmed-command-unload");
  console.log(JSON.stringify({driver: "claude", scenario: "public-native-goal-read-observation", cwd,
    passed: ["installed-read-command", "native-session-identity", "native-message-identity", "session-only-observation",
      "no-goal-readback", "uuid-bound-phase-terminal", "no-job-completion-claim", "no-synthetic-model-measurement", "confirmed-unload"]}));
} finally {
  if (deadline) clearTimeout(deadline);
  await manager.close();
}
