import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {harnessContextUsageSchema, hcpHarnessEventPayloadSchema, HcpSessionEventReducer, type HcpHarnessEventPayload, type HcpSessionStartPayload} from "@harness-control/protocol";
import {HarnessSessionManager, HarnessAdapterRegistry} from "./index.js";
import {OpenCodeHarnessAdapter} from "./adapters/providers/opencode.js";
import {readControlledOpenCodeReference, controlledOpenCodeInheritance} from "./adapters/providers/opencode-controlled.js";
import {RunnerConfigSchema} from "../config/index.js";
import {JsonRunnerStateStore} from "../state/index.js";

for (const scenario of ["approval", "question", "session-approval"] as const) test(`OpenCode ${scenario} replies, tool events, native resume and compaction use the generic runner`, async () => {
  const interactive = scenario === "session-approval", kind = scenario === "question" ? "question" : "approval";
  const cwd = await mkdtemp(join(tmpdir(), "hcp-opencode-conversation-"));
  const record = join(cwd, "native.jsonl");
  const config = RunnerConfigSchema.parse({runner_id: "runner", control_plane_url: "ws://localhost:1", workspaces: [{id: "workspace", path: cwd}],
    provider_instances: [{id: "opencode", driver_kind: "opencode", executable_path: process.execPath,
      launch_args: [fileURLToPath(new URL("../../test-fixtures/fake-opencode-server.mjs", import.meta.url))], env: {HCP_TEST_OPENCODE_RECORD: record,
        ...(interactive ? {HCP_TEST_OPENCODE_VERSION: "opencode 1.18.34"} : {})}}]});
  const manager = () => new HarnessSessionManager(config, {stateStore: new JsonRunnerStateStore(join(cwd, "state.json"))});
  let runner = manager();
  const start = (id: string, resume: boolean): HcpSessionStartPayload => ({session_id: id, workspace_id: "workspace", cwd,
    provider_instance_id: "opencode", driver_kind: "opencode", model_selection: {model: "anthropic/claude"}, sandbox_mode: "danger_full_access",
    approval_policy: "ask", continue_session: resume, continuation_group_key: "conversation", mcp_servers: [], instructions: {system: "Application system instructions"},
    ...(interactive ? {execution_profile: "interactive"} : {})});
  try {
    const events: HcpHarnessEventPayload[] = [...await runner.startSession(start("first-session", false))];
    if (interactive) {
      const rejected = await runner.sendTurn({session_id: "first-session", turn_id: "unsupported-variant", input: "must not execute",
        model_selection: {model: "anthropic/claude", options: [{id: "variant", value: "unavailable"}]}});
      events.push(...rejected);
      assert.equal(rejected.at(-1)?.event_type, "turn.failed");
      const requests = (await readFile(record, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      assert.equal(requests.some(request => request.method === "POST" && request.path.endsWith("/message")), false);
    }
    await runner.sendTurn({session_id: "first-session", turn_id: "first-turn", input: kind}, event => {
      events.push(event);
      const data = event.data as Record<string, unknown>;
      if (event.event_type === "approval.requested") void runner.respondToMcpReview({session_id: "first-session", turn_id: "first-turn",
        request_id: data.request_id as string, action_hash: data.action_hash as string, decision: interactive ? "accept_for_session" : "accept", actor_id: "actor"}, () => {});
      if (event.event_type === "user_input.requested") void runner.respondToMcpInput({session_id: "first-session", turn_id: "first-turn",
        request_id: data.request_id as string, actor_id: "actor", value: {answers: {"question-0": {answers: ["A", "B"]}}}}, () => {});
    });
    assert.equal(events.filter(event => event.event_type === "turn.completed").length, 1);
    assert.equal(events.filter(event => event.event_type === "item.completed").length, 1);
    assert.equal(events.filter(event => event.event_type === "item.updated").length, 0);
    if (kind === "approval") assert.equal((events.find(event => event.event_type === "approval.requested")!.data as {allowed_decisions: string[]}).allowed_decisions.includes("accept_for_session"), interactive);
    if (interactive) {
      assert.deepEqual(events.find(event => event.event_type === "settings.options.effective")?.data,
        {scope: "root", source: "native", model_selection: {model: "anthropic/claude", options: []}});
      const repeated = await runner.sendTurn({session_id: "first-session", turn_id: "remembered", input: "approval"});
      assert.equal(repeated.at(-1)?.event_type, "turn.completed");
      assert.equal(repeated.some(event => event.event_type === "approval.requested"), false);
    }
    const reducer = new HcpSessionEventReducer();
    for (const event of events) {hcpHarnessEventPayloadSchema.parse(event); assert.equal(reducer.applyEvent(event).outcome, "applied");}
    await runner.stopSession("first-session", "done");
    runner = manager();
    await runner.startSession(start("second-session", true));
    if (interactive) {
      const reopened: HcpHarnessEventPayload[] = [];
      await runner.sendTurn({session_id: "second-session", turn_id: "fresh-owner", input: "approval"}, event => {
        reopened.push(event);
        if (event.event_type === "approval.requested") {
          const data = event.data as {request_id: string; action_hash: string};
          void runner.respondToMcpReview({session_id: "second-session", turn_id: "fresh-owner", request_id: data.request_id,
            action_hash: data.action_hash, decision: "accept", actor_id: "actor"}, () => {});
        }
      });
      assert.equal(reopened.at(-1)?.event_type, "turn.completed");
      assert.equal(reopened.some(event => event.event_type === "approval.requested"), true);
    }
    const followup = await runner.sendTurn({session_id: "second-session", turn_id: "second-turn", input: "followup", mode: "plan",
      model_selection: {model: "anthropic/claude", options: [{id: "variant", value: "high"}]}, images: [{mime_type: "image/png", data_base64: "aGVsbG8="}]});
    assert.equal(followup.at(-1)?.event_type, "turn.completed");
    if (interactive) assert.deepEqual(followup.find(event => event.event_type === "settings.options.effective")?.data,
      {scope: "root", source: "native", model_selection: {model: "anthropic/claude", options: [{id: "variant", value: "high"}]}});
    const usage = followup.find(event => event.event_type === "usage.updated")?.data;
    assert.deepEqual(usage, {scope: "turn", status: "complete", source: "opencode.message.step-finish", input_tokens: 34,
      output_tokens: 5, total_tokens: 39, cached_input_tokens: 20, cache_creation_input_tokens: 4, reasoning_output_tokens: 2, cost_usd: 0.5});
    assert.deepEqual((followup.at(-1)?.data as {final_output: {usage: unknown}}).final_output.usage, usage);
    assert.equal((followup.find(event => event.event_type === "context.updated")?.data as {status: string}).status, "unavailable");
    const context = harnessContextUsageSchema.parse(followup.filter(event => event.event_type === "context.updated").at(-1)!.data);
    assert.equal(context.status, "measured");
    if (context.status !== "measured") throw new Error("Expected native context measurement");
    assert.equal(context.used_tokens, 37);
    assert.deepEqual(context.selection, {model: "anthropic/claude", options: [{id: "variant", value: "high"}]});
    assert.deepEqual((followup.at(-1)?.data as {final_output: {context: unknown}}).final_output.context, context);
    const compact = await runner.sendTurn({session_id: "second-session", turn_id: "compact", input: "", action: "compact"});
    assert.equal(compact.at(-1)?.event_type, "turn.completed");
    assert.equal((compact.at(-1)?.data as {final_output: {context: {status: string}}}).final_output.context.status, "unavailable");
    const requests = (await readFile(record, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(requests.filter(request => request.path === "/session" && request.method === "POST").length, 1);
    const prompt = requests.filter(request => request.path.endsWith("/message")).at(-1).payload;
    assert.equal(prompt.agent, "plan"); assert.equal(prompt.variant, "high");
    assert.equal(prompt.parts[1].url, "data:image/png;base64,aGVsbG8=");
    assert.equal(prompt.system, "Application system instructions");
    assert.equal(requests.filter(request => request.path.endsWith("/summarize")).length, 1);
    if (interactive) assert.equal(requests.filter(request => request.path === "/event").length, 2,
      "One continuous observation connection per loaded owner, across prompts and compaction");
  } finally {for (const id of ["first-session", "second-session"]) if (runner.activeSessionCount()) await runner.stopSession(id, "cleanup"); await rm(cwd, {recursive: true, force: true});}
});

for(const drift of ["parent","tool","missing"])test(`OpenCode refuses an unconfirmed native callback origin (${drift}) before approval`,async()=>{
  const cwd=await mkdtemp(join(tmpdir(),"hcp-opencode-request-origin-"));
  const record=join(cwd,"native.jsonl");
  const manager=new HarnessSessionManager(RunnerConfigSchema.parse({runner_id:"runner",control_plane_url:"ws://localhost:1",workspaces:[{id:"workspace",path:cwd}],
    provider_instances:[{id:"opencode",driver_kind:"opencode",executable_path:process.execPath,
      launch_args:[fileURLToPath(new URL("../../test-fixtures/fake-opencode-server.mjs",import.meta.url))],
      env:{HCP_TEST_OPENCODE_RECORD:record,HCP_TEST_OPENCODE_REQUEST_ORIGIN_DRIFT:drift}}]}));
  try {
    await manager.startSession({session_id:"session",workspace_id:"workspace",cwd,provider_instance_id:"opencode",driver_kind:"opencode",model_selection:{model:"anthropic/claude"},
      sandbox_mode:"danger_full_access",approval_policy:"ask",continue_session:false,mcp_servers:[]});
    const events=await manager.sendTurn({session_id:"session",turn_id:"root",input:"approval"});
    assert.equal(events.some(event=>event.event_type==="approval.requested"),false);
    assert.equal(events.at(-1)?.event_type,"turn.failed");
    assert.equal((events.at(-1)?.data as {error:{code:string}}).error.code,"native_request_origin_unconfirmed");
    const requests=(await readFile(record,"utf8")).trim().split("\n").map(line=>JSON.parse(line));
    assert.equal(requests.some(request=>request.path.startsWith("/permission/")),false);
    const followup=await manager.sendTurn({session_id:"session",turn_id:"followup",input:"followup"});
    assert.equal(followup.at(-1)?.event_type,"turn.failed");
  }finally{await manager.stopSession("session","test complete");await rm(cwd,{recursive:true,force:true});}
});

test("OpenCode closes uncertain permission owners instead of retaining an unconfirmed remembered grant", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "hcp-opencode-uncertain-reply-"));
  const config = RunnerConfigSchema.parse({runner_id: "runner", control_plane_url: "ws://localhost:1", workspaces: [{id: "workspace", path: cwd}],
    provider_instances: [{id: "opencode", driver_kind: "opencode", executable_path: process.execPath,
      launch_args: [fileURLToPath(new URL("../../test-fixtures/fake-opencode-server.mjs", import.meta.url))],
      env: {HCP_TEST_OPENCODE_VERSION: "opencode 1.18.34", HCP_TEST_OPENCODE_REPLY_ACK: "false"}}]});
  const runner = new HarnessSessionManager(config);
  try {
    await runner.startSession({session_id: "session", workspace_id: "workspace", cwd, provider_instance_id: "opencode", driver_kind: "opencode",
      model_selection: {model: "anthropic/claude"}, sandbox_mode: "danger_full_access", approval_policy: "ask", continue_session: false,
      execution_profile: "interactive", mcp_servers: []});
    const events: HcpHarnessEventPayload[] = [];
    await runner.sendTurn({session_id: "session", turn_id: "turn", input: "approval"}, event => {
      events.push(event);
      if (event.event_type === "approval.requested") {
        const data = event.data as {request_id: string; action_hash: string};
        void runner.respondToMcpReview({session_id: "session", turn_id: "turn", request_id: data.request_id, action_hash: data.action_hash,
          decision: "accept_for_session", actor_id: "actor"}, () => {});
      }
    });
    assert.equal(events.some(event => event.event_type === "turn.completed"), false);
    assert.equal((events.find(event => event.event_type === "turn.failed")!.data as {error: {code: string}}).error.code, "native_reply_unknown");
    const later = await runner.sendTurn({session_id: "session", turn_id: "later", input: "approval"});
    assert.equal(later.some(event => event.event_type === "turn.completed"), false);
    assert.equal((later.find(event => event.event_type === "turn.failed")!.data as {error: {code: string}}).error.code, "native_session_unavailable");
  } finally {await runner.stopSession("session", "done"); await rm(cwd, {recursive: true, force: true});}
});

for (const drift of ["system", "session"] as const) test(`OpenCode rejects ${drift} drift in admitted instruction readback`, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "hcp-opencode-instructions-"));
  const config = RunnerConfigSchema.parse({runner_id: "runner", control_plane_url: "ws://localhost:1", workspaces: [{id: "workspace", path: cwd}],
    provider_instances: [{id: "opencode", driver_kind: "opencode", executable_path: process.execPath,
      launch_args: [fileURLToPath(new URL("../../test-fixtures/fake-opencode-server.mjs", import.meta.url))], env: {HCP_TEST_OPENCODE_INSTRUCTION_DRIFT: drift}}]});
  const runner = new HarnessSessionManager(config);
  try {
    await runner.startSession({session_id: "session", workspace_id: "workspace", cwd, provider_instance_id: "opencode", driver_kind: "opencode",
      model_selection: {model: "anthropic/claude"}, sandbox_mode: "danger_full_access", approval_policy: "ask", continue_session: false,
      instructions: {system: "Application instructions"}, mcp_servers: []});
    const events = await runner.sendTurn({session_id: "session", turn_id: "turn", input: "hello"});
    assert.equal(events.filter(event => event.event_type === "turn.completed").length, 0);
    const terminal = events.filter(event => event.event_type === "turn.failed");
    assert.equal(terminal.length, 1);
    assert.equal((terminal[0]!.data as {error: {code: string}}).error.code, "native_instruction_mismatch");
  } finally {await runner.stopSession("session", "done"); await rm(cwd, {recursive: true, force: true});}
});

