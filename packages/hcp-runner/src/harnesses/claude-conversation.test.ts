import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { HcpSessionEventReducer, hcpHarnessEventPayloadSchema, type HcpSessionStartPayload, type HcpHarnessEventPayload } from "@harness-control/protocol";
import { HarnessSessionManager, HarnessAdapterRegistry } from "./index.js";
import { ClaudeHarnessAdapter } from "./adapters.js";
import { RunnerConfigSchema } from "../config/index.js";
import { JsonRunnerStateStore } from "../state/index.js";
import type { ClaudeQueryFactory } from "./adapters/providers/claude-runtime.js";

for (const kind of ["approval", "file-read", "other", "question", "steer"] as const) test(`Claude ${kind} uses public controls and resumes the same conversation after runner recreation`, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "hcp-claude-conversation-"));
  const optionsSeen: Options[] = [];
  const turns: string[] = [];
  let compactProof = true;
  let nativeReady!: () => void;
  const ready = new Promise<void>(resolve => {nativeReady = resolve;});
  const queryFactory: ClaudeQueryFactory = ({prompt, options}) => {
    optionsSeen.push(options!);
    const stream = (async function* () {
      const nativeId = options!.resume ?? options!.sessionId!;
      const iterator = (prompt as AsyncIterable<import("@anthropic-ai/claude-agent-sdk").SDKUserMessage>)[Symbol.asyncIterator]();
      const first = await iterator.next();
      const text = first.value!.message.content as string;
      turns.push(text);
      yield {type: "system", subtype: "init", session_id: nativeId, cwd: options!.cwd, permissionMode: options!.permissionMode,
        mcp_servers: Object.keys(options!.mcpServers ?? {}).map(name => ({name, status: "connected"})), plugins: [],
        apiKeySource: "none", claude_code_version: "fixture", tools: [], model: options!.model!, slash_commands: [], output_style: "default", skills: [],
        uuid: "00000000-0000-0000-0000-000000000000"} as SDKMessage;
      if (text === "/compact" && compactProof) yield {type: "system", subtype: "compact_boundary", session_id: nativeId} as SDKMessage;
      let result = text;
      if (text === "first") {
        if (kind === "steer") {
          nativeReady();
          result = (await iterator.next()).value!.message.content as string;
        } else {
          const args = kind === "approval" ? {command: "echo approved"} : kind === "file-read" ? {file_path: join(cwd, "file.txt")} : kind === "other" ? {pattern: "*.ts"} : {questions: [{header: "Scope", question: "Which scope?", multiSelect: true,
            options: [{label: "A", description: "first"}, {label: "B", description: "second"}]}]};
          const response = await options!.canUseTool!(kind === "approval" ? "Bash" : kind === "file-read" ? "Read" : kind === "other" ? "Glob" : "AskUserQuestion", args,
            {toolUseID: "native-tool", requestId: "native-request", signal: new AbortController().signal});
          assert.equal(response?.behavior, "allow");
          if (kind === "question") assert.deepEqual(response?.behavior === "allow" && response.updatedInput?.answers, {"Which scope?": "A, B"});
          result = "approved result";
        }
      }
      yield {type: "result", subtype: "success", is_error: false, session_id: nativeId, result} as SDKMessage;
    })();
    return Object.assign(stream, {close() {}}) as Query;
  };
  const config = RunnerConfigSchema.parse({runner_id: "runner", control_plane_url: "ws://localhost:1", workspaces: [{id: "workspace", path: cwd}],
    provider_instances: [{id: "claude", driver_kind: "claude"}]});
  const manager = () => new HarnessSessionManager(config, {stateStore: new JsonRunnerStateStore(join(cwd, "state.json")),
    adapterRegistry: new HarnessAdapterRegistry([new ClaudeHarnessAdapter({queryFactory})])});
  let runner = manager();
  const start = (id: string, resume: boolean): HcpSessionStartPayload => ({session_id: id, workspace_id: "workspace", cwd,
    provider_instance_id: "claude", driver_kind: "claude", model_selection: {model: "sonnet"}, sandbox_mode: "danger_full_access",
    approval_policy: "ask", continue_session: resume, continuation_group_key: "conversation", mcp_servers: []});
  const events: HcpHarnessEventPayload[] = [];
  try {
    events.push(...await runner.startSession(start("first-session", false)));
    const running = runner.sendTurn({session_id: "first-session", turn_id: "first-turn", input: "first"}, event => {
      events.push(event);
      const data = event.data as Record<string, unknown>;
      if (event.event_type === "approval.requested") void runner.respondToMcpReview({session_id: "first-session", turn_id: "first-turn",
        request_id: data.request_id as string, action_hash: data.action_hash as string, decision: "accept", actor_id: "actor"}, () => {});
      if (event.event_type === "user_input.requested") void runner.respondToMcpInput({session_id: "first-session", turn_id: "first-turn",
        request_id: data.request_id as string, actor_id: "actor", value: {answers: {"question-0": {answers: ["A", "B"]}}}}, () => {});
    });
    if (kind === "steer") {
      await ready;
      await runner.conversationOperation("steer-command", {session_id: "first-session", operation: {kind: "steer", turn_id: "first-turn", input: "steered"}});
    }
    await running;
    assert.equal(events.filter(event => event.event_type === "turn.completed").length, 1);
    const reducer = new HcpSessionEventReducer();
    for (const event of events) {hcpHarnessEventPayloadSchema.parse(event); assert.equal(reducer.applyEvent(event).outcome, "applied");}
    await runner.stopSession("first-session", "done");
    runner = manager();
    await runner.startSession(start("second-session", true));
    await runner.sendTurn({session_id: "second-session", turn_id: "second-turn", input: "followup"});
    assert.equal(optionsSeen[1]?.resume, optionsSeen[0]?.sessionId);
    assert.deepEqual(turns, ["first", "followup"]);
    assert.equal(optionsSeen[0]?.permissionMode, "default");
    assert.equal(optionsSeen[0]?.persistSession, true);
    assert.deepEqual(optionsSeen[0]?.settingSources, []);
    assert.deepEqual(optionsSeen[0]?.settings, {disableAllHooks: true});
    const compact = await runner.sendTurn({session_id: "second-session", turn_id: "compact", input: "", action: "compact"});
    assert.equal(compact.at(-1)?.event_type, "turn.completed");
    assert.equal(optionsSeen[2]?.resume, optionsSeen[0]?.sessionId);
    assert.equal(turns[2], "/compact");
    compactProof = false;
    const unconfirmed = await runner.sendTurn({session_id: "second-session", turn_id: "unconfirmed", input: "", action: "compact"});
    assert.equal(unconfirmed.at(-1)?.event_type, "turn.failed");
  } finally {for (const id of ["first-session", "second-session"]) if (runner.activeSessionCount()) await runner.stopSession(id, "cleanup"); await rm(cwd, {recursive: true, force: true});}
});
