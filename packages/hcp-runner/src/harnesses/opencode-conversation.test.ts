import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {hcpHarnessEventPayloadSchema, HcpSessionEventReducer, type HcpHarnessEventPayload, type HcpSessionStartPayload} from "@harness-control/protocol";
import {HarnessSessionManager} from "./index.js";
import {RunnerConfigSchema} from "../config/index.js";
import {JsonRunnerStateStore} from "../state/index.js";

for (const kind of ["approval", "question"] as const) test(`OpenCode ${kind} replies, tool events, native resume and compaction use the generic runner`, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "hcp-opencode-conversation-"));
  const record = join(cwd, "native.jsonl");
  const config = RunnerConfigSchema.parse({runner_id: "runner", control_plane_url: "ws://localhost:1", workspaces: [{id: "workspace", path: cwd}],
    provider_instances: [{id: "opencode", driver_kind: "opencode", executable_path: process.execPath,
      launch_args: [fileURLToPath(new URL("../../test-fixtures/fake-opencode-server.mjs", import.meta.url))], env: {HCP_TEST_OPENCODE_RECORD: record}}]});
  const manager = () => new HarnessSessionManager(config, {stateStore: new JsonRunnerStateStore(join(cwd, "state.json"))});
  let runner = manager();
  const start = (id: string, resume: boolean): HcpSessionStartPayload => ({session_id: id, workspace_id: "workspace", cwd,
    provider_instance_id: "opencode", driver_kind: "opencode", model_selection: {model: "anthropic/claude"}, sandbox_mode: "danger_full_access",
    approval_policy: "ask", continue_session: resume, continuation_group_key: "conversation", mcp_servers: []});
  try {
    const events: HcpHarnessEventPayload[] = [...await runner.startSession(start("first-session", false))];
    await runner.sendTurn({session_id: "first-session", turn_id: "first-turn", input: kind}, event => {
      events.push(event);
      const data = event.data as Record<string, unknown>;
      if (event.event_type === "approval.requested") void runner.respondToMcpReview({session_id: "first-session", turn_id: "first-turn",
        request_id: data.request_id as string, action_hash: data.action_hash as string, decision: "accept", actor_id: "actor"}, () => {});
      if (event.event_type === "user_input.requested") void runner.respondToMcpInput({session_id: "first-session", turn_id: "first-turn",
        request_id: data.request_id as string, actor_id: "actor", value: {answers: {"question-0": {answers: ["A", "B"]}}}}, () => {});
    });
    assert.equal(events.filter(event => event.event_type === "turn.completed").length, 1);
    assert.equal(events.filter(event => event.event_type === "item.completed").length, 1);
    assert.equal(events.filter(event => event.event_type === "item.updated").length, 0);
    const reducer = new HcpSessionEventReducer();
    for (const event of events) {hcpHarnessEventPayloadSchema.parse(event); assert.equal(reducer.applyEvent(event).outcome, "applied");}
    await runner.stopSession("first-session", "done");
    runner = manager();
    await runner.startSession(start("second-session", true));
    const followup = await runner.sendTurn({session_id: "second-session", turn_id: "second-turn", input: "followup", mode: "plan",
      model_selection: {model: "anthropic/claude", options: [{id: "variant", value: "high"}]}, images: [{mime_type: "image/png", data_base64: "aGVsbG8="}]});
    assert.equal(followup.at(-1)?.event_type, "turn.completed");
    const compact = await runner.sendTurn({session_id: "second-session", turn_id: "compact", input: "", action: "compact"});
    assert.equal(compact.at(-1)?.event_type, "turn.completed");
    const requests = (await readFile(record, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(requests.filter(request => request.path === "/session" && request.method === "POST").length, 1);
    const prompt = requests.filter(request => request.path.endsWith("/message")).at(-1).payload;
    assert.equal(prompt.agent, "plan"); assert.equal(prompt.variant, "high");
    assert.equal(prompt.parts[1].url, "data:image/png;base64,aGVsbG8=");
    assert.equal(requests.filter(request => request.path.endsWith("/summarize")).length, 1);
  } finally {for (const id of ["first-session", "second-session"]) if (runner.activeSessionCount()) await runner.stopSession(id, "cleanup"); await rm(cwd, {recursive: true, force: true});}
});

