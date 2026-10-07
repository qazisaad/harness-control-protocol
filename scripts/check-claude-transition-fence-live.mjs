// Controlled no-model Claude acceptance. This verifies refusal/cleanup, not successful policy replacement or authenticated model behavior.
import assert from "node:assert/strict";
import {mkdtemp, realpath} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {HarnessSessionManager} from "@harness-control/runner/harnesses";
import {RunnerConfigSchema} from "@harness-control/runner/config";
import {JsonRunnerStateStore} from "@harness-control/runner/state";
if (process.env.HCP_NATIVE_LIVE !== "1") throw new Error("Set HCP_NATIVE_LIVE=1 for controlled Claude transition-fence acceptance.");
const cwd = await realpath(await mkdtemp(join(tmpdir(), "hcp-native-claude-transition-fence-")));
const config = RunnerConfigSchema.parse({runner_id: "claude-transition-fence", control_plane_url: "ws://localhost:1",
  workspaces: [{id: "workspace", path: cwd}], provider_instances: [{id: "claude", driver_kind: "claude",
    ...(process.env.HCP_LIVE_CLAUDE_EXECUTABLE ? {executable_path: process.env.HCP_LIVE_CLAUDE_EXECUTABLE} : {})}]});
const state = new JsonRunnerStateStore(join(cwd, "state.json")), manager = new HarnessSessionManager(config, {stateStore: state});
const events = [];manager.subscribeEvents(event => events.push(event));const passed = [];
try {
  const status = (await manager.providerDriverStatuses()).find(provider => provider.driver_kind === "claude");
  assert.match(status.version, /2\.1\.289/);const model = status.models.find(model => model.is_default)?.id ?? status.models[0]?.id;assert.ok(model);
  const start = {session_id: "source", workspace_id: "workspace", cwd, provider_instance_id: "claude", driver_kind: "claude", execution_profile: "interactive",
    model_selection: {model}, sandbox_mode: "danger_full_access", approval_policy: "ask", continue_session: false, continuation_group_key: "fixture", mcp_servers: [],
    configuration_inheritance: {user_settings: false, project_settings: false, hooks: false, mcp_servers: false, plugins: false}};
  await manager.startSession(start);await manager.sendTurn({session_id: "source", turn_id: "goal-read", input: "/goal"});
  assert.ok(events.some(event => event.turn_id === "goal-read" && event.event_type === "turn.completed"));
  await manager.stopSession("source", "fixture transition");
  assert.ok(events.some(event => event.session_id === "source" && event.event_type === "session.exited" && event.data.native_owner_closed === true));
  passed.push("local-command-and-source-owner-closure");
  const source = await manager.conversationOperation("source-read", {session_id: "source", operation: {kind: "read"}});assert.ok(source.history);
  const target = {...start, session_id: "target", continue_session: true, approval_policy: "auto_edits",
    conversation_transition: {transition_id: "fixture-policy-proof", change: "policy", expected_history_hash: source.history.history_hash}};
  await assert.rejects(manager.startSession(target), error => error?.code === "native_configuration_history_unknown");
  passed.push("original-native-history-refusal-preserved");
  assert.equal(manager.activeSessionCount(), 0);
  const receipt = state.getNativeConversation("fixture").configuration_transitions.at(-1);
  assert.equal(receipt.phase, "pending");assert.equal(receipt.target_session_id, "target");passed.push("pending-transition-fence-retained");
  await assert.rejects(manager.startSession({...target, session_id: "another-target"}), error => error?.code === "native_configuration_unknown");
  passed.push("unknown-transition-not-replayed");
  console.log(JSON.stringify({driver: "claude", version: status.version, passed}));
} finally {await manager.close();}
