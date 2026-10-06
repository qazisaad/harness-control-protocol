import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HcpSessionEventReducer, hcpHarnessEventPayloadSchema, type HcpHarnessEventPayload, type HcpSessionStartPayload } from "@harness-control/protocol";
import { HarnessSessionManager } from "./index.js";
import { RunnerConfigSchema } from "../config/index.js";
import { JsonRunnerStateStore } from "../state/index.js";

const providerFixture = String.raw`#!/usr/bin/env node
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const notify = (method, params) => send({method, params});
let turnId;
const binding = () => ({threadId:'thread', turnId, itemId:'command'});
const complete = text => {
 notify('item/completed', {...binding(), item:{id:'command',type:'commandExecution',command:'echo done',cwd:process.cwd(),status:'completed',aggregatedOutput:'done\n',exitCode:0,durationMs:5}});
 notify('item/completed', {...binding(), item:{id:'edit',type:'fileChange',status:'completed',changes:[{path:'example.txt',kind:{type:'add'},diff:'+done'}]}});
 notify('turn/plan/updated', {...binding(),plan:[{step:'Inspect',status:'completed'}],explanation:'Finished'});
 notify('turn/diff/updated', {...binding(),diff:'diff --git example.txt\n+done'});
 notify('item/completed', {...binding(), item:{id:'answer',type:'agentMessage',phase:'final_answer',text}});
 notify('turn/completed', {threadId:'thread',turn:{id:turnId,status:'completed',error:null}});
};
createInterface({input:process.stdin}).on('line', line => {
 const request = JSON.parse(line);
 appendFileSync(process.env.RECORD, JSON.stringify(request)+'\n');
 if(request.id==='approval') { complete(request.result.decision); return; }
 if(request.id==='question') { complete(request.result.answers.scope.answers[0]); return; }
 if(request.id==='permissions') { complete(JSON.stringify(request.result)); return; }
 if(!request.id) return;
 if(request.method==='initialize') send({id:request.id,result:{}});
 if(request.method==='config/read') send({id:request.id,result:{config:{}}});
 if(request.method==='mcpServerStatus/list') send({id:request.id,result:{data:[],nextCursor:null}});
 if(request.method==='thread/start' || request.method==='thread/resume') send({id:request.id,result:{thread:{id:'thread'},sandbox:{type:request.params.sandbox==='danger-full-access'?'dangerFullAccess':'workspaceWrite',writableRoots:[],excludeTmpdirEnvVar:true,excludeSlashTmp:true},approvalPolicy:request.params.approvalPolicy}});
 if(request.method==='turn/start') {
  turnId=request.params.input[0].text;
  notify('turn/started',{threadId:'thread',turn:{id:turnId}});
  send({id:request.id,result:{turn:{id:turnId}}});
  if(turnId==='question') send({id:'question',method:'item/tool/requestUserInput',params:{...binding(),questions:[{id:'scope',header:'Scope',question:'Choose scope',options:[{label:'Small',description:'One file'}]}]}});
  else if(turnId==='permissions') send({id:'permissions',method:'item/permissions/requestApproval',params:{...binding(),permissions:{network:{enabled:true}}}});
  else if(turnId==='approval' || turnId==='interrupt') send({id:'approval',method:'item/commandExecution/requestApproval',params:{...binding(),command:'echo done',cwd:process.cwd(),availableDecisions:['accept','decline','cancel']}});
  else if(turnId!=='steer') complete('remembered context');
 }
 if(request.method==='turn/steer') {
  if(request.params.expectedTurnId!==turnId || request.params.threadId!=='thread') throw new Error('wrong steer binding');
  send({id:request.id,result:{turnId}});
  complete(request.params.input[0].text);
 }
 if(request.method==='thread/compact/start') {
  turnId='compact';
  notify('turn/started',{threadId:'thread',turn:{id:turnId}});
  send({id:request.id,result:{}});
  notify('turn/completed',{threadId:'thread',turn:{id:turnId,status:'completed',error:null}});
 }
});
`;

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "hcp-native-session-"));
  const executable = join(cwd, "native.mjs"), record = join(cwd, "record.jsonl"), state = join(cwd, "state.json");
  await writeFile(executable, providerFixture, {mode: 0o700});
  const config = RunnerConfigSchema.parse({runner_id:"runner",control_plane_url:"ws://localhost:8787",workspaces:[{id:"workspace",path:cwd}],
    provider_instances:[{id:"codex",driver_kind:"codex",executable_path:executable,env:{RECORD:record}}]});
  const manager = () => new HarnessSessionManager(config, {stateStore: new JsonRunnerStateStore(state)});
  const payload = (session: string, input: string, continuation: boolean): HcpSessionStartPayload => ({session_id:session,workspace_id:"workspace",
    provider_instance_id:"codex",driver_kind:"codex",cwd,sandbox_mode:"workspace_write",approval_policy:"ask",continue_session:continuation,
    continuation_group_key:"conversation",model_selection:{model:"model"},mcp_servers:[],
    first_turn:{turn_id:`${session}-turn`,input,not_after:new Date(Date.now()+30_000).toISOString()}});
  const requests = async () => (await readFile(record,"utf8")).trim().split("\n").map(line => JSON.parse(line));
  return {cwd,manager,payload,requests,cleanup:() => rm(cwd,{recursive:true,force:true})};
}