test("OpenCode HTTP history forks and logical rollback retain permissions and never restore files", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "hcp-opencode-history-"));
  const historyFile = join(cwd, "history.json");
  const sourceId = "fake-opencode-session";
  const messages = Array.from({length: 4}, (_, index) => ({info: {id: `msg-${index}`, sessionID: sourceId, role: index % 2 ? "assistant" : "user"},
    parts: [{id: `part-${index}`, sessionID: sourceId, messageID: `msg-${index}`, type: "text", text: `message-${index}`}]}));
  await writeFile(historyFile, JSON.stringify({[sourceId]: {messages}}));
  const config = RunnerConfigSchema.parse({runner_id: "runner", control_plane_url: "ws://localhost:1", workspaces: [{id: "workspace", path: cwd}],
    provider_instances: [{id: "opencode", driver_kind: "opencode", executable_path: process.execPath,
      launch_args: [fileURLToPath(new URL("../../test-fixtures/fake-opencode-server.mjs", import.meta.url))], env: {HCP_TEST_OPENCODE_HISTORY: historyFile}}]});
  const stateFile = join(cwd, "state.json");
  const state = new JsonRunnerStateStore(stateFile);
  let runner = new HarnessSessionManager(config, {stateStore: state});
  const start: HcpSessionStartPayload = {session_id: "session", workspace_id: "workspace", cwd, provider_instance_id: "opencode", driver_kind: "opencode",
    model_selection: {model: "anthropic/claude"}, sandbox_mode: "danger_full_access", approval_policy: "ask", continue_session: false, continuation_group_key: "conversation", mcp_servers: []};
  try {
    await runner.startSession(start);
    await runner.sendTurn({session_id: "session", turn_id: "turn", input: "initial"});
    await runner.stopSession("session", "idle");
    const read = await runner.conversationOperation("read", {session_id: "session", operation: {kind: "read", limit: 1}});
    assert.equal(read.history?.turn_count, 2);
    const older = await runner.conversationOperation("older", {session_id: "session", operation: {kind: "read", cursor: read.history!.next_cursor!, limit: 1}});
    const forkRequest = {session_id: "session", operation: {kind: "fork" as const, target_session_id: "child", continuation_group_key: "child-key",
      expected_history_hash: read.history!.history_hash, last_turn_id: older.history!.turns[0]!.id}};
    const fork = await runner.conversationOperation("fork", forkRequest);
    assert.deepEqual(await runner.conversationOperation("fork", forkRequest), fork);
    await assert.rejects(runner.conversationOperation("fork", {...forkRequest, operation: {...forkRequest.operation, last_turn_id: "msg-2"}}), /different parameters/);
    const rollbackRequest = {session_id: "session", operation: {kind: "rollback" as const, num_turns: 1, expected_history_hash: read.history!.history_hash}};
    const rollback = await runner.conversationOperation("rollback", rollbackRequest);
    assert.equal(rollback.history?.turn_count, 1);
    assert.equal(rollback.filesystem_undo, false);
    assert.equal((await runner.conversationOperation("rollback", rollbackRequest)).native_reference, rollback.native_reference);
    const retained = JSON.parse(await readFile(historyFile, "utf8"));
    assert.equal(retained[sourceId].messages.length, 4);
    assert.equal(retained[fork.fork!.native_reference].messages.length, 2);
    assert.deepEqual(retained[fork.fork!.native_reference].permission, retained[sourceId].permission);
    runner = new HarnessSessionManager(config, {stateStore: new JsonRunnerStateStore(stateFile)});
    await runner.startSession({...start, session_id: "reopened", continue_session: true});
    const events = await runner.sendTurn({session_id: "reopened", turn_id: "followup", input: "continue"});
    assert.equal(events.at(-1)?.event_type, "turn.completed");
    await runner.stopSession("reopened", "done");
  } finally {await rm(cwd, {recursive: true, force: true});}
});
