import assert from "node:assert/strict";
import {mkdtemp, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {HarnessSessionManager} from "@harness-control/runner/harnesses";
import {RunnerConfigSchema} from "@harness-control/runner/config";
import {JsonRunnerStateStore} from "@harness-control/runner/state";
import {hcpHarnessEventPayloadSchema} from "@harness-control/protocol";

// Explicit opt-in: this check uses authenticated accounts and native model requests.
if (process.env.HCP_NATIVE_LIVE !== "1") throw new Error("Set HCP_NATIVE_LIVE=1 to run authenticated native acceptance.");
const providers = (process.env.HCP_LIVE_PROVIDERS ?? "codex,claude,opencode").split(",");
const models = {codex: process.env.HCP_LIVE_CODEX_MODEL, claude: process.env.HCP_LIVE_CLAUDE_MODEL ?? "sonnet",
  opencode: process.env.HCP_LIVE_OPENCODE_MODEL ?? "opencode-go/minimax-m2.7"};
const evidence = [];
for (const driver of providers) {
  assert.ok(Object.hasOwn(models, driver), `Unknown live provider ${driver}`);
  const cwd = await mkdtemp(join(tmpdir(), `hcp-live-${driver}-`));
  const config = RunnerConfigSchema.parse({runner_id: "live-acceptance", control_plane_url: "ws://localhost:8787",
    workspaces: [{id: "workspace", path: cwd}], provider_instances: [{id: driver, driver_kind: driver}]});
  const stateStore = new JsonRunnerStateStore(join(cwd, "runner-state.json"));
  let manager = new HarnessSessionManager(config, {stateStore});
  const status = (await manager.providerDriverStatuses()).find(status => status.driver_kind === driver);
  assert.ok(status?.available, `Provider ${driver} is unavailable`);
  if (driver === "claude") assert.ok(status.models.length, "Claude native model catalog is unavailable");
  console.log(JSON.stringify({driver, stage: "discovery", model_count: status.models.length}));
  if (!models[driver]) {
    models[driver] = status.models.find(model => model.is_default)?.id ?? status.models[0]?.id;
    assert.ok(models[driver], `Provider ${driver} has no discoverable model`);
  }
  const token = randomUUID();
  const events = [];
  const observe = event => {hcpHarnessEventPayloadSchema.parse(event); events.push(event);};
  const start = {session_id: `${driver}-first`, workspace_id: "workspace", provider_instance_id: driver,
    driver_kind: driver, cwd, sandbox_mode: "danger_full_access", approval_policy: "ask", continue_session: false,
    continuation_group_key: "live-conversation", model_selection: {model: models[driver]}, mcp_servers: [],
    ...(driver === "claude" ? {execution_profile: "interactive"} : {})};
  console.log(JSON.stringify({driver, stage: "start", cwd}));
  const passed = [];
  try {
    await manager.startSession(start);
    const run = async (session_id, turn_id, input, overrides = {}) => {
      const result = [];
      await manager.sendTurn({session_id, turn_id, input, ...overrides}, event => {observe(event); result.push(event);});
      const terminal = result.findLast(event => ["turn.completed", "turn.failed", "turn.interrupted"].includes(event.event_type));
      assert.equal(terminal?.event_type, "turn.completed", JSON.stringify(terminal?.data));
      if (overrides.action !== "compact") assert.ok(result.some(event => event.event_type === "content.delta"), "Native text was not streamed before completion");
      return result;
    };
    await run(start.session_id, "remember", `Remember this exact marker for this conversation: ${token}. Reply with the marker only. Do not use tools.`);
    const checkRecall = async (session_id, turn_id) => {
      const result = await run(session_id, turn_id, "What exact marker did I ask you to remember? Reply with the marker only. Do not use tools.");
      assert.ok(JSON.stringify(result.filter(event => event.event_type === "turn.completed")).includes(token), "Native conversation lost the marker");
    };
    await checkRecall(start.session_id, "followup");
    await manager.stopSession(start.session_id, "live-reopen");
    console.log(JSON.stringify({driver, stage: "resume"}));
    manager = new HarnessSessionManager(config, {stateStore: new JsonRunnerStateStore(join(cwd, "runner-state.json"))});
    const resumed = {...start, session_id: `${driver}-resumed`, continue_session: true};
    await manager.startSession(resumed);
    await checkRecall(resumed.session_id, "reopened");
    if (process.env.HCP_LIVE_CONTROLS === "1") {
      console.log(JSON.stringify({driver, stage: "compaction"}));
      await run(resumed.session_id, "compact", "", {action: "compact"});
      await checkRecall(resumed.session_id, "compacted-recall");
      passed.push("compact", "compacted-recall");
      if (driver === "claude") {
        const alternative = status.models.find(model => model.id === "haiku") ?? status.models.find(model => model.id !== models[driver]);
        assert.ok(alternative, "Claude has no alternate native model for the settings check");
        const changed = await run(resumed.session_id, "model-changed", "What exact marker did I ask you to remember? Reply with the marker only. Do not use tools.",
          {model_selection: {model: alternative.id}, mode: "plan"});
        assert.ok(JSON.stringify(changed.filter(event => event.event_type === "turn.completed")).includes(token), "Model transition lost the conversation");
        const configured = changed.findLast(event => event.event_type === "session.configured");
        assert.equal(configured?.data.model_selection?.model, alternative.id);
        assert.equal(configured?.data.mode, "plan");
        passed.push("model-transition", "plan-transition", "transition-recall");
        const effortModel = status.models.find(model => model.capabilities.option_descriptors.some(option => option.id === "effort" && option.values?.some(value => value.value === "low")));
        assert.ok(effortModel, "Claude has no native low-effort model for the settings check");
        const effortChanged = await run(resumed.session_id, "effort-changed", "What exact marker did I ask you to remember? Reply with the marker only. Do not use tools.",
          {model_selection: {model: effortModel.id, options: [{id: "effort", value: "low"}]}, mode: "execute"});
        assert.ok(JSON.stringify(effortChanged.filter(event => event.event_type === "turn.completed")).includes(token), "Effort transition lost the conversation");
        assert.deepEqual(effortChanged.findLast(event => event.event_type === "session.configured")?.data.model_selection,
          {model: effortModel.id, options: [{id: "effort", value: "low"}]});
        passed.push("effective-effort-transition", "effort-recall");
      }
    }
    await manager.stopSession(resumed.session_id, "live-history");
    console.log(JSON.stringify({driver, stage: "history"}));
    const history = await manager.conversationOperation("live-read", {session_id: resumed.session_id, operation: {kind: "read", limit: 100}});
    assert.ok(history.history?.turn_count >= 3, "History omitted retained native turns");
    passed.push("start", "followup", "stop", "restart-resume", "history");
    if (process.env.HCP_LIVE_EXTENDED === "1") {
      console.log(JSON.stringify({driver, stage: "fork"}));
      const forkRequest = {session_id: resumed.session_id, operation: {kind: "fork", target_session_id: `${driver}-fork`,
        continuation_group_key: "live-fork", expected_history_hash: history.history.history_hash}};
      const fork = await manager.conversationOperation("live-fork", forkRequest);
      assert.deepEqual(await manager.conversationOperation("live-fork", forkRequest), fork, "Duplicate fork changed its result");
      const forkStart = {...start, session_id: `${driver}-fork`, continuation_group_key: "live-fork", continue_session: true};
      await manager.startSession(forkStart);
      await checkRecall(forkStart.session_id, "fork-recall");
      await manager.stopSession(forkStart.session_id, "fork-complete");
      passed.push("fork", "duplicate-fork-receipt", "fork-recall");
      console.log(JSON.stringify({driver, stage: "rollback"}));
      const rollback = await manager.conversationOperation("live-rollback", {session_id: resumed.session_id,
        operation: {kind: "rollback", num_turns: 1, expected_history_hash: history.history.history_hash}});
      assert.equal(rollback.history.turn_count, history.history.turn_count - 1);
      assert.equal(rollback.filesystem_undo, false);
      await manager.startSession({...resumed, session_id: `${driver}-rolled-back`});
      await checkRecall(`${driver}-rolled-back`, "rollback-recall");
      await manager.stopSession(`${driver}-rolled-back`, "rollback-complete");
      passed.push("rollback", "rollback-recall");
    }
    evidence.push({driver, passed, cwd, event_count: events.length});
    console.log(JSON.stringify(evidence.at(-1)));
  } catch (error) {
    evidence.push({driver, passed, failed: error instanceof Error ? error.message : String(error),
      ...(error?.cause?.code ? {transport_code: error.cause.code} : {}), cwd});
    console.error(JSON.stringify(evidence.at(-1)));
    process.exitCode = 1;
  } finally {
    for (const session of [start.session_id, `${driver}-resumed`, `${driver}-fork`, `${driver}-rolled-back`]) {
      try {await manager.stopSession(session, "live-cleanup");} catch (error) {
        if (error?.code !== "session_not_found") {console.error(`Cleanup ${session}: ${error.message}`); process.exitCode = 1;}
      }
    }
    // Controlled test prompts only; never copy provider credential files into evidence.
    await writeFile(join(cwd, "events.json"), JSON.stringify(events, null, 2));
  }
}
console.log(JSON.stringify({evidence}));
