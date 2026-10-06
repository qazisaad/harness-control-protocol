import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import type {Query, SDKMessage} from "@anthropic-ai/claude-agent-sdk";
import type {HcpSessionStartPayload} from "@harness-control/protocol";
import {ClaudeHarnessAdapter} from "./adapters/providers/claude.js";
import {OpenCodeHarnessAdapter} from "./adapters/providers/opencode.js";
import type {ClaudeQueryFactory} from "./adapters/providers/claude-runtime.js";
import type {ProviderInstanceConfig} from "../config/index.js";

function provider(driver: string): ProviderInstanceConfig {
  return {id:driver,driver_kind:driver,enabled:true,env:{},launch_args:[],models:[],hidden_models:[],model_order:[],favorite_models:[],local_capabilities:[]};
}
function payload(driver: string, cwd: string, id: string): HcpSessionStartPayload {
  return {session_id:id,workspace_id:"workspace",provider_instance_id:driver,driver_kind:driver,cwd,
    sandbox_mode:"danger_full_access",approval_policy:"full_access",continue_session:false,model_selection:{model:"test-model"},mcp_servers:[]};
}
function claudeFactory() {
  let created = 0, closed = 0;
  const factory: ClaudeQueryFactory = ({prompt}) => {
    created++;
    assert.notEqual(typeof prompt,"string");
    const history: string[] = [];
    const stream = (async function* () {
      for await (const input of prompt as AsyncIterable<{message:{content:unknown}}>) {
        history.push(String(input.message.content));
        yield {type:"result",subtype:"success",is_error:false,result:history.join("|"),stop_reason:"end_turn"} as SDKMessage;
      }
    })();
    return Object.assign(stream,{close(){closed++;void stream.return(undefined);}}) as Query;
  };
  return {factory, counts:()=>({created,closed})};
}

test("Claude SDK initialization failure cannot leave its spawned process alive", async () => {
  let pid: number | undefined;
  const factory: ClaudeQueryFactory = ({options}) => {
    const child = options!.spawnClaudeCodeProcess!({command:process.execPath,args:["-e","setInterval(()=>{},1000)"],
      cwd:tmpdir(),env:process.env as Record<string,string>,signal:new AbortController().signal});
    pid = (child as import("node:child_process").ChildProcess).pid;
    throw new Error("SDK initialization failed after spawn");
  };
  const adapter=new ClaudeHarnessAdapter({queryFactory:factory});
  try {
    const selected=provider("claude"),start=payload("claude",tmpdir(),"failed");
    const session=await adapter.startSession({payload:start,provider:selected});
    const result=await adapter.sendTurn({session,startPayload:start,provider:selected,payload:{session_id:"failed",turn_id:"one",input:"never execute"}});
    assert.equal(result.at(-1)?.event_type,"turn.failed");
    assert.throws(()=>process.kill(pid!,0),{code:"ESRCH"});
  } finally {await adapter.close();}
});

test("Claude reuses one live SDK query only within its original conversation", async () => {
  const f=claudeFactory(), adapter=new ClaudeHarnessAdapter({queryFactory:f.factory});
  const selected=provider("claude"), start=payload("claude",tmpdir(),"one");
  try {
    const session=await adapter.startSession({payload:start,provider:selected});
    for (const [index,text] of ["first","second"].entries()) {
      const result=await adapter.sendTurn({session,startPayload:start,provider:selected,payload:{session_id:"one",turn_id:`turn-${index}`,input:text}});
      assert.equal(result.at(-1)?.event_type,"turn.completed");
      assert.equal((result.at(-1)?.data.final_output as {final_text:string}).final_text,index===0?"first":"first|second");
    }
    assert.equal(f.counts().created,1);
    const other=payload("claude",tmpdir(),"two");
    const otherSession=await adapter.startSession({payload:other,provider:selected});
    const result=await adapter.sendTurn({session:otherSession,startPayload:other,provider:selected,payload:{session_id:"two",turn_id:"other",input:"fresh"}});
    assert.equal((result.at(-1)?.data.final_output as {final_text:string}).final_text,"fresh");
    assert.equal(f.counts().created,2);
    await adapter.stopSession({sessionId:"one"});
    const stopped=await adapter.sendTurn({session,startPayload:start,provider:selected,payload:{session_id:"one",turn_id:"late",input:"must not run"}});
    assert.equal(stopped.at(-1)?.event_type,"turn.failed");
    assert.equal(f.counts().created,2);
  } finally {await adapter.close();}
  assert.deepEqual(f.counts(),{created:2,closed:2});
});

for (const change of ["credentials", "model", "workspace", "instructions"]) test(`Claude rejects changed ${change} without restarting history`, async () => {
  const f=claudeFactory(), adapter=new ClaudeHarnessAdapter({queryFactory:f.factory});
  const selected=provider("claude"), start=payload("claude",tmpdir(),"one");
  try {
    const session=await adapter.startSession({payload:start,provider:selected});
    const input={session,startPayload:start,provider:selected,payload:{session_id:"one",turn_id:"first",input:"first"}};
    await adapter.sendTurn(input);
    const result=await adapter.sendTurn({...input,
      provider:change==="credentials"?{...selected,env:{ROTATED:"yes"}}:selected,
      startPayload:change==="workspace"?{...start,workspace_id:"other"}:change==="instructions"?{...start,instructions:"Changed"}:start,
      payload:{...input.payload,turn_id:"second",...(change==="model"?{model_selection:{model:"other-model"}}:{})}});
    assert.equal(result.at(-1)?.event_type,"turn.failed");
    assert.equal(f.counts().created,1);
  } finally {await adapter.close();}
});