test("native instruction roles reach Codex start/resume and changed instructions cannot reuse a binding", {timeout: 10_000}, async () => {
  const f = await fixture();
  let manager = f.manager();
  const instructions = {system: "Application system instructions", developer: "Application developer instructions"};
  try {
    const start = {...f.payload("first", "followup", false), instructions};
    await manager.startSession(start); await manager.sendFirstTurn(start, () => {}); await manager.stopSession("first", "idle");
    manager = f.manager();
    const resume = {...f.payload("second", "followup", true), instructions};
    await assert.rejects(manager.startSession({...resume, session_id: "changed", instructions: {...instructions, developer: "Changed"}}),
      {code: "native_configuration_transition_binding"});
    await manager.startSession(resume); await manager.sendFirstTurn(resume, () => {}); await manager.stopSession("second", "done");
    const requests = (await f.requests()).filter(request => ["thread/start", "thread/resume"].includes(request.method));
    assert.equal(requests.length, 2);
    for (const request of requests) {
      assert.equal(request.params.baseInstructions, instructions.system);
      assert.equal(request.params.developerInstructions, instructions.developer);
    }
  } finally {for (const id of ["first", "second"]) if (manager.activeSessionCount()) await manager.stopSession(id, "cleanup"); await f.cleanup();}
});

for (const unrestricted of [false, true]) test(`native permission grants use turn scope and ${unrestricted ? "allow unrestricted approval" : "preserve restricted containment"}`, async () => {
  const f = await fixture(), manager = f.manager();
  try {
    const start = {...f.payload("permissions-session", "permissions", false), sandbox_mode: unrestricted ? "danger_full_access" as const : "workspace_write" as const};
    await manager.startSession(start);
    let response: Promise<unknown> | undefined;
    const events: HcpHarnessEventPayload[] = [];
    await manager.sendFirstTurn(start, event => {
      events.push(event);
      if (event.event_type === "approval.requested") {
        const data = event.data as Record<string, unknown>;
        assert.equal(data.request_type, "permissions");
        assert.equal((data.allowed_decisions as string[]).includes("accept"), unrestricted);
        assert.equal((data.allowed_decisions as string[]).includes("accept_for_session"), false);
        response = manager.respondToMcpReview({session_id: start.session_id, turn_id: start.first_turn!.turn_id,
          request_id: data.request_id as string, action_hash: data.action_hash as string,
          decision: unrestricted ? "accept" : "decline", actor_id: "actor"}, () => {});
      }
    });
    await response;
    assert.equal(events.at(-1)?.event_type, "turn.completed");
    const result = (await f.requests()).find(request => request.id === "permissions").result;
    assert.equal(result.scope, "turn");
    assert.deepEqual(result.permissions, unrestricted ? {network: {enabled: true}} : {});
    await manager.stopSession(start.session_id, "done");
  } finally {await f.cleanup();}
});

for (const mode of ["approval", "question"] as const) {
  test(`native ${mode} goes through manager, real stdio and canonical reducer; reopening preserves the native thread`, {timeout:10_000}, async () => {
    const f = await fixture();
    let manager = f.manager();
    try {
      const start = f.payload("first",mode,false);
      const events = await manager.startSession(start);
      const completion = manager.sendFirstTurn(start, event => {
        events.push(event);
        const data = event.data as Record<string, unknown>;
        if(event.event_type === "approval.requested") void manager.respondToMcpReview({session_id:start.session_id,turn_id:start.first_turn!.turn_id,
          request_id:data.request_id as string,action_hash:data.action_hash as string,decision:"accept",actor_id:"actor"}, () => {});
        if(event.event_type === "user_input.requested") void manager.respondToMcpInput({session_id:start.session_id,turn_id:start.first_turn!.turn_id,
          request_id:data.request_id as string,actor_id:"actor",value:{answers:{scope:{answers:["Small"]}}}}, () => {});
      });
      await completion;
      events.push(...await manager.stopSession(start.session_id,"Completed"));
      const reducer = new HcpSessionEventReducer();
      for (const event of events) {hcpHarnessEventPayloadSchema.parse(event); assert.equal(reducer.applyEvent(event).outcome,"applied");}
      assert.equal(events.filter(event => event.event_type === "turn.completed").length,1);
      assert.ok(events.some(event => event.event_type === "command.completed" && "exit_code" in event.data && event.data.exit_code === 0));
      assert.ok(events.some(event => event.event_type === "turn.plan.updated"));
      assert.ok(events.some(event => event.event_type === "turn.diff.updated"));
      manager = f.manager();
      const next = f.payload("second","followup",true);
      await manager.startSession(next);
      const nextEvents: HcpHarnessEventPayload[] = [];
      await manager.sendFirstTurn(next,event => nextEvents.push(event));
      assert.ok(nextEvents.some(event => event.event_type === "turn.completed"));
      await manager.stopSession(next.session_id,"Completed");
      const requests = await f.requests();
      assert.equal(requests.filter(request => request.method === "thread/start").length,1);
      assert.equal(requests.find(request => request.method === "thread/resume").params.threadId,"thread");
      assert.equal(requests.filter(request => request.id === mode).length,1);
    } finally {for(const id of ["first","second"]) {if(manager.activeSessionCount()) await manager.stopSession(id,"cleanup");} await f.cleanup();}
  });
}

