import assert from "node:assert/strict";
import {mkdtemp, writeFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {test} from "node:test";
import type {HarnessAdapterEvent, HarnessAdapterStartInput, HarnessAdapterTurnInput, HarnessNativeInteractions} from "../types.js";
import {CodexRpc} from "./codex-rpc.js";
import {CodexOwnedWork} from "./codex-work.js";
import {CodexWorkCallbacks} from "./codex-work-callbacks.js";

async function fixture(mode = "normal") {
  const cwd = await mkdtemp(join(tmpdir(), "hcp-codex-child-"));
  const executable = join(cwd, "native.mjs");
  await writeFile(executable, `#!/usr/bin/env node
import {createInterface} from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
const notify = (method,params) => send({method,params});
let status='inProgress', interrupts=0, subscriptions=[];
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='launch') {
  notify('thread/status/changed',{threadId:'child',status:{type:'active',activeFlags:[]}});
  notify('item/started',{threadId:'root',turnId:'root-turn',item:{id:'launch',type:'subAgentActivity',agentThreadId:'child',agentPath:'/root/child',kind:'started'}});
  notify('turn/started',{threadId:'child',turn:{id:'child-turn',status:'inProgress'}});
  notify('turn/completed',{threadId:'root',turn:{id:'root-turn',status:'completed',error:null}});
  send({id:m.id,result:{turn:{id:'root-turn'}}});
 } else if(m.method==='thread/read') {
  if(process.env.MODE==='metadata-only'&&m.params.includeTurns)send({id:m.id,error:{code:-32601,message:'includeTurns is not supported yet'}});
  else send({id:m.id,result:{thread:{id:'child',cwd:process.cwd(),parentThreadId:'root',source:{subAgent:{thread_spawn:{parent_thread_id:process.env.MODE==='wrong-parent'?'foreign':'root'}}},turns:m.params.includeTurns?[{id:'child-turn',status}]:[]}}});
 }
 else if(m.method==='complete') {status='completed';notify('turn/completed',{threadId:'child',turn:{id:'child-turn',status,error:null}});send({id:m.id,result:{}});}
 else if(m.method==='turn/interrupt') {interrupts++;send({id:m.id,result:{}});if(process.env.MODE!=='ack-only'){status='interrupted';notify('turn/completed',{threadId:m.params.threadId,turn:{id:m.params.turnId,status,error:null}});}}
 else if(m.method==='thread/unsubscribe'){subscriptions.push(m.params.threadId);send({id:m.id,result:{status:'unsubscribed'}});}
 else if(m.method==='unknown-child'){notify('turn/started',{threadId:'unowned',turn:{id:'unowned-turn'}});send({id:m.id,result:{}});}
 else if(m.method==='unknown-root'){notify('turn/started',{threadId:'root',turn:{id:'autonomous-turn'}});send({id:m.id,result:{}});}
 else if(m.method==='stats')send({id:m.id,result:{interrupts,subscriptions}});
 else if(m.method==='ask-child') {send({id:'child-question',method:'item/tool/requestUserInput',params:{threadId:'child',turnId:'child-turn',itemId:'question-item',questions:[{id:'q',header:'Choice',question:'Choose a value',options:[{label:'Alpha',description:'First'},{label:'Beta',description:'Second'}]}]}});send({id:m.id,result:{}});}
 else if(m.method==='ask-root') {send({id:'root-question',method:'item/tool/requestUserInput',params:{threadId:'root',turnId:'second-root',itemId:'root-item',questions:[]}});send({id:m.id,result:{}});}
 else if(m.method==='progress') {notify('thread/status/changed',{threadId:'child',status:{type:'active',activeFlags:['waitingOnApproval']}});notify('item/started',{threadId:'child',turnId:'child-turn',item:{id:'command',type:'commandExecution'}});send({id:m.id,result:{}});}
 else if(m.method==='idle') {notify('thread/status/changed',{threadId:'child',status:{type:'idle'}});send({id:m.id,result:{}});}
 else if(m.method==='unowned-usage') {notify('thread/tokenUsage/updated',{threadId:'root',turnId:'old-turn',tokenUsage:{}});send({id:m.id,result:{}});}
 else if(m.id==='child-question'||m.id==='root-question')notify('fixture/reply',{requestId:m.id,result:m.result});
});
`, {mode:0o700});
  const rpc = new CodexRpc(executable, cwd, {...process.env, MODE:mode});
  const events: HarnessAdapterEvent[] = [];
  let sessionInteractions: HarnessNativeInteractions | undefined;
  const input: HarnessAdapterStartInput = {payload:{session_id:"session",workspace_id:"workspace",provider_instance_id:"codex",driver_kind:"codex",cwd,
    sandbox_mode:"workspace_write",approval_policy:"full_access",continue_session:false,execution_profile:"interactive",model_selection:{model:"fixture"},mcp_servers:[]},
    provider:{id:"codex",driver_kind:"codex",enabled:true,launch_args:[],env:{},models:[],hidden_models:[],model_order:[],favorite_models:[],local_capabilities:[]},
    emitSessionEvent:event=>{events.push(event);}, registerSessionInteractions:value=>{sessionInteractions=value;}};
  const owner = new CodexOwnedWork(rpc,input); owner.attachRootThread("root");
  const launch = async () => {await rpc.request("launch",{}); owner.admitRoot("root","root-turn","app-root"); await owner.settled();};
  const work = () => [...events].reverse().find(event=>event.event_type==="native.work.updated")!.data.work as import("@harness-control/protocol").HarnessNativeWorkObservation;
  return {rpc,owner,events,input,launch,work,get sessionInteractions(){return sessionInteractions;},close:async()=>{await rpc.process.stop();await rm(cwd,{recursive:true,force:true});}};
}

function rootInput(start: HarnessAdapterStartInput): HarnessAdapterTurnInput {
  return {startPayload:start.payload, provider:start.provider, session:{adapter_session_id:"native"},
    payload:{session_id:"session",turn_id:"app-root",input:"spawn"},
    reviewNativeWorkMcp:()=>({async request(){assert.fail("no MCP call expected");},async complete(){}})};
}
async function requested(events: HarnessAdapterEvent[]): Promise<HarnessAdapterEvent> {
  const deadline=Date.now()+2000;
  while(Date.now()<deadline) {
    const event=[...events].reverse().find(event=>event.event_type==="user_input.requested");
    if(event)return event;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  throw new Error("No child input arrived");
}

test("Codex child launch confirms ancestry without requiring materialized turns", async () => {
  const f = await fixture("metadata-only");
  try {
    await f.rpc.request("launch", {}); f.owner.admitRoot("root", "root-turn", "app-root"); await f.owner.settled();
    assert.equal(f.work().status, "running");
    await f.rpc.request("complete", {}); await f.owner.settled();
    assert.equal(f.work().status, "completed");
    await f.owner.stop();
  } finally {await f.close();}
});

test("persistent Codex callback routing separates an old child from a newer root handler", {timeout:5000}, async()=>{
  const f=await fixture();
  try {
    const callbacks=new CodexWorkCallbacks(f.rpc,f.owner,f.input);
    await f.rpc.request("launch",{}); callbacks.admit(rootInput(f.input),"root","root-turn"); await f.owner.settled();
    let rootCalls=0;
    f.rpc.setRequestHandler("item/tool/requestUserInput",async params=>{rootCalls++;assert.equal((params as {turnId:string}).turnId,"second-root");return {root:true};});
    const reply=new Promise<unknown>(resolve=>{f.rpc.onNotification=message=>{if(message.method==="fixture/reply"&&(message.params as {requestId:string}).requestId==="child-question")resolve((message.params as {result:unknown}).result);};});
    await f.rpc.request("ask-child",{});
    const event=await requested(f.events);
    assert.equal(event.turn_id,"app-root");assert.equal(event.data.native_work_id,f.work().work_id);
    const requestId=event.data.request_id as string;
    assert.throws(()=>f.sessionInteractions!.respondInput({session_id:"session",turn_id:"new-root",request_id:requestId,actor_id:"user",value:{answers:{q:{answers:["Alpha"]}}}}),/another active session or turn/);
    f.sessionInteractions!.respondInput({session_id:"session",turn_id:"app-root",request_id:requestId,actor_id:"user",value:{answers:{q:{answers:["Alpha"]}}}});
    assert.deepEqual(await reply,{answers:{q:{answers:["Alpha"]}}});assert.equal(rootCalls,0);
    await f.rpc.request("ask-root",{}); await f.rpc.request("stats",{});assert.equal(rootCalls,1);
    await f.rpc.request("complete",{});await f.owner.settled();await f.owner.stop();callbacks.close();
  }finally{await f.close();}
});

test("child terminal callback loss preserves its origin and does not kill the newer root transport", {timeout:5000},async()=>{
  const f=await fixture();
  try {
    const callbacks=new CodexWorkCallbacks(f.rpc,f.owner,f.input);
    await f.rpc.request("launch",{});callbacks.admit(rootInput(f.input),"root","root-turn");await f.owner.settled();
    await f.rpc.request("ask-child",{});const request=await requested(f.events);
    await f.rpc.request("complete",{});await f.owner.settled();await f.rpc.request("stats",{});
    assert.ok(f.events.some(event=>event.event_type==="native.request.lost"&&event.turn_id==="app-root"&&event.data.native_work_id===f.work().work_id));
    assert.throws(()=>f.sessionInteractions!.respondInput({session_id:"session",turn_id:"app-root",request_id:request.data.request_id as string,actor_id:"user",value:{answers:{q:{answers:["Alpha"]}}}}),/unavailable/);
    await f.owner.stop();callbacks.close();assert.equal(f.sessionInteractions,undefined);
  }finally{await f.close();}
});

test("native Codex child ownership survives root completion and retains the admitted origin", {timeout:5000}, async () => {
  const f = await fixture();
  try {
    await f.launch();
    assert.equal(f.work().origin_turn_id,"app-root"); assert.equal(f.work().status,"running"); assert.equal(f.work().supports_cancel,true);
    assert.deepEqual(f.owner.childOrigin("child","child-turn"),{origin_turn_id:"app-root",work_id:f.work().work_id});
    assert.equal(f.owner.childOrigin("child","foreign-turn"),undefined);
    await f.rpc.request("complete",{}); await f.owner.settled();
    assert.equal(f.work().status,"completed"); assert.equal(f.owner.busy,false);
    await f.owner.stop();
    assert.deepEqual(await f.rpc.request("stats",{}),{interrupts:0,subscriptions:["child","root"]});
  } finally {await f.close();}
});

test("native child progress has its own work identity and idle never fabricates completion", {timeout:5000}, async()=>{
  const f=await fixture();
  try {
    await f.launch();const id=f.work().work_id;
    await f.rpc.request("progress",{});await f.owner.settled();
    assert.equal(f.work().work_id,id);assert.equal(f.work().origin_turn_id,"app-root");
    assert.equal(f.work().status,"waiting");assert.equal(f.work().summary,"Native commandExecution started");
    await f.rpc.request("idle",{});await f.owner.settled();assert.equal(f.work().status,"waiting");
    await f.rpc.request("complete",{});await f.owner.settled();
    await f.rpc.request("unowned-usage",{});await f.owner.settled();
    assert.equal(f.owner.busy,false);await f.owner.stop();
  }finally{await f.close();}
});

test("native Codex cancellation acknowledges its exact child turn and requires observed terminal proof", {timeout:5000}, async () => {
  const f = await fixture();
  try {
    await f.launch(); const work = {...f.work(),revision:1};
    await assert.rejects(f.owner.cancel({...work,native_reference:"foreign"},new AbortController().signal),/unavailable/);
    await f.owner.cancel(work,new AbortController().signal);
    // A later native frame is a barrier for the independently delivered terminal notification.
    await f.rpc.request("stats",{}); await f.owner.settled();
    assert.equal(f.work().status,"cancelled");
    await f.owner.stop();
    assert.deepEqual(await f.rpc.request("stats",{}),{interrupts:1,subscriptions:["child","root"]});
  } finally {await f.close();}
});

test("native Codex cancellation acknowledgement alone does not complete work", {timeout:5000}, async () => {
  const f = await fixture("ack-only");
  try {
    await f.launch(); await f.owner.cancel({...f.work(),revision:1},new AbortController().signal); await f.owner.settled();
    assert.equal(f.work().status,"running"); assert.equal(f.owner.busy,true);
    assert.deepEqual(await f.rpc.request("stats",{}),{interrupts:1,subscriptions:[]});
  } finally {await f.close();}
});
test("provider death with a known child after root completion explicitly preserves closure uncertainty",{timeout:5000},async()=>{
  const f=await fixture();
  try {
    await f.launch();await f.rpc.process.stop();
    await assert.rejects(f.owner.settled(),/owner was lost/);
    assert.equal(f.events.find(event=>event.event_type==="native.work.owner_lost")?.data.closure_unconfirmed,true);
    assert.equal(f.work().status,"running");await assert.rejects(f.owner.stop(),/owner was lost/);
  } finally {await f.close();}
});

test("native Codex parent mismatch loses the owner without publishing fabricated child work", {timeout:5000}, async () => {
  const f = await fixture("wrong-parent");
  try {
    await assert.rejects(f.launch(),/owner was lost/);
    assert.equal(f.events.some(event=>event.event_type==="native.work.updated"),false);
    assert.equal(f.events.some(event=>event.event_type==="native.work.owner_lost"),true);
    assert.equal(f.events.find(event=>event.event_type==="native.work.owner_lost")?.data.closure_unconfirmed,true);
  } finally {await f.close();}
});

test("native Codex autonomous root turns cannot silently inherit the application's prior origin", {timeout:5000}, async () => {
  const f = await fixture();
  try {
    await f.launch(); await f.rpc.request("complete",{}); await f.owner.settled();
    await f.rpc.request("unknown-root",{}); await f.owner.settled();
    await assert.rejects(f.owner.stop(),/Unconfirmed native child membership/);
    assert.equal(f.owner.childOrigin("root","autonomous-turn"),undefined);
    assert.deepEqual(await f.rpc.request("stats",{}),{interrupts:0,subscriptions:[]});
  } finally {await f.close();}
});

test("native Codex unload refuses unconfirmed membership after root completion", {timeout:5000}, async () => {
  const f = await fixture();
  try {
    await f.launch(); await f.rpc.request("complete",{}); await f.owner.settled();
    await f.rpc.request("unknown-child",{}); await f.owner.settled();
    await assert.rejects(f.owner.stop(),/Unconfirmed native child membership/);
    assert.deepEqual(await f.rpc.request("stats",{}),{interrupts:0,subscriptions:[]});
  } finally {await f.close();}
});
