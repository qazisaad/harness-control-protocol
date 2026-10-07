import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import type {
  Query,
  SDKMessage,
  Options,
} from "@anthropic-ai/claude-agent-sdk";
import {
  HcpSessionEventReducer,
  hcpHarnessEventPayloadSchema,
  type HcpSessionStartPayload,
} from "@harness-control/protocol";
import {
  CodexHarnessAdapter,
  ClaudeHarnessAdapter,
  HarnessAdapterError,
  type HarnessAdapterEvent,
} from "./adapters.js";
import type { ProviderInstanceConfig } from "../config/index.js";
import type { ClaudeQueryFactory } from "./adapters/providers/claude-runtime.js";

function provider(driver: string, executable?: string): ProviderInstanceConfig {
  return {
    id: driver,
    driver_kind: driver,
    enabled: true,
    launch_args: [],
    env: {},
    models: [],
    hidden_models: [],
    model_order: [],
    favorite_models: [],
    local_capabilities: [],
    ...(executable ? { executable_path: executable } : {}),
  };
}
function start(driver: string, cwd: string): HcpSessionStartPayload {
  return {
    session_id: "session",
    workspace_id: "workspace",
    provider_instance_id: driver,
    driver_kind: driver,
    cwd,
    sandbox_mode:
      driver === "claude" ? "danger_full_access" : "workspace_write",
    approval_policy: "full_access",
    continue_session: false,
    model_selection: { model: "test-model" },
    mcp_servers: [],
  };
}
function turn(
  payload: HcpSessionStartPayload,
  selected: ProviderInstanceConfig,
  emitEvent?: (event: HarnessAdapterEvent) => void,
) {
  return {
    payload: {
      session_id: payload.session_id,
      turn_id: "turn",
      input: "hello",
    },
    startPayload: payload,
    provider: selected,
    session: { adapter_session_id: payload.session_id },
    ...(emitEvent ? { emitEvent } : {}),
  };
}
function verifyTranscript(events: HarnessAdapterEvent[]): void {
  const reducer = new HcpSessionEventReducer();
  for (const [index, event] of events.entries()) {
    const payload = {
      ...event,
      session_id: "session",
      sequence: index + 1,
      created_at: new Date().toISOString(),
    };
    hcpHarnessEventPayloadSchema.parse(payload);
    assert.equal(reducer.applyEvent(payload).outcome, "applied");
    assert.equal(reducer.applyEvent(payload).outcome, "duplicate");
  }
  assert.equal(
    events.filter((event) =>
      ["turn.completed", "turn.failed", "turn.cancelled"].includes(
        event.event_type,
      ),
    ).length,
    1,
  );
}
const fixture = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
if (process.argv.includes('--version')) { console.log(process.env.VERSION ?? 'codex-cli fixture'); process.exit(0); }
if (process.argv.includes('login')) process.exit(0);
const send = (x) => process.stdout.write(JSON.stringify(x)+'\n');
const notify = (method, params) => send({method,params});
let selectedTool; let finishTool; let turns = 0;
readline.createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line); if (!m.id) return;
 fs.appendFileSync(process.env.RECORD,JSON.stringify({...m,nativePid:process.pid})+'\n');
 if(m.id==='native-call') { if(!m.result?.success) throw new Error('Native MCP failed'); finishTool(); return; }
 if(m.method==='initialize') send({id:m.id,result:{}});
 if(m.method==='config/read') send({id:m.id,result:{config:{mcp_servers:{inherited:{url:'http://localhost:1',enabled:true}},plugins:{'plugin@vendor':{enabled:true}}}}});
 if(m.method==='mcpServerStatus/list') send({id:m.id,result:{data:[{name:'inherited',runtimeStatus:'disabled',tools:{}},{name:'plugin-server',runtimeStatus:process.env.MODE==='mcp-leak'?'connected':'disabled',tools:{}}],nextCursor:null}});
 if(m.method==='feedback/upload') send({id:m.id,result:{threadId:'feedback-receipt'}});
 if(m.method==='thread/start') { selectedTool=m.params.dynamicTools?.[0]; send({id:m.id,result:{thread:{id:'native-thread'},sandbox:{type:process.env.MODE==='policy'?'dangerFullAccess':'workspaceWrite',writableRoots:[],excludeTmpdirEnvVar:true,excludeSlashTmp:true},approvalPolicy:'never',approvalsReviewer:process.env.MODE==='reviewer'?'auto_review':m.params.approvalsReviewer}}); }
 if(m.method==='thread/section/move')send({id:m.id,result:{}});
 if(m.method==='thread/read')send({id:m.id,result:{thread:{id:'native-thread',cwd:process.cwd(),path:process.cwd()+'/native-rollout.jsonl',turns:[]}}});
 if(m.method==='thread/settings/update') { notify('thread/settings/updated',{threadId:m.params.threadId,threadSettings:{model:m.params.model,summary:m.params.summary,effort:m.params.collaborationMode.settings.reasoning_effort,
   collaborationMode:m.params.collaborationMode,cwd:process.cwd(),approvalPolicy:'never',approvalsReviewer:'user',sandboxPolicy:{type:'workspaceWrite',writableRoots:[],excludeTmpdirEnvVar:true,excludeSlashTmp:true}}}); send({id:m.id,result:{}}); }
 if(m.method==='turn/interrupt') {send({id:m.id,result:{}}); notify('turn/completed',{threadId:m.params.threadId,turn:{id:m.params.turnId,status:'interrupted',error:null}});}
 if(m.method==='thread/unsubscribe') send({id:m.id,result:{status:'unsubscribed'}});
 if(m.method==='turn/start') {
  const turnId=turns++?'native-turn-'+turns:'native-turn';
  const params={threadId:'native-thread',turnId};
  if(process.env.MODE==='admission') {
    notify('turn/started',{threadId:'native-thread',turn:{id:'unadmitted-turn'}});
    notify('item/agentMessage/delta',{threadId:'native-thread',turnId:'unadmitted-turn',delta:'FOREIGN_ROOT'});
    notify('turn/completed',{threadId:'native-thread',turn:{id:'unadmitted-turn',status:'completed',error:null}});
  }
  notify('turn/started',{threadId:'native-thread',turn:{id:turnId}});
  if(process.env.MODE==='admission') setTimeout(()=>send({id:m.id,result:{turn:{id:turnId}}}),50);
  else send({id:m.id,result:{turn:{id:turnId}}});
  if(process.env.MODE==='retained' && m.params.input[0].text==='wait') return;
  if(process.env.MODE==='exit') return process.exit(0);
  if(process.env.MODE==='request') return send({id:'approval-1',method:'item/commandExecution/requestApproval',params});
  if(process.env.MODE==='malformed') return process.stdout.write('not json\n');
  const finish=()=>{
  if(process.env.MODE==='reroute'){notify('model/rerouted',{...params,turnId:'foreign-turn',fromModel:'test-model',toModel:'FOREIGN_MODEL',reason:'fixture'});notify('model/rerouted',{...params,fromModel:'test-model',toModel:'native-replacement',reason:'highRiskCyberActivity'});}
  const tokenUsage={total:{inputTokens:900,outputTokens:100,totalTokens:1000},last:{totalTokens:50},modelContextWindow:200000};
  notify('thread/tokenUsage/updated',{...params,tokenUsage});
  notify('thread/tokenUsage/updated',{...params,turnId:'old-turn',tokenUsage:{...tokenUsage,last:{totalTokens:99999}}});
  notify('thread/tokenUsage/updated',{...params,turnId:'foreign-turn',tokenUsage:{total:{inputTokens:-1}}});
  const delta=JSON.stringify({method:'item/agentMessage/delta',params:{...params,delta:'🙂hello'}})+'\n';
  const bytes=Buffer.from(delta); const i=bytes.indexOf(Buffer.from('🙂'))+1;
  process.stdout.write(bytes.subarray(0,i));
  setTimeout(()=>{process.stdout.write(bytes.subarray(i));
   if(process.env.MODE==='sleep') return;
   setTimeout(()=>{
    notify('item/started',{...params,item:{id:'native-mcp-item',type:'mcpToolCall',server:'fixture-server',tool:'lookup',arguments:{query:'fixture'},status:'inProgress'}});
    notify('item/completed',{...params,item:{id:'native-mcp-item',type:'mcpToolCall',server:'fixture-server',tool:'lookup',arguments:{query:'fixture'},status:'completed',result:{content:[{type:'text',text:'fixture result'}]},error:null}});
    notify('item/completed',{...params,item:{id:'message',type:'agentMessage',phase:'final_answer',text:'x'.repeat(80000)}});
    notify('turn/completed',{threadId:'native-thread',turn:{id:turnId,status:process.env.MODE==='failed'?'failed':'completed',error:null}});
   },30);
  },5);
  };
  if(process.env.MODE==='success') { finishTool=finish; send({id:'native-call',method:'item/tool/call',params:{...params,callId:'echo-call',namespace:selectedTool.name,tool:'echo',arguments:{text:'hello'}}}); } else finish();
 }
});
`;

for (const mode of [
  "success",
  "admission",
  "exit",
  "failed",
  "malformed",
  "request",
  "policy",
  "mcp-leak",
  "reroute",
  "sleep",
]) {
  it(`Codex app-server ${mode} through real stdio and production reducer`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "hcp-native-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const executable = join(root, "codex.cjs");
    const record = join(root, "requests.jsonl");
    await writeFile(executable, fixture);
    await chmod(executable, 0o755);
    const selected = provider("codex", executable);
    selected.env = { MODE: mode, RECORD: record };
    const payload = start("codex", root);
    payload.model_selection.options = [
      { id: "reasoningEffort", value: "high" },
    ];
    const adapter = new CodexHarnessAdapter({
      turnTimeoutMs: mode === "sleep" ? 1500 : 5000,
    });
    const events: HarnessAdapterEvent[] = [];
    const toolCalls: unknown[] = [];
    let running = true;
    const terminal = await adapter.sendTurn({
      ...turn(payload, selected, (event) => {
        assert.equal(running, true);
        events.push(event);
      }),
      mcpServers: mode === "success" ? [{
        name: "selected", transport: "streamable_http", url: "https://mcp.example.test/mcp", headers: {Authorization: "Bearer never-forward-this-token"}, allowed_tools: ["echo"],
      }] : [],
      mcpToolsets: mode === "success" ? [{name: "selected", tools: [{name: "echo", input_schema: {type: "object"}}],
        async callTool(name, args) {toolCalls.push([name, args]); return {is_error: false, structured_content: {text: "hello"}};},
      }] : [],
    });
    running = false;
    events.push(...terminal);
    assert.equal(
      events.at(-1)?.event_type,
      ["success", "admission", "reroute"].includes(mode) ? "turn.completed" : "turn.failed",
    );
    if (["success", "admission", "reroute"].includes(mode)) {
      assert.equal(JSON.stringify(events).includes("FOREIGN_ROOT"), false);
      const context = events.filter(event => event.event_type === "context.updated").at(-1)!.data;
      if (mode === "reroute") {
        assert.equal(JSON.stringify(events).includes("FOREIGN_MODEL"), false);
        assert.deepEqual(context.selection, {model: "native-replacement"});
        assert.ok(events.some(event => event.event_type === "context.updated" && event.data.reason === "native_model_changed"));
        assert.equal(events.filter(event => event.event_type === "model.rerouted").length, 1);
      }
      const liveTool = events.find(event => event.event_type === "item.completed" && event.data.item_id === "native-mcp-item")!;
      const observed = liveTool.data.portable as {native_reference: string; native_execution_reference: string; items: {type: string; tool_name?: string; arguments?: unknown; call_id?: string}[]};
      assert.equal(observed.native_reference, "native-thread");
      assert.equal(observed.native_execution_reference, "native-turn");
      assert.equal(observed.items[0]?.tool_name, "lookup");
      assert.deepEqual(observed.items[0]?.arguments, {storage: "inline", value: {query: "fixture"}});
      assert.equal(observed.items[1]?.call_id, "native-mcp-item");
      assert.equal(context.used_tokens, 50);
      assert.equal(context.capacity_tokens, 200000);
      assert.equal(context.measurement_scope, "last_request");
      assert.equal(events.find(event => event.event_type === "usage.updated")?.data.total_tokens, 1000);
      assert.equal(
        events.find((e) => e.event_type === "content.delta")?.data.delta,
        "🙂hello",
      );
      assert.equal(
        (events.at(-1)?.data.final_output as { final_text: string }).final_text
          .length,
        80000,
      );
    }
    verifyTranscript(events);
    const requests = (await readFile(record, "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            method: string;
            params: Record<string, unknown>;
          },
      );
    const configuration = requests.find((r) => r.method === "thread/start")
      ?.params.config as { plugins: Record<string, { enabled: boolean }>; mcp_servers: { inherited: { enabled: boolean; default_tools_approval_mode?: string }; selected?: { default_tools_approval_mode: string } } };
    assert.equal(configuration.mcp_servers.inherited.enabled, false);
    assert.deepEqual(configuration.plugins, { "plugin@vendor": { enabled: false } });
    assert.equal(configuration.mcp_servers.inherited.default_tools_approval_mode, undefined);
    if (mode === "success") {
      assert.equal(configuration.mcp_servers.selected, undefined);
      assert.deepEqual(toolCalls, [["echo", {text: "hello"}]]);
      assert.equal(JSON.stringify(requests).includes("never-forward-this-token"), false);
      const definitions = requests.find(r => r.method === "thread/start")!.params.dynamicTools as Array<{type: string; tools: Array<{name: string}>}>;
      assert.equal(definitions[0]!.type, "namespace");
      assert.equal(definitions[0]!.tools[0]!.name, "echo");
    }
    if (mode !== "policy" && mode !== "mcp-leak")
      assert.equal(
        requests.find((r) => r.method === "turn/start")?.params.effort,
        "high",
      );
    else
      assert.equal(
        requests.some((r) => r.method === "turn/start"),
        false,
      );
  });
}

it("Codex feedback borrows the owned transport and maps only explicit report fields", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "hcp-feedback-codex-"));
  const executable = join(cwd, "codex.cjs"), record = join(cwd, "requests.jsonl");
  await writeFile(executable, fixture); await chmod(executable, 0o755);
  const selected = provider("codex", executable);
  selected.env = {MODE: "retained", VERSION: "codex-cli 0.160.0", RECORD: record};
  const payload = {...start("codex", cwd), execution_profile: "interactive" as const};
  const adapter = new CodexHarnessAdapter();
  await adapter.startSession({payload, provider: selected, emitSessionEvent:()=>{}, registerSessionInteractions:()=>{}});
  const input = {sessionId: payload.session_id, nativeThreadId: "native-thread", provider: selected, startPayload: payload,
    request: {kind: "feedback" as const, classification: "bug", include_diagnostics: false, reason: "Fixture report"}, signal: new AbortController().signal};
  try {
    assert.deepEqual(await adapter.submitNativeFeedback(input), {feedback_id: "feedback-receipt"});
    await assert.rejects(adapter.submitNativeFeedback({...input, nativeThreadId: "foreign-thread"}));
    await assert.rejects(adapter.submitNativeFeedback({...input, request: {...input.request, classification: "quality"}}));
    const requests = (await readFile(record, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(requests.filter(request => request.method === "feedback/upload").map(request => request.params),
      [{classification: "bug", includeLogs: false, threadId: "native-thread", reason: "Fixture report"}]);
    assert.equal(requests.some(request => request.method === "turn/start"), false);
    assert.equal(new Set(requests.map(request => request.nativePid)).size, 1);
  } finally {await adapter.stopSession({sessionId: payload.session_id}); await rm(cwd, {recursive: true, force: true});}
});

it("Codex interactive roots reuse one native transport and interrupt only their admitted turn", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "hcp-retained-codex-"));
  const executable = join(cwd, "codex.cjs"), record = join(cwd, "requests.jsonl");
  await writeFile(executable, fixture); await chmod(executable, 0o755);
  const selected = provider("codex", executable);
  selected.env = {MODE: "retained", VERSION: "codex-cli 0.160.0", RECORD: record};
  const payload = {...start("codex", cwd), execution_profile: "interactive" as const};
  const adapter = new CodexHarnessAdapter();
  const session = await adapter.startSession({payload, provider: selected, emitSessionEvent:()=>{}, registerSessionInteractions:()=>{}});
  try {
    assert.equal(session.native_thread_id, "native-thread");
    const startup = (await readFile(record, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(startup.filter(request => request.method === "thread/start").length, 1);
    assert.equal(startup.filter(request => request.method === "turn/start").length, 0);
    for (const id of ["first", "second"]) {
      const events = await adapter.sendTurn({...turn(payload, selected), session, payload: {session_id: payload.session_id, turn_id: id, input: "hello"}});
      assert.equal(events.at(-1)?.event_type, "turn.completed", JSON.stringify(events.at(-1)?.data));
    }
    const cancelled = adapter.sendTurn({...turn(payload, selected), session, payload: {session_id: payload.session_id, turn_id: "cancelled", input: "wait"}});
    for (let count = 0; count < 100; count++) {
      const requests = (await readFile(record, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      if (requests.filter(request => request.method === "turn/start").length === 3) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await adapter.cancelTurn({sessionId: payload.session_id, turnId: "cancelled"});
    assert.equal((await cancelled).at(-1)?.event_type, "turn.cancelled");
    const followup = await adapter.sendTurn({...turn(payload, selected), session, payload: {session_id: payload.session_id, turn_id: "followup", input: "hello"}});
    assert.equal(followup.at(-1)?.event_type, "turn.completed");
    const requests = (await readFile(record, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(new Set(requests.map(request => request.nativePid)).size, 1);
    assert.equal(requests.filter(request => request.method === "initialize").length, 1);
    assert.equal(requests.filter(request => request.method === "thread/start").length, 1);
    assert.equal(requests.some(request => request.method === "thread/resume"), false);
    assert.equal(requests.find(request => request.method === "turn/interrupt")?.params.turnId, "native-turn-3");
    assert.equal(requests.find(request => request.method === "thread/start")?.params.approvalsReviewer, "user");
  } finally {await adapter.stopSession({sessionId: payload.session_id}); await rm(cwd, {recursive: true, force: true});}
});

for (const mode of ["reviewer", "exit"]) {
  it(`Codex persistent owner fences ${mode} failure without recreating its native process`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hcp-retained-fence-"));
    const executable = join(cwd, "codex.cjs"), record = join(cwd, "requests.jsonl");
    await writeFile(executable, fixture); await chmod(executable, 0o755);
    const selected = provider("codex", executable);
    selected.env = {MODE: mode, VERSION: "codex-cli 0.160.0", RECORD: record};
    const payload = {...start("codex", cwd), execution_profile: "interactive" as const};
    const adapter = new CodexHarnessAdapter();
    try {
      if (mode === "reviewer") {
        await assert.rejects(adapter.startSession({payload, provider: selected, emitSessionEvent:()=>{}, registerSessionInteractions:()=>{}}), /execution policy/);
        const requests = (await readFile(record, "utf8")).trim().split("\n").map(line => JSON.parse(line));
        assert.equal(requests.filter(request => request.method === "turn/start").length, 0);
        return;
      }
      const session = await adapter.startSession({payload, provider: selected, emitSessionEvent:()=>{}, registerSessionInteractions:()=>{}});
      for (const id of ["first", "after-failure"]) {
        const events = await adapter.sendTurn({...turn(payload, selected), session,
          payload: {session_id: payload.session_id, turn_id: id, input: "hello"}});
        assert.equal(events.at(-1)?.event_type, "turn.failed");
      }
      const requests = (await readFile(record, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      assert.equal(new Set(requests.map(request => request.nativePid)).size, 1);
      assert.equal(requests.filter(request => request.method === "thread/start").length, 1);
      assert.equal(requests.filter(request => request.method === "turn/start").length, mode === "reviewer" ? 0 : 1);
    } finally {
      if (mode === "exit") await assert.rejects(adapter.stopSession({sessionId: payload.session_id}), /owner was lost/);
      else await adapter.stopSession({sessionId: payload.session_id});
      await rm(cwd, {recursive: true, force: true});
    }
  });
}

it("Codex persistent profile rejects unverified native versions before launching an app-server", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "hcp-retained-version-"));
  const executable = join(cwd, "codex.cjs"), record = join(cwd, "requests.jsonl");
  await writeFile(executable, fixture); await chmod(executable, 0o755);
  const selected = provider("codex", executable);
  selected.env = {VERSION: "codex-cli 0.159.0", RECORD: record};
  const adapter = new CodexHarnessAdapter();
  try {
    for (const version of ["codex-cli 0.159.0", "codex-cli 0.160.2", "codex-cli 0.161.1", "codex-cli 0.161.0-beta.1"]) {
      selected.env = {VERSION: version, RECORD: record};
      await assert.rejects(adapter.startSession({payload: {...start("codex", cwd), execution_profile: "interactive"}, provider: selected}),
        (error: unknown) => error instanceof HarnessAdapterError && error.code === "native_profile_unsupported");
    }
    await assert.rejects(readFile(record), {code: "ENOENT"});
  } finally {await adapter.stopSession({sessionId: "session"}); await rm(cwd, {recursive: true, force: true});}
});

function fakeQuery(
  messages: unknown[],
  inspect: (options: Options) => void = () => {},
  initialization: Record<string, unknown> = {},
): ClaudeQueryFactory {
  return ({ options }) => {
    inspect(options!);
    const stream = (async function* () {
      yield {type: "system", subtype: "init", session_id: options!.resume ?? options!.sessionId, cwd: options!.cwd, permissionMode: options!.permissionMode,
        mcp_servers: Object.keys(options!.mcpServers ?? {}).map(name => ({name, status: "connected"})), plugins: [],
        apiKeySource: "none", claude_code_version: "fixture", tools: [], model: options!.model!, slash_commands: [], output_style: "default", skills: [],
        uuid: "00000000-0000-0000-0000-000000000000", ...initialization} as SDKMessage;
      for (const message of messages) yield message as SDKMessage;
    })();
    return Object.assign(stream, { close() {} }) as Query;
  };
}
const success = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "x".repeat(80000),
  terminal_reason: "completed",
  stop_reason: "end_turn",
};
it("Claude root context uses latest request counters and excludes subagent and accumulated billing", async () => {
  const assistant = (tokens: number, parent: string | null = null) => ({type: "assistant", parent_tool_use_id: parent,
    message: {content: [], usage: {input_tokens: tokens, output_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 30}}});
  const adapter = new ClaudeHarnessAdapter({queryFactory: fakeQuery([assistant(400), assistant(100), assistant(9000, "agent-tool"),
    {...success, modelUsage: {model: {inputTokens: 500, outputTokens: 100, cacheReadInputTokens: 200, cacheCreationInputTokens: 300}}}])});
  const events: HarnessAdapterEvent[] = [];
  events.push(...await adapter.sendTurn(turn(start("claude", tmpdir()), provider("claude"), event => events.push(event))));
  const context = events.filter(event => event.event_type === "context.updated").at(-1)!.data;
  assert.equal(context.used_tokens, 160);
  assert.equal(context.capacity_tokens, undefined);
  assert.equal(context.status, "measured");
  assert.equal(events.at(-1)?.event_type, "turn.completed");
  const output = events.at(-1)!.data.final_output as {context: unknown; usage: {total_tokens: number}};
  assert.deepEqual(output.context, context);
  assert.equal(output.usage.total_tokens, 1100);
  verifyTranscript(events);
});
it("Claude synthetic native command output supplies no model or context measurement", async () => {
  const adapter = new ClaudeHarnessAdapter({queryFactory: fakeQuery([{type: "assistant", parent_tool_use_id: null,
    message: {model: "<synthetic>", content: [{type: "text", text: "Goal set: command result"}], usage: {input_tokens: 0, output_tokens: 0}}},
    {...success, modelUsage: {"<synthetic>": {inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, contextWindow: 1000}}}])});
  const events: HarnessAdapterEvent[] = [];
  events.push(...await adapter.sendTurn(turn(start("claude", tmpdir()), provider("claude"), event => events.push(event))));
  assert.ok(events.filter(event => event.event_type === "context.updated").every(event => event.data.status === "unavailable"));
  const output = events.at(-1)!.data.final_output as {context: {status: string; capacity_tokens?: number}};
  assert.equal(output.context.status, "unavailable"); assert.equal(output.context.capacity_tokens, undefined);
});
it("isolated Claude streams preserve native block locations and exclude child text", async () => {
  const frame = (event: Record<string, unknown>, parent: string | null = null) => ({type: "stream_event", parent_tool_use_id: parent, event});
  const adapter = new ClaudeHarnessAdapter({queryFactory: fakeQuery([
    frame({type: "message_start", message: {id: "physical-message"}}),
    frame({type: "content_block_start", index: 0, content_block: {type: "thinking", thinking: "Initial thought"}}),
    frame({type: "content_block_delta", index: 0, delta: {type: "thinking_delta", thinking: " continued"}}),
    frame({type: "content_block_start", index: 1, content_block: {type: "text", text: "Answer"}}),
    frame({type: "content_block_delta", index: 0, delta: {type: "text_delta", text: "Foreign child"}}, "child"), success,
  ])});
  const events: HarnessAdapterEvent[] = [];
  events.push(...await adapter.sendTurn(turn(start("claude", tmpdir()), provider("claude"), event => events.push(event))));
  assert.equal(events.at(-1)?.event_type, "turn.completed");
  const deltas = events.filter(event => ["content.delta", "reasoning.delta"].includes(event.event_type));
  assert.deepEqual(deltas.map(event => event.data.delta), ["Initial thought", " continued", "Answer"]);
  assert.deepEqual(deltas.map(event => (event.data.native_part as {index: number}).index), [0, 0, 1]);
});

for (const [kind, initialization] of Object.entries({workspace: {cwd: process.cwd()}, mode: {permissionMode: "default"},
  mcp: {mcp_servers: [{name: "unselected", status: "connected"}]}, plugins: {plugins: [{name: "unselected", path: "/plugin"}]}})) {
  it(`Claude rejects ${kind} initialization mismatch before publishing a retained binding`, async () => {
    const adapter = new ClaudeHarnessAdapter({queryFactory: fakeQuery([success], undefined, initialization)});
    let retained = false;
    const events: HarnessAdapterEvent[] = [];
    const input = {...turn(start("claude", tmpdir()), provider("claude"), event => events.push(event)), persistNativeThread() {retained = true;}};
    events.push(...await adapter.sendTurn(input));
    assert.equal(retained, false);
    assert.equal(events.at(-1)?.event_type, "turn.failed");
    assert.equal(events.some(event => event.event_type === "session.configured"), false);
  });
}
for (const [label, result] of Object.entries({
  success,
  overloaded: { ...success, api_error_status: 529 },
  budget: { ...success, terminal_reason: "budget_exhausted" },
  missingText: { ...success, result: undefined },
  failure: { ...success, subtype: "error_during_execution" },
  tokenLimit: { ...success, stop_reason: "max_tokens" },
})) {
  it(`Claude SDK ${label} is classified truthfully`, async () => {
    const delta = {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "partial" },
      },
    };
    const adapter = new ClaudeHarnessAdapter({
      queryFactory: fakeQuery([delta, result], (options) => {
        assert.equal(options.strictMcpConfig, true);
        assert.deepEqual(options.mcpServers, {});
        assert.deepEqual(options.settingSources, []);
        assert.equal(options.includePartialMessages, true);
        assert.equal(options.effort, "high");
        assert.equal(options.persistSession, true);
      }),
    });
    const payload = start("claude", tmpdir());
    payload.model_selection.options = [{ id: "effort", value: "high" }];
    const events: HarnessAdapterEvent[] = [];
    events.push(
      ...(await adapter.sendTurn(
        turn(payload, provider("claude"), (event) => events.push(event)),
      )),
    );
    assert.equal(events.find(event => event.event_type === "content.delta")?.data.delta, "partial");
    assert.equal(events[0]?.event_type, "context.updated");
    assert.equal(
      events.at(-1)?.event_type,
      label === "success" ? "turn.completed" : "turn.failed",
    );
    verifyTranscript(events);
  });
}

it("Claude EOF without result is a failure", async () => {
  const adapter = new ClaudeHarnessAdapter({ queryFactory: fakeQuery([]) });
  const events = await adapter.sendTurn(
    turn(start("claude", tmpdir()), provider("claude")),
  );
  assert.equal(events.at(-1)?.event_type, "turn.failed");
  verifyTranscript(events);
});

for (const driver of ["codex", "claude"]) {
  it(`${driver} rejects unsupported policy, continuation and options before provider execution`, async () => {
    const adapter =
      driver === "codex"
        ? new CodexHarnessAdapter()
        : new ClaudeHarnessAdapter();
    for (const changes of [
      { continue_session: true },
      {
        model_selection: {
          model: "test",
          options: [{ id: "unknown", value: true }],
        },
      },
    ]) {
      await assert.rejects(
        adapter.startSession({
          payload: { ...start(driver, tmpdir()), ...changes },
          provider: provider(driver),
        }),
        HarnessAdapterError,
      );
    }
    await assert.rejects(
      adapter.startSession({
        payload: start(driver, tmpdir()),
        provider: { ...provider(driver), launch_args: ["--unsafe"] },
      }),
      HarnessAdapterError,
    );
    if (driver === "claude")
      await assert.rejects(
        adapter.startSession({
          payload: {
            ...start(driver, tmpdir()),
            sandbox_mode: "workspace_write",
          },
          provider: provider(driver),
        }),
        HarnessAdapterError,
      );
  });
}

it("cancellation emits one terminal only after Codex child closes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hcp-cancel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, "codex.cjs");
  await writeFile(executable, fixture);
  await chmod(executable, 0o755);
  const selected = provider("codex", executable);
  selected.env = { MODE: "sleep", RECORD: join(root, "requests") };
  const adapter = new CodexHarnessAdapter();
  const events: HarnessAdapterEvent[] = [];
  let ready!: () => void;
  const streamed = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const pending = adapter.sendTurn(
    turn(start("codex", root), selected, (event) => {
      events.push(event);
      ready();
    }),
  );
  await streamed;
  assert.deepEqual(
    await adapter.cancelTurn({ sessionId: "session", turnId: "turn" }),
    [],
  );
  events.push(...(await pending));
  assert.equal(events.at(-1)?.event_type, "turn.cancelled");
  verifyTranscript(events);
  assert.deepEqual(await adapter.stopSession({ sessionId: "session" }), []);
});

it("immediate cancellation prevents Claude startup and publishes its terminal before cancel resolves", async () => {
  let spawned = false;
  const adapter = new ClaudeHarnessAdapter({
    queryFactory: fakeQuery([], () => {
      spawned = true;
    }),
  });
  const events: HarnessAdapterEvent[] = [];
  const pending = adapter.sendTurn(
    turn(start("claude", tmpdir()), provider("claude"), (event) =>
      events.push(event),
    ),
  );
  await adapter.cancelTurn({ sessionId: "session", turnId: "turn" });
  assert.equal(spawned, false);
  assert.equal(events.at(-1)?.event_type, "turn.cancelled");
  assert.deepEqual(await pending, []);
  verifyTranscript(events);
});

it("Claude cancellation waits for a real child that ignores SIGTERM", async () => {
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let pid: number | undefined;
  const factory: ClaudeQueryFactory = ({ options }) => {
    const child = options!.spawnClaudeCodeProcess!({
      command: process.execPath,
      args: [
        "-e",
        "process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)",
      ],
      cwd: tmpdir(),
      env: process.env as Record<string, string>,
      signal: new AbortController().signal,
    });
    pid = (child as import("node:child_process").ChildProcess).pid;
    child.stdout.once("data", ready);
    const closed = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
    const stream = (async function* () {
      await closed;
    })() as AsyncGenerator<SDKMessage>;
    return Object.assign(stream, { close() {} }) as Query;
  };
  const adapter = new ClaudeHarnessAdapter({ queryFactory: factory });
  const events: HarnessAdapterEvent[] = [];
  const pending = adapter.sendTurn(
    turn(start("claude", tmpdir()), provider("claude"), (event) =>
      events.push(event),
    ),
  );
  await started;
  await adapter.stopSession({ sessionId: "session" });
  await pending;
  assert.throws(() => process.kill(pid!, 0), { code: "ESRCH" });
  assert.equal(events.at(-1)?.event_type, "turn.cancelled");
  verifyTranscript(events);
});

it("native probes advertise the same execution policies enforced at session start", async () => {
  for (const driver of ["codex", "claude"] as const) {
    const processSpawner: import("./adapters.js").CliProcessSpawner = (
      _executable,
      args,
    ) => ({
      result: Promise.resolve({
        exitCode: 0,
        signal: null,
        stdout: args.includes("status")
          ? '{"loggedIn":true}'
          : "fixture-version",
        stderr: "",
        error: undefined,
        timedOut: false,
      }),
      kill() {},
    });
    const adapter =
      driver === "codex"
        ? new CodexHarnessAdapter({ processSpawner })
        : new ClaudeHarnessAdapter({ processSpawner });
    const selected = provider(driver);
    selected.models = [
      { id: "test", label: "Test", capabilities: { option_descriptors: [] } },
    ];
    const status = await adapter.probe(selected);
    assert.equal(status.available, true);
    assert.deepEqual(status.execution_capabilities?.approval_policies, ["ask", "auto_edits", "full_access"]);
    assert.deepEqual(
      status.execution_capabilities?.sandbox_modes,
      driver === "codex"
        ? ["read_only", "workspace_write", "danger_full_access"]
        : ["danger_full_access"],
    );
    assert.equal(status.execution_capabilities?.session_continuation, true);
  }
});

it("a second Claude turn resumes the confirmed native conversation", async () => {
  let calls = 0;
  const selections: Options[] = [];
  const adapter = new ClaudeHarnessAdapter({
    queryFactory: fakeQuery([success], options => {
      selections.push(options);
      calls++;
    }),
  });
  const input = turn(start("claude", tmpdir()), provider("claude"));
  await adapter.sendTurn(input);
  const second = await adapter.sendTurn({
      ...input,
      payload: { ...input.payload, turn_id: "second" },
    });
  assert.equal(second.at(-1)?.event_type, "turn.completed");
  assert.equal(calls, 2);
  assert.equal(selections[1]?.resume, selections[0]?.sessionId);
  assert.equal(selections[1]?.sessionId, undefined);
  await adapter.stopSession({ sessionId: "session" });
});

it("Codex native RPC receives complete owned image bytes beyond the inline HCP limit", async () => {
  const {createHash} = await import("node:crypto"), {harnessImageFileReferenceSchema} = await import("@harness-control/protocol");
  const cwd = await mkdtemp(join(tmpdir(), "hcp-owned-codex-image-")), executable = join(cwd, "codex.cjs"), record = join(cwd, "requests.jsonl");
  await writeFile(executable, fixture);await chmod(executable, 0o755);
  const selected = provider("codex", executable);selected.env = {MODE: "retained", VERSION: "codex-cli 0.160.1", RECORD: record};
  const payload = {...start("codex", cwd), execution_profile: "interactive" as const}, adapter = new CodexHarnessAdapter();
  const bytes = Buffer.alloc(600_000, 7), reference = harnessImageFileReferenceSchema.parse({file_id: "a".repeat(64), sha256: createHash("sha256").update(bytes).digest("hex"),
    filename: "fixture.png", mime_type: "image/png", byte_length: bytes.byteLength});
  try {
    const session = await adapter.startSession({payload, provider: selected, emitSessionEvent: () => {}, registerSessionInteractions: () => {}});
    const events = await adapter.sendTurn({...turn(payload, selected), session, payload: {session_id: "session", turn_id: "image", input: "fixture", image_files: [reference]},
      inputFileImages: [{reference, data_base64: bytes.toString("base64")}]});assert.equal(events.at(-1)?.event_type, "turn.completed");
    const requests = (await readFile(record, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(requests.find(request => request.method === "turn/start").params.input[1], {type: "image", url: `data:image/png;base64,${bytes.toString("base64")}`});
  } finally {await adapter.stopSession({sessionId: "session"});await rm(cwd, {recursive: true, force: true});}
});
it("isolated Claude SDK user input receives exact owned image bytes without text-only substitution", async () => {
  const {createHash} = await import("node:crypto"), {harnessImageFileReferenceSchema} = await import("@harness-control/protocol");
  const bytes = Buffer.alloc(600_000, 7), reference = harnessImageFileReferenceSchema.parse({file_id: "a".repeat(64), sha256: createHash("sha256").update(bytes).digest("hex"),
    filename: "fixture.png", mime_type: "image/png", byte_length: bytes.byteLength});
  let observed: unknown;
  const factory: ClaudeQueryFactory = ({prompt, options}) => {
    const stream = (async function* () {
      const message = await (prompt as AsyncIterable<import("@anthropic-ai/claude-agent-sdk").SDKUserMessage>)[Symbol.asyncIterator]().next();observed = message.value?.message.content;
      yield {type: "system", subtype: "init", session_id: options!.sessionId, cwd: options!.cwd, permissionMode: options!.permissionMode,
        mcp_servers: [], plugins: [], tools: [], model: options!.model, apiKeySource: "none", claude_code_version: "fixture",
        slash_commands: [], output_style: "default", skills: [], uuid: "00000000-0000-0000-0000-000000000000"} as SDKMessage;
      yield success as SDKMessage;
    })();return Object.assign(stream, {close() {}}) as Query;
  };
  const adapter = new ClaudeHarnessAdapter({queryFactory: factory});
  const payload = start("claude", tmpdir()), selected = provider("claude");
  try {
    const events = await adapter.sendTurn({...turn(payload, selected), payload: {session_id: "session", turn_id: "image", input: "fixture", image_files: [reference]},
      inputFileImages: [{reference, data_base64: bytes.toString("base64")}]});assert.equal(events.at(-1)?.event_type, "turn.completed");
    assert.deepEqual(observed, [{type: "text", text: "fixture"}, {type: "image", source: {type: "base64", media_type: "image/png", data: bytes.toString("base64")}}]);
  } finally {await adapter.close();}
});

it("Codex 0.161.0 retains one acknowledged native conversation and transport without a model startup", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "hcp-codex-161-fixture-")), executable = join(cwd, "codex.cjs"), record = join(cwd, "requests.jsonl");
  await writeFile(executable, fixture);await chmod(executable, 0o755);
  const selected = provider("codex", executable);selected.env = {MODE: "retained", VERSION: "codex-cli 0.161.0", RECORD: record};
  const payload = {...start("codex", cwd), execution_profile: "interactive" as const}, adapter = new CodexHarnessAdapter();
  try {
    const session = await adapter.startSession({payload, provider: selected, emitSessionEvent: () => {}, registerSessionInteractions: () => {}});assert.equal(session.native_thread_id, "native-thread");
    const startup = (await readFile(record, "utf8")).trim().split("\n").map(line => JSON.parse(line));assert.equal(startup.filter(request => request.method === "turn/start").length, 0);
    for (const turn_id of ["first", "second"]) assert.equal((await adapter.sendTurn({...turn(payload, selected), session, payload: {session_id: payload.session_id, turn_id, input: "fixture"}})).at(-1)?.event_type, "turn.completed");
    const requests = (await readFile(record, "utf8")).trim().split("\n").map(line => JSON.parse(line));assert.equal(new Set(requests.map(request => request.nativePid)).size, 1);assert.equal(requests.filter(request => request.method === "thread/start").length, 1);
  } finally {await adapter.stopSession({sessionId: payload.session_id});await rm(cwd, {recursive: true, force: true});}
});
