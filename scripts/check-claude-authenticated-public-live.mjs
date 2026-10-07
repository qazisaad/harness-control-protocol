// Opt-in authenticated public SDK acceptance in a controlled temporary workspace.
import assert from "node:assert/strict";
import {mkdtemp, realpath, writeFile, readFile} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {setTimeout as delay} from "node:timers/promises";
import {WebSocketServer} from "ws";
import {harnessRateLimitObservationSchema} from "@harness-control/protocol";
import {HcpHostConnection, HcpNativeSessions} from "@harness-control/sdk";
import {HarnessSessionManager} from "@harness-control/runner/harnesses";
import {RunnerConnection} from "@harness-control/runner/connection";
import {RunnerConfigSchema} from "@harness-control/runner/config";
import {JsonRunnerStateStore} from "@harness-control/runner/state";
if (process.env.HCP_NATIVE_LIVE !== "1") throw new Error("Set HCP_NATIVE_LIVE=1 for authenticated public Claude checklist/options acceptance.");
const cwd = await realpath(await mkdtemp(join(tmpdir(), "hcp-native-claude-policy-control-"))), passed = [], events = [];
const server = new WebSocketServer({host: "127.0.0.1", port: 0}); await new Promise(resolve => server.once("listening", resolve));
let peer, owners, runner, failure, ready = false;
server.on("connection", socket => {
  peer = new HcpHostConnection({send(message) {socket.send(JSON.stringify(message));}}); owners = new HcpNativeSessions(peer);
  socket.on("message", raw => {try {
    const observation = peer.receive(raw.toString());
    if (observation.message.type === "host.hello") peer.accept({protocol_version: "hcp.v0", heartbeat_interval_seconds: 30});
    if (observation.message.type === "host.capabilities.updated") ready = true;
    if (observation.message.type === "harness.event") {
      if (!["applied", "duplicate"].includes(observation.reduction.outcome)) throw new Error("Native policy observation continuity changed.");
      events.push(observation.message.payload);
    }
  } catch (error) {failure = error; socket.close();}}); socket.on("close", () => peer.disconnect());
});
const until = async predicate => {const deadline = Date.now() + 90000; while (!predicate()) {
  if (failure) throw failure; if (Date.now() > deadline) throw new Error("Authenticated native acceptance timed out."); await delay(20);
}};
const config = RunnerConfigSchema.parse({runner_id: "native-claude-policy", control_plane_url: `ws://127.0.0.1:${server.address().port}`,
  workspaces: [{id: "workspace", path: cwd}], provider_instances: [{id: "claude", driver_kind: "claude", env: {CLAUDE_CODE_ENABLE_TASKS: "false"},
    ...(process.env.HCP_LIVE_CLAUDE_EXECUTABLE ? {executable_path: process.env.HCP_LIVE_CLAUDE_EXECUTABLE} : {})}]});
