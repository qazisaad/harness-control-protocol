import assert from "node:assert/strict";
import {mkdtemp, readFile, writeFile, access, unlink} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {HarnessSessionManager} from "@harness-control/runner/harnesses";
import {RunnerConfigSchema} from "@harness-control/runner/config";
import {JsonRunnerStateStore} from "@harness-control/runner/state";
import {hcpHarnessEventPayloadSchema} from "@harness-control/protocol";

if (process.env.HCP_NATIVE_LIVE !== "1") throw new Error("Set HCP_NATIVE_LIVE=1 to run authenticated native acceptance.");
const providers = (process.env.HCP_LIVE_PROVIDERS ?? "claude,opencode").split(",");
for (const driver of providers) {
  assert.ok(["claude", "opencode"].includes(driver));
  const cwd = await mkdtemp(join(tmpdir(), `hcp-live-interactions-${driver}-`));
  const config = RunnerConfigSchema.parse({runner_id: "interaction-acceptance", control_plane_url: "ws://localhost:8787",
    workspaces: [{id: "workspace", path: cwd}], provider_instances: [{id: driver, driver_kind: driver}]});
  const manager = new HarnessSessionManager(config, {stateStore: new JsonRunnerStateStore(join(cwd, "state.json"))});
  const session = `${driver}-interactions`, events = [], responses = [], passed = [];
  const marker = randomUUID(), target = join(cwd, "approved.txt");
  const command = `printf '%s' '${marker}' > '${target}'`;
  let cancelledRequest;
  let stage = "approval";
  const observed = new Set();
  const track = (promise, turnId) => {
    responses.push(promise);
    void promise.catch(() => manager.cancelTurn(session, turnId).catch(() => {}));
  };
  const observe = event => {
    const identity = `${event.session_id}:${event.sequence}`;
    if (observed.has(identity)) return;
    observed.add(identity);
    hcpHarnessEventPayloadSchema.parse(event); events.push(event);
    if (event.event_type === "approval.requested") {
      if (stage === "cancel") {
        cancelledRequest = event;
        track(manager.cancelTurn(session, event.turn_id), event.turn_id);
        return;
      }
      const action = JSON.parse(event.data.action);
      const details = action.details;
      // Approve only the exact controlled test write. Unexpected native actions are declined.
      const approved = stage === "approval" && (details.arguments?.command === command || details.metadata?.command === command
        || details.arguments?.file_path === target && details.arguments?.content === marker);
      track(manager.respondToMcpReview({session_id: session, turn_id: event.turn_id,
        request_id: event.data.request_id, action_hash: event.data.action_hash,
        decision: approved ? (driver === "opencode" && process.env.HCP_LIVE_REMEMBER_OPENCODE === "1" ? "accept_for_session" : "accept") : "decline", actor_id: "live-test"}, observe), event.turn_id);
    }
    if (event.event_type === "user_input.requested") {
      assert.equal(stage, "question", "Unexpected native input outside the controlled question");
      track(manager.respondToMcpInput({session_id: session, turn_id: event.turn_id,
        request_id: event.data.request_id, actor_id: "live-test", value: {answers: {"question-0": {answers: ["Green"]}}}}, observe), event.turn_id);
    }
  };
  const unsubscribe = manager.subscribeEvents(observe);
  const run = async (turn_id, input, expected = "turn.completed") => {
    console.log(JSON.stringify({driver, stage, cwd}));
    await manager.sendTurn({session_id: session, turn_id, input}, observe);
    await Promise.all(responses);
    const terminal = events.findLast(event => event.turn_id === turn_id && ["turn.completed", "turn.failed", "turn.cancelled"].includes(event.event_type));
    assert.equal(terminal?.event_type, expected, JSON.stringify(terminal?.data));
    return terminal;
  };
  try {
    await manager.startSession({session_id: session, workspace_id: "workspace", provider_instance_id: driver, driver_kind: driver, cwd,
      model_selection: {model: driver === "claude" ? process.env.HCP_LIVE_CLAUDE_MODEL ?? "sonnet" : process.env.HCP_LIVE_OPENCODE_MODEL ?? "opencode-go/minimax-m2.7"},
      sandbox_mode: "danger_full_access", approval_policy: "ask", continue_session: false, mcp_servers: [],
      ...(driver === "claude" || driver === "opencode" && process.env.HCP_LIVE_REMEMBER_OPENCODE === "1" ? {execution_profile: "interactive"} : {})});
    await run("approval", `Use the ${driver === "claude" ? "Bash" : "bash"} tool to run exactly this command, with no prefix or suffix: ${command}\nDo not use any other tool. Wait for permission if asked, then reply done.`);
    assert.ok(events.some(event => event.turn_id === "approval" && event.event_type === "approval.requested"), "No native approval was observed");
    assert.equal(await readFile(target, "utf8"), marker);
    passed.push("native-approval", "approved-effect");
    if (driver === "opencode" && process.env.HCP_LIVE_REMEMBER_OPENCODE === "1") {
      assert.ok(events.find(event => event.turn_id === "approval" && event.event_type === "approval.requested").data.allowed_decisions.includes("accept_for_session"));
      await unlink(target);
      stage = "remembered";
      await run("remembered", `Use the bash tool to run exactly this command again, with no prefix or suffix: ${command}\nDo not use any other tool. Then reply done.`);
      assert.equal(events.some(event => event.turn_id === "remembered" && event.event_type === "approval.requested"), false, "The native runtime did not retain its offered session permission");
      assert.equal(await readFile(target, "utf8"), marker);
      passed.push("remembered-session-decision", "repeated-authorized-effect");
    }
    stage = "question";
    const answer = await run("question", `Use the ${driver === "claude" ? "AskUserQuestion" : "question"} tool to ask exactly one question: Which test color? Offer Green and Blue, allow one choice. Do not answer it yourself. After the user replies, respond with their color only. Do not use other tools.`);
    assert.ok(events.some(event => event.turn_id === "question" && event.event_type === "user_input.requested"), "No native question was observed");
    assert.match(JSON.stringify(answer.data.final_output), /Green/);
    passed.push("native-question", "question-response");
    if (process.env.HCP_LIVE_CANCEL === "1") {
      stage = "cancel";
      const cancelledTarget = join(cwd, "cancelled.txt");
      const cancelledCommand = `printf '%s' '${marker}' > '${cancelledTarget}'`;
      await run("cancel", `Use the ${driver === "claude" ? "Bash" : "bash"} tool to run exactly this command, with no prefix or suffix: ${cancelledCommand}\nDo not use any other tool. Wait for permission if asked, then reply done.`, "turn.cancelled");
      assert.ok(cancelledRequest, "No native approval was observed before cancellation");
      await assert.rejects(access(cancelledTarget), {code: "ENOENT"});
      await assert.rejects(manager.respondToMcpReview({session_id: session, turn_id: "cancel", request_id: cancelledRequest.data.request_id,
        action_hash: cancelledRequest.data.action_hash, decision: "accept", actor_id: "live-test"}, observe));
      passed.push("cancel-waiting-approval", "cancelled-effect-absent", "lost-callback-refused");
      stage = "after-cancel";
      await run("after-cancel", "Reply STILL_USABLE only. Do not use tools.");
      passed.push("followup-after-cancel");
    }
    console.log(JSON.stringify({driver, passed, cwd, event_count: events.length}));
  } catch (error) {
    console.error(JSON.stringify({driver, passed, cwd, failed: error instanceof Error ? error.message : String(error)}));
    process.exitCode = 1;
  } finally {
    try {await manager.stopSession(session, "live-cleanup");} catch (error) {console.error(error.message); process.exitCode = 1;}
    unsubscribe();
    await writeFile(join(cwd, "events.json"), JSON.stringify(events, null, 2));
  }
}