for (const controlled of [false, true]) test(`OpenCode ${controlled ? "controlled" : "inherited"} HTTP history forks and logical rollback retain permissions and never restore files`, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "hcp-opencode-history-"));
  const historyFile = join(cwd, "history.json");
  const sourceId = "fake-opencode-session";
  const messages = Array.from({length: 4}, (_, index) => ({info: {id: `msg-${index}`, sessionID: sourceId, role: index % 2 ? "assistant" : "user"},
    parts: [{id: `part-${index}`, sessionID: sourceId, messageID: `msg-${index}`, type: "text", text: `message-${index}`}]}));
  await writeFile(historyFile, JSON.stringify({[sourceId]: {messages}}));
  const config = RunnerConfigSchema.parse({runner_id: "runner", control_plane_url: "ws://localhost:1", workspaces: [{id: "workspace", path: cwd}],
    provider_instances: [{id: "opencode", driver_kind: "opencode", executable_path: process.execPath,
      launch_args: [fileURLToPath(new URL("../../test-fixtures/fake-opencode-server.mjs", import.meta.url))], env: {HCP_TEST_OPENCODE_HISTORY: historyFile,
        ...(controlled ? {HCP_TEST_OPENCODE_VERSION: "opencode 1.18.34", OPENCODE_AUTH_CONTENT: JSON.stringify({anthropic: {type: "api", key: "fixture-only-key"}})} : {})}}]});
  const stateFile = join(cwd, "state.json");
  const state = new JsonRunnerStateStore(stateFile);
  const manager = (stateStore: JsonRunnerStateStore) => new HarnessSessionManager(config, {stateStore,
    adapterRegistry: new HarnessAdapterRegistry([new OpenCodeHarnessAdapter({controlledStorageRoot: join(cwd, "owned-native")})])});
  let runner = manager(state);
  const start: HcpSessionStartPayload = {session_id: "session", workspace_id: "workspace", cwd, provider_instance_id: "opencode", driver_kind: "opencode",
    model_selection: {model: "anthropic/claude"}, sandbox_mode: "danger_full_access", approval_policy: "ask", continue_session: false, continuation_group_key: "conversation", mcp_servers: [],
    ...(controlled ? {configuration_inheritance: controlledOpenCodeInheritance} : {})};
  try {
    await runner.startSession(start);
    await runner.sendTurn({session_id: "session", turn_id: "turn", input: "initial"});
    await runner.stopSession("session", "idle");
    const original = JSON.parse(await readFile(historyFile, "utf8"));
    const modified = structuredClone(original);
    modified[sourceId].permission[0].action = "allow";
    await writeFile(historyFile, JSON.stringify(modified));
    await assert.rejects(runner.conversationOperation("drift-read", {session_id: "session", operation: {kind: "read"}}), /retained permissions differ/);
    await assert.rejects(runner.startSession({...start, session_id: "drift-resume", continue_session: true}), /retained permissions differ/);
    await writeFile(historyFile, JSON.stringify(original));
    const read = await runner.conversationOperation("read", {session_id: "session", operation: {kind: "read", limit: 1}});
    assert.equal(read.history?.turn_count, 2);
    assert.equal(read.history!.turns[0]!.portable_items?.[0]?.type, "message");
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
    const childRef = controlled ? readControlledOpenCodeReference(fork.fork!.native_reference)!.session_id : fork.fork!.native_reference;
    assert.equal(retained[childRef].messages.length, 2);
    assert.deepEqual(retained[childRef].permission, retained[sourceId].permission);
    if (controlled) {
      assert.ok(readControlledOpenCodeReference(rollback.native_reference!)?.account_binding);
      assert.equal((await readFile(stateFile, "utf8")).includes("fixture-only-key"), false);
      await assert.rejects(runner.startSession({...start, session_id: "different-owner", continue_session: true, configuration_inheritance: {hooks: true}}), /preserve.*controlled/);
      const env = config.provider_instances[0]!.env;
      const originalAuth = env.OPENCODE_AUTH_CONTENT!;
      env.OPENCODE_AUTH_CONTENT = JSON.stringify({anthropic: {type: "api", key: "another-fixture-account"}});
      await assert.rejects(runner.conversationOperation("account-drift", {session_id: "session", operation: {kind: "read"}}), /provider identity changed/);
      env.OPENCODE_AUTH_CONTENT = originalAuth;
      env.HCP_TEST_OPENCODE_VERSION = "opencode 1.18.35";
      await assert.rejects(runner.conversationOperation("version-drift", {session_id: "session", operation: {kind: "read"}}), /provider identity changed/);
      await assert.rejects(runner.startSession({...start, session_id: "unsupported-version", continuation_group_key: "unsupported-version"}), /verified OpenCode 1.18.34/);
      env.HCP_TEST_OPENCODE_VERSION = "opencode 1.18.34";
    }
    runner = manager(new JsonRunnerStateStore(stateFile));
    await runner.startSession({...start, session_id: "reopened", continue_session: true});
    const events = await runner.sendTurn({session_id: "reopened", turn_id: "followup", input: "continue"});
    assert.equal(events.at(-1)?.event_type, "turn.completed");
    await runner.stopSession("reopened", "done");
  } finally {await rm(cwd, {recursive: true, force: true});}
});