const state = new JsonRunnerStateStore(join(cwd, "state.json")), manager = new HarnessSessionManager(config, {stateStore: state});
try {
  const status = (await manager.providerDriverStatuses()).find(provider => provider.driver_kind === "claude"); assert.match(status.version, /2\.1\.289/);
  runner = new RunnerConnection({config, runnerVersion: "authenticated-acceptance", harnessSessions: manager, stateStore: state}); await runner.connect(); await until(() => ready);
  const selections = [{approval_policy: "ask", approval_reviewer: "user"}, {approval_policy: "auto_edits", approval_reviewer: "native_auto"}];
  await owners.open({session_id: "policy", workspace_id: "workspace", cwd, provider_instance_id: "claude", driver_kind: "claude", execution_profile: "interactive",
    model_selection: {model: process.env.HCP_LIVE_CLAUDE_MODEL ?? "sonnet"}, sandbox_mode: "danger_full_access", approval_policy: "ask", continue_session: false, continuation_group_key: "fixture", mcp_servers: [], tool_selection: {native_builtin_tools: ["TodoWrite"]},
    policy_control_authority: {allowed_selections: selections},
    configuration_inheritance: {user_settings: false, project_settings: false, hooks: false, mcp_servers: false, plugins: false}}, {readiness: "configured"});
  const run = async (turn_id, input, extra = {}) => {
    await peer.sendTurn({session_id: "policy", turn_id, input, ...extra});
    await until(() => events.some(event => event.turn_id === turn_id && ["turn.completed", "turn.failed", "turn.cancelled"].includes(event.event_type)));
    const terminal = events.findLast(event => event.turn_id === turn_id && ["turn.completed", "turn.failed", "turn.cancelled"].includes(event.event_type));
    assert.equal(terminal.event_type, "turn.completed"); return terminal;
  };
  const first = await run("todo", 'Use TodoWrite exactly once to set exactly two toy todos: content "First toy step", activeForm "Checking the first toy step", status "completed"; and content "Second toy step", activeForm "Checking the second toy step", status "pending". Use no other tools. Reply CHECKED only.');
  const plans = await peer.readNativePlanObservationsComplete("policy", events, "todo"); assert.ok(plans.some(plan => plan.steps.length === 2 && plan.steps[0].status === "completed" && plan.steps[1].status === "pending"));
  passed.push("actual-todowrite-and-complete-public-checklist");
  const tools = events.find(event => event.turn_id === "todo" && event.event_type === "settings.tools.effective");assert.deepEqual(tools.data.tool_selection.native_builtin_tools, ["TodoWrite"]);passed.push("exact-native-checklist-only-tool-availability");
  const quota = events.find(event => event.session_id === "policy" && event.event_type === "account.rate_limits.updated");assert.ok(quota);const observation = harnessRateLimitObservationSchema.parse(quota.data.observation);assert.equal(observation.native_source, "claude.sdk.rate_limit_event");assert.equal(observation.scope, "native_session");assert.ok(observation.windows.length);passed.push("typed-native-quota-observation-without-account-inference");
  const usage = events.findLast(event => event.turn_id === "todo" && event.event_type === "usage.updated").data;
  assert.equal(usage.source, "claude.sdk.result.usage"); assert.equal(usage.actor, "root"); assert.equal(usage.scope, "turn"); assert.equal(usage.status, "complete"); assert.ok(usage.output_tokens > 0); assert.equal(usage.total_tokens, usage.input_tokens + usage.output_tokens);
  passed.push("native-root-billing-separate-from-conversation-aggregate");
  const context = events.findLast(event => event.turn_id === "todo" && event.event_type === "context.updated").data; assert.equal(context.status, "measured");
  passed.push("actual-model-context-measurement");
  const text = await peer.readFinalTextComplete("policy", first.data.final_output); assert.equal(text.availability, "complete"); assert.match(text.final_text, /^CHECKED[.!]?$/i);
  assert.ok(events.some(event => event.turn_id === "todo" && event.event_type === "item.completed" && event.data.item_type === "text"));
  passed.push("physical-native-text-and-complete-root-result");
  const nativeId = owners.state("policy").configured.data.native_reference;
  const changed = await peer.updateNativePolicy("policy", {expected_revision: 0, selection: selections[1]}); assert.equal(changed.payload.policy.native_reference, nativeId); assert.equal(changed.payload.policy.native_permission_mode, "auto");
  await run("automatic", "Reply AUTOMATIC only. Use no tools."); assert.equal(events.some(event => event.turn_id === "automatic" && event.event_type === "approval.requested"), false);
  passed.push("native-auto-review-mode-and-actual-model-turn");
  await peer.updateNativePolicy("policy", {expected_revision: 1, selection: selections[0]});
  for (const effort of ["low", "high", undefined]) {
    const model_selection = {model: process.env.HCP_LIVE_CLAUDE_MODEL ?? "sonnet", ...(effort ? {options: [{id: "effort", value: effort}]} : {})};
    const turn = `effort-${effort ?? "default"}`; await run(turn, "Reply OPTIONS only. Use no tools.", {model_selection});
    const effective = events.findLast(event => event.turn_id === turn && event.event_type === "settings.options.effective"); assert.ok(effective); assert.equal(effective.data.source, "native");
    const selected = effective.data.model_selection.options?.find(option => option.id === "effort")?.value; if (effort) assert.equal(selected, effort);
    passed.push(`native-${turn}-effective-options-and-model-turn`);
  }
  for (const thinking of [true, false, undefined]) {
    const model_selection = {model: process.env.HCP_LIVE_CLAUDE_MODEL ?? "sonnet", ...(thinking === undefined ? {} : {options: [{id: "thinking", value: thinking}]})};
    const turn = `thinking-${thinking ?? "default"}`;await run(turn, "Reply THINKING_OPTIONS only. Use no tools.", {model_selection});
    const effective = events.findLast(event => event.turn_id === turn && event.event_type === "settings.options.effective");assert.ok(effective);assert.equal(effective.data.source, "native");
    const selected = effective.data.model_selection.options?.find(option => option.id === "thinking")?.value;if (thinking !== undefined) assert.equal(selected, thinking);
    passed.push(`native-${turn}-effective-option-and-model-turn`);
  }
  const history = await peer.readConversationPageComplete("policy", {limit: 100}); assert.ok(history.turns.length >= 5);
  passed.push("populated-portable-history");
  await owners.open({session_id: "auto-tool", workspace_id: "workspace", cwd, provider_instance_id: "claude", driver_kind: "claude", execution_profile: "interactive",
    model_selection: {model: process.env.HCP_LIVE_CLAUDE_MODEL ?? "sonnet"}, sandbox_mode: "danger_full_access", approval_policy: "auto_edits", approval_reviewer: "native_auto", continue_session: false, continuation_group_key: "automatic-fixture", mcp_servers: [],
    configuration_inheritance: {user_settings: false, project_settings: false, hooks: false, mcp_servers: false, plugins: false}}, {readiness: "configured"});
  await run("automatic-tool", "Use exactly one Bash tool call with the exact command printf AUTOMATIC_TOOL. Use no other tools. Reply AUTOMATIC_TOOL only after it succeeds.", {session_id: "auto-tool"});
  const calls = events.filter(event => event.session_id === "auto-tool" && event.turn_id === "automatic-tool" && event.event_type === "item.started" && event.data.item_type === "tool_call");
  assert.equal(calls.length, 1); assert.equal(calls[0].data.summary, "Bash");
  assert.ok(events.some(event => event.session_id === "auto-tool" && event.event_type === "item.completed" && event.data.item_id === calls[0].data.item_id && event.data.status === "completed"));
  assert.equal(events.some(event => event.session_id === "auto-tool" && event.event_type === "approval.requested"), false);
  passed.push("native-auto-policy-actual-bash-completion-without-app-approval");
  await owners.close("auto-tool"); assert.equal(owners.state("auto-tool").phase, "closed"); passed.push("automatic-owner-closure");
  const readFixture = join(cwd, "read-only.txt");await writeFile(readFixture, "READONLY_MARKER");
  await owners.open({session_id: "read-only", workspace_id: "workspace", cwd, provider_instance_id: "claude", driver_kind: "claude", execution_profile: "interactive",
    model_selection: {model: process.env.HCP_LIVE_CLAUDE_MODEL ?? "sonnet"}, sandbox_mode: "danger_full_access", approval_policy: "ask", tool_selection: {native_builtin_tools: ["Read", "Glob", "Grep"]}, continue_session: false, continuation_group_key: "read-only-fixture", mcp_servers: [],
    configuration_inheritance: {user_settings: false, project_settings: false, hooks: false, mcp_servers: false, plugins: false}}, {readiness: "configured"});
  await run("read-only-plan", `Use Read exactly once to read ${readFixture}, then reply READONLY_MARKER only. Do not write a plan file or use any other tools.`, {session_id: "read-only", mode: "plan"});
  const readTools = events.find(event => event.session_id === "read-only" && event.event_type === "settings.tools.effective");assert.deepEqual([...readTools.data.tool_selection.native_builtin_tools].sort(), ["Read", "Glob", "Grep"].sort());
  assert.ok(events.some(event => event.session_id === "read-only" && event.event_type === "session.configured" && event.data.mode === "plan"));
  assert.ok(events.some(event => event.session_id === "read-only" && event.event_type === "item.started" && event.data.item_type === "tool_call" && event.data.summary === "Read"));
  assert.equal(events.some(event => event.session_id === "read-only" && event.event_type === "approval.requested"), false);assert.equal(await readFile(readFixture, "utf8"), "READONLY_MARKER");
  passed.push("native-read-only-builtins-and-plan-mode-model-read");
  await run("read-only-execute", "Reply READONLY_EXECUTE only. Use no tools.", {session_id: "read-only", mode: "execute"});
  assert.ok(events.some(event => event.session_id === "read-only" && event.event_type === "session.configured" && event.data.mode === "execute"));passed.push("same-read-only-owner-plan-to-execute");
  await owners.close("read-only");assert.equal(owners.state("read-only").phase, "closed");passed.push("read-only-owner-closure");
  await owners.close("policy"); assert.equal(owners.state("policy").phase, "closed"); passed.push("confirmed-native-owner-closure");
  console.log(JSON.stringify({driver: "claude", version: status.version, scope: "authenticated-public-sdk-checklist-billing-options-auto", passed}));
} catch (error) { process.exitCode = 1; console.log(JSON.stringify({driver: "claude", passed, failed: true, code: typeof error?.code === "string" && /^[a-zA-Z0-9_]{1,128}$/.test(error.code) ? error.code : "acceptance_failed", tool_names: events.filter(e=>e.event_type==="item.started" && e.data.item_type==="tool_call").map(e=>e.data.summary).filter(n=>["TodoWrite","TaskCreate","TaskUpdate"].includes(n)), plan_count: events.filter(e=>e.event_type==="turn.plan.updated").length, native_control_operation: ["open", "close"].includes(error?.operation) ? error.operation : undefined, native_control_outcome: ["not_sent", "unknown", "rejected", "unconfirmed"].includes(error?.outcome) ? error.outcome : undefined, cause_code: typeof error?.cause?.code === "string" && /^[a-zA-Z0-9_]{1,128}$/.test(error.cause.code) ? error.cause.code : undefined, assertion: typeof error?.actual === "string" && /^[a-zA-Z0-9_]{1,128}$/.test(error.actual) ? error.actual : undefined})); }
finally {owners?.dispose(); await runner?.close(); await manager.close(); for (const socket of server.clients) socket.terminate(); await new Promise(resolve => server.close(resolve));}
