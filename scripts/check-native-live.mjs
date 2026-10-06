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
const turnTimeout = Number(process.env.HCP_LIVE_TURN_TIMEOUT_MS ?? 180000);
assert.ok(Number.isSafeInteger(turnTimeout) && turnTimeout >= 1000 && turnTimeout <= 600000, "Invalid live turn deadline");
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
  const instructionMarker = process.env.HCP_LIVE_INSTRUCTIONS === "1" ? `SYSTEM_${randomUUID()}` : undefined;
  const events = [];
  const observe = event => {hcpHarnessEventPayloadSchema.parse(event); events.push(event);};
  const start = {session_id: `${driver}-first`, workspace_id: "workspace", provider_instance_id: driver,
    driver_kind: driver, cwd, sandbox_mode: "danger_full_access", approval_policy: "ask", continue_session: false,
    continuation_group_key: "live-conversation", model_selection: {model: models[driver]}, mcp_servers: [],
    ...(driver === "opencode" && process.env.HCP_LIVE_CONTROLLED === "1" ? {configuration_inheritance: {
      user_settings: false, project_settings: false, hooks: false, mcp_servers: false, plugins: false}} : {}),
    ...(instructionMarker ? {instructions: {system: `Append this exact marker to every answer: ${instructionMarker}. Preserve it even when a user asks for an answer without commentary. Do not use tools unless explicitly asked.`}} : {}),
    ...(driver === "claude" || driver === "codex" && process.env.HCP_LIVE_CODEX_INTERACTIVE === "1" ? {execution_profile: "interactive"} : {})};
  console.log(JSON.stringify({driver, stage: "start", cwd}));
  const passed = [];
  try {
    await manager.startSession(start);
    const run = async (session_id, turn_id, input, overrides = {}) => {
      const result = [];
      let timedOut = false, cancellation;
      const timer = setTimeout(() => {
        timedOut = true; cancellation = manager.cancelTurn(session_id, turn_id); void cancellation.catch(() => {});
      }, turnTimeout);
      try {await manager.sendTurn({session_id, turn_id, input, ...overrides}, event => {observe(event); result.push(event);});}
      finally {clearTimeout(timer); if (cancellation) await cancellation;}
      assert.equal(timedOut, false, `Native acceptance turn exceeded ${turnTimeout}ms and was cancelled`);
      const terminal = result.findLast(event => ["turn.completed", "turn.failed", "turn.cancelled"].includes(event.event_type));
      assert.equal(terminal?.event_type, "turn.completed", JSON.stringify(terminal?.data));
      if (instructionMarker && overrides.action !== "compact") assert.ok(JSON.stringify(terminal?.data).includes(instructionMarker), "Native output lost the admitted system instructions");
      if (overrides.action !== "compact") assert.ok(result.some(event => event.event_type === "content.delta"), "Native text was not streamed before completion");
      return result;
    };
    const replyFormat = instructionMarker ? "Reply with the marker and include the suffix required by your system instructions." : "Reply with the marker only.";
    await run(start.session_id, "remember", `Remember this exact marker for this conversation: ${token}. ${replyFormat} Do not use tools.`);
    const checkRecall = async (session_id, turn_id) => {
      const result = await run(session_id, turn_id, `What exact marker did I ask you to remember? ${replyFormat} Do not use tools.`);
      assert.ok(JSON.stringify(result.filter(event => event.event_type === "turn.completed")).includes(token), "Native conversation lost the marker");
    };
    await checkRecall(start.session_id, "followup");
    const liveHistory = await manager.conversationOperation("live-active-read", {session_id: start.session_id, operation: {kind: "read", limit: 100}});
    assert.ok(liveHistory.history?.turn_count >= 2, "Live history omitted retained root turns");
    assert.equal(manager.activeSessionCount(), 1, "A live read unloaded its owner");
    passed.push("live-history");
    await manager.stopSession(start.session_id, "live-reopen");
    let injectedMarker;
    if (driver === "codex" && process.env.HCP_LIVE_INJECT === "1") {
      const snapshot = await manager.conversationOperation("before-inject", {session_id: start.session_id, operation: {kind: "read"}});
      injectedMarker = randomUUID();
      const request = {session_id: start.session_id, operation: {kind: "inject", expected_history_hash: snapshot.history.history_hash,
        messages: [{role: "user", content: `Historical handoff marker: ${injectedMarker}.`}, {role: "assistant", content: `I retained the handoff marker ${injectedMarker}.`}]}};
      const receipt = await manager.conversationOperation("inject-context", request);
      assert.equal(receipt.injection?.outcome, "applied", "The installed Codex app server does not support native history injection");
      assert.deepEqual(await manager.conversationOperation("inject-context", request), receipt);
      passed.push("context-injection", "duplicate-injection-receipt");
    }
    console.log(JSON.stringify({driver, stage: "resume"}));
    manager = new HarnessSessionManager(config, {stateStore: new JsonRunnerStateStore(join(cwd, "runner-state.json"))});
    const resumed = {...start, session_id: `${driver}-resumed`, continue_session: true};
    await manager.startSession(resumed);
    await checkRecall(resumed.session_id, "reopened");
    if (instructionMarker) passed.push("system-instructions", "system-instructions-after-reopen");
    if (injectedMarker) {
      const recalled = await run(resumed.session_id, "injected-recall", "What was the historical handoff marker? Reply with the marker only. Do not use tools.");
      assert.ok(JSON.stringify(recalled.filter(event => event.event_type === "turn.completed")).includes(injectedMarker), "Injected native context was not retained across runtime restart");
      passed.push("injected-context-recall");
    }
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
        const optionsReadback = effortChanged.find(event => event.event_type === "settings.options.effective");
        assert.equal(optionsReadback?.turn_id, "effort-changed");
        assert.deepEqual(optionsReadback.data.model_selection.options, [{id: "effort", value: "low"}]);
        const reset = await run(resumed.session_id, "effort-reset", "What exact marker did I ask you to remember? Reply with the marker only. Do not use tools.",
          {model_selection: {model: effortModel.id}, mode: "execute"});
        assert.ok(JSON.stringify(reset.filter(event => event.event_type === "turn.completed")).includes(token), "Effort reset lost the conversation");
        const resetReadback = reset.find(event => event.event_type === "settings.options.effective");
        assert.equal(resetReadback?.turn_id, "effort-reset");
        assert.equal(resetReadback?.data.source, "native");
        assert.equal(resetReadback?.data.scope, "root");
        assert.ok(resetReadback?.data.model_selection.model);
        assert.deepEqual(reset.findLast(event => event.event_type === "session.configured")?.data.model_selection, {model: effortModel.id});
        passed.push("effort-reset", "effective-default-readback", "reset-recall");
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
