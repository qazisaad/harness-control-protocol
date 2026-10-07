import assert from "node:assert/strict";
import {mkdtemp, realpath} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {HarnessSessionManager} from "@harness-control/runner/harnesses";
import {RunnerConfigSchema} from "@harness-control/runner/config";
import {JsonRunnerStateStore} from "@harness-control/runner/state";

if (process.env.HCP_NATIVE_LIVE !== "1") throw new Error("Set HCP_NATIVE_LIVE=1 for native acceptance.");
const cwd = await realpath(await mkdtemp(join(tmpdir(), "hcp-native-review-")));
const state = new JsonRunnerStateStore(join(cwd, "state.json"));
const manager = new HarnessSessionManager(RunnerConfigSchema.parse({runner_id: "native-review-acceptance", control_plane_url: "ws://localhost:1",
  workspaces: [{id: "workspace", path: cwd}], provider_instances: [{id: "codex", driver_kind: "codex"}]}), {stateStore: state});
const model = process.env.HCP_LIVE_CODEX_MODEL ?? (await manager.providerDriverStatuses()).find(provider => provider.driver_kind === "codex")?.models.find(model => model.is_default)?.id;
assert.ok(model);
const start = {session_id: "review", continuation_group_key: "review-conversation", workspace_id: "workspace", cwd,
  provider_instance_id: "codex", driver_kind: "codex", model_selection: {model, options: [{id: "serviceTier", value: "default"}]}, execution_profile: "interactive",
  sandbox_mode: "workspace_write", approval_policy: "auto_edits", approval_reviewer: "native_auto", continue_session: false, mcp_servers: []};
const passed = [];
try {
  const events = await manager.startSession(start);
  assert.equal(events.find(event => event.event_type === "session.configured").data.native_policy_readback.approval_reviewer, "native_auto");
  assert.equal(events.some(event => event.turn_id), false);
  passed.push("native-reviewer-start-readback", "no-model-startup");
  const result = await manager.sendTurn({session_id: "review", turn_id: "first", input: "Reply REVIEWER_READY. Do not use tools."});
  assert.equal(result.at(-1)?.event_type, "turn.completed", JSON.stringify(result.at(-1)?.data));
  assert.equal(result.find(event => event.event_type === "settings.effective").data.approval_reviewer, "native_auto");
  assert.ok(result.some(event => event.event_type === "native.execution.admitted"));
  assert.equal(result.find(event => event.event_type === "settings.effective").data.model_selection.options.find(option => option.id === "serviceTier")?.value, "default");
  passed.push("native-reviewer-effective-settings", "native-root-admission");
  const reset = await manager.sendTurn({session_id: "review", turn_id: "reset", model_selection: {model}, input: "Reply TIER_RESET. Do not use tools."});
  assert.equal(reset.at(-1)?.event_type, "turn.completed", JSON.stringify(reset.at(-1)?.data));
  assert.equal(reset.find(event => event.event_type === "settings.effective").data.model_selection.options.find(option => option.id === "serviceTier")?.value, "default");
  passed.push("native-service-tier-readback", "native-service-tier-reset");
  await manager.stopSession("review", "verify-unload");
  const history = await manager.conversationOperation("read", {session_id: "review", operation: {kind: "read"}});
  await assert.rejects(manager.startSession({...start, session_id: "invalid", continue_session: true, approval_reviewer: "user"}), /policy changed/);
  await manager.startSession({...start, session_id: "transition", continue_session: true, approval_reviewer: "user",
    conversation_transition: {transition_id: "user-reviewer-transition", expected_history_hash: history.history.history_hash}});
  assert.equal(state.getNativeConversation("review-conversation").approval_reviewer, "user");
  assert.equal(state.getNativeConversation("review-conversation").configuration_transitions.at(-1).phase, "completed");
  passed.push("reviewer-change-requires-control", "native-reviewer-idle-transition");
  console.log(JSON.stringify({driver: "codex", cwd, passed}));
} finally {
  for (const id of ["review", "invalid", "transition"]) try {await manager.stopSession(id, "acceptance-cleanup");}
    catch (error) {if (error?.code !== "session_not_found") throw error;}
}