test("interruption during native approval settles once; changed policy cannot reopen that conversation", {timeout:10_000}, async () => {
  const f = await fixture(), manager = f.manager();
  try {
    const start = f.payload("first","interrupt",false);
    await manager.startSession(start);
    let publish!: () => void;
    const requested = new Promise<void>(resolve => {publish=resolve;});
    const events: HcpHarnessEventPayload[] = [];
    const completion = manager.sendFirstTurn(start,event => {events.push(event);if(event.event_type==="approval.requested") publish();});
    await requested;
    await manager.cancelTurn(start.session_id,start.first_turn!.turn_id);
    await completion;
    await manager.stopSession(start.session_id,"Interrupted");
    assert.equal(events.filter(event => event.event_type === "turn.cancelled").length,1);
    assert.equal((await f.requests()).filter(request => request.id === "approval").length,0);
    await assert.rejects(manager.startSession({...f.payload("second","followup",true),approval_policy:"full_access"}), /policy changed/);
    const next = f.payload("third","followup",true);
    await manager.startSession(next); await manager.sendFirstTurn(next,()=>{}); await manager.stopSession(next.session_id,"Completed");
    assert.equal((await f.requests()).filter(request => request.method === "thread/start").length,1);
  } finally {for(const id of ["first","second","third"]) {if(manager.activeSessionCount()) await manager.stopSession(id,"cleanup");} await f.cleanup();}
});

test("native steering targets the exact live turn and compaction preserves its conversation", {timeout:10_000}, async () => {
  const f = await fixture(), manager = f.manager();
  try {
    const start = f.payload("first", "steer", false);
    await manager.startSession(start);
    const events: HcpHarnessEventPayload[] = [];
    const running = manager.sendFirstTurn(start, event => events.push(event));
    // The fixture's request log supplies native readiness without relying on a wall-clock delay.
    for (let attempts = 0; attempts < 100; attempts++) {
      if (await f.requests().then(requests => requests.some(request => request.method === "turn/start")).catch(() => false)) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await assert.rejects(manager.conversationOperation("wrong", {session_id: "first", operation: {kind: "steer", turn_id: "another", input: "wrong"}}), /exact active turn/);
    const result = await manager.conversationOperation("steer-command", {session_id: "first", operation: {kind: "steer", turn_id: start.first_turn!.turn_id, input: "new direction"}});
    assert.equal(result.turn_id, start.first_turn!.turn_id);
    await running;
    await assert.rejects(manager.conversationOperation("late", {session_id: "first", operation: {kind: "steer", turn_id: start.first_turn!.turn_id, input: "late"}}), /exact active turn/);
    assert.equal(events.filter(event => event.event_type === "turn.completed").length, 1);
    assert.ok(events.some(event => event.event_type === "turn.completed" && (event.data as {final_output?: {final_text?: string}}).final_output?.final_text === "new direction"));
    const compact = await manager.sendTurn({session_id: "first", turn_id: "compact-hcp", action: "compact", input: ""});
    assert.equal(compact.filter(event => event.event_type === "turn.completed").length, 1);
    assert.equal((await f.requests()).filter(request => request.method === "thread/start").length, 1);
    assert.equal((await f.requests()).filter(request => request.method === "thread/compact/start").length, 1);
    const reducer = new HcpSessionEventReducer();
    for (const event of [...events, ...compact]) {hcpHarnessEventPayloadSchema.parse(event); reducer.applyEvent(event);}
  } finally {await manager.stopSession("first", "cleanup"); await f.cleanup();}
});