for (const failDelete of [false,true]) test(`OpenCode keeps server separate from native sessions (delete failure=${failDelete})`, async () => {
  const root=await mkdtemp(join(tmpdir(),"hcp-reuse-"));
  const record=join(root,"server.jsonl");
  const adapter=new OpenCodeHarnessAdapter();
  const selected={...provider("opencode"),executable_path:process.execPath,
    launch_args:[fileURLToPath(new URL("../../test-fixtures/fake-opencode-server.mjs",import.meta.url))],
    env:{REUSE_RECORD:record,...(failDelete?{FAIL_DELETE:"yes"}:{})}};
  const ids: string[]=[];
  try {
    for (const id of ["one","two"]) {
      const start=payload("opencode",root,id);
      const session=await adapter.startSession({payload:start,provider:selected}); ids.push(session.adapter_session_id);
      const events=await adapter.sendTurn({session,startPayload:start,provider:selected,payload:{session_id:id,turn_id:id,input:id}});
      assert.equal(events.at(-1)?.event_type,"turn.completed");
      await adapter.stopSession({sessionId:id});
    }
    const log=(await readFile(record,"utf8")).trim().split("\n").map(line=>JSON.parse(line));
    assert.equal(log.filter(r=>r.kind==="server").length,failDelete?2:1);
    assert.equal(log.filter(r=>r.kind==="delete").length,2);
    if (!failDelete) assert.notEqual(ids[0],ids[1]);
    const changed={...payload("opencode",root,"three"),workspace_id:"other-workspace"};
    await adapter.startSession({payload:changed,provider:selected});
    await adapter.stopSession({sessionId:"three"});
    const updated=(await readFile(record,"utf8")).trim().split("\n").map(line=>JSON.parse(line));
    assert.equal(updated.filter(r=>r.kind==="server").length,failDelete?3:2);
  } finally {await adapter.close(); await rm(root,{recursive:true,force:true});}
});

test("OpenCode cancellation physically stops its leased server before reporting terminal", async () => {
  const root=await mkdtemp(join(tmpdir(),"hcp-cancel-")), record=join(root,"server.jsonl");
  const adapter=new OpenCodeHarnessAdapter();
  const selected={...provider("opencode"),executable_path:process.execPath,
    launch_args:[fileURLToPath(new URL("../../test-fixtures/fake-opencode-server.mjs",import.meta.url))],env:{REUSE_RECORD:record,HOLD_TURN:"yes"}};
  try {
    const start=payload("opencode",root,"one"),session=await adapter.startSession({payload:start,provider:selected});
    let ready!:()=>void;
    const started=new Promise<void>(resolve=>{ready=resolve;});
    const running=adapter.sendTurn({session,startPayload:start,provider:selected,payload:{session_id:"one",turn_id:"active",input:"hold"},emitEvent:()=>ready()});
    await started;
    const cancelled=await adapter.cancelTurn({sessionId:"one",turnId:"active"});
    assert.equal(cancelled[0]?.event_type,"turn.cancelled");
    assert.deepEqual(await running,[]);
    const log=(await readFile(record,"utf8")).trim().split("\n").map(line=>JSON.parse(line));
    assert.throws(()=>process.kill(log.find(r=>r.kind==="server").pid,0),{code:"ESRCH"});
  } finally {await adapter.close();await rm(root,{recursive:true,force:true});}
});

test("Claude passes native instructions separately from user input", async () => {
  const f = claudeFactory();
  let promptOptions: unknown;
  const adapter = new ClaudeHarnessAdapter({queryFactory: input => {
    promptOptions = input.options?.systemPrompt;
    return f.factory(input);
  }});
  const start = {...payload("claude", tmpdir(), "instructions"), instructions: "Review security"};
  const selected = provider("claude");
  try {
    const session = await adapter.startSession({payload: start, provider: selected});
    const result = await adapter.sendTurn({session, startPayload: start, provider: selected,
      payload: {session_id: start.session_id, turn_id: "one", input: "Check this code"}});
    assert.deepEqual(promptOptions, {type: "preset", preset: "claude_code", append: "Review security"});
    assert.equal((result.at(-1)?.data.final_output as {final_text:string}).final_text, "Check this code");
  } finally { await adapter.close(); }
});

test("OpenCode rejects instructions before starting a native runtime", async () => {
  const adapter = new OpenCodeHarnessAdapter();
  try {
    await assert.rejects(adapter.startSession({provider: provider("opencode"),
      payload: {...payload("opencode", tmpdir(), "instructions"), instructions: "Review security"}}),
      {code: "instructions_unsupported"});
  } finally { await adapter.close(); }
});
