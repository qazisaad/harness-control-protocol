import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtemp, writeFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {CodexRpc} from "./codex-rpc.js";
import {runRetainedCodexTurn} from "./codex-runtime.js";
import type {HarnessAdapterTurnInput} from "../types.js";
import type {HarnessNativeGoalRecord} from "@harness-control/protocol";

for (const action of ["start", "resume"] as const)
for (const steeringMode of ["none", "between", "wrong-ack"] as const)
test(`one admitted native goal owns multiple autonomous phases until native completion (${action}, ${steeringMode})`, {timeout: 10_000}, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "hcp-goal-runtime-"));
  const executable = join(cwd, "native.mjs");
  await writeFile(executable, `#!/usr/bin/env node
import {createInterface} from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
const notify = (method,params) => send({method,params});
let goal=${action === "resume" ? JSON.stringify({threadId: "root", objective: "Finish both phases", status: "paused", createdAt: 100, updatedAt: 100, tokensUsed: 5, timeUsedSeconds: 1}) : "null"};
const complete=(id,text)=>{notify('item/completed',{threadId:'root',turnId:id,item:{id:'item-'+id,type:'agentMessage',text}});notify('turn/completed',{threadId:'root',turn:{id,status:'completed',error:null}});};
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line), p=m.params;
 if(m.method==='config/read')send({id:m.id,result:{config:{}}});
 else if(m.method==='mcpServerStatus/list')send({id:m.id,result:{data:[],nextCursor:null}});
 else if(m.method==='thread/settings/update'){notify('thread/settings/updated',{threadId:'root',threadSettings:{model:p.model,summary:p.summary,effort:p.effort,cwd:process.cwd(),approvalPolicy:'never',approvalsReviewer:'user',serviceTier:'default',collaborationMode:p.collaborationMode,sandboxPolicy:{type:'dangerFullAccess'}}});send({id:m.id,result:{}});}
 else if(m.method==='thread/goal/get')send({id:m.id,result:{goal}});
 else if(m.method==='thread/goal/set'){
  goal=goal?{...goal,status:p.status,updatedAt:goal.updatedAt+1}:{threadId:'root',objective:p.objective,status:p.status,createdAt:100,updatedAt:100,tokensUsed:0,timeUsedSeconds:0,...(p.tokenBudget?{tokenBudget:p.tokenBudget}:{})};
  notify('thread/goal/updated',{threadId:'root',goal});send({id:m.id,result:{goal}});
  if(p.status==='active')setTimeout(()=>{notify('turn/started',{threadId:'root',turn:{id:'second',status:'inProgress'}});setTimeout(()=>{complete('second','SECOND');goal={...goal,status:'complete',updatedAt:goal.updatedAt+1,tokensUsed:20,timeUsedSeconds:1};notify('thread/goal/updated',{threadId:'root',goal,turnId:'second'});},100);},50);
 }
 else if(m.method==='turn/start'){if(${action === 'resume'} && p.input.length!==0)throw Error('resume must not inject a new prompt');send({id:m.id,result:{turn:{id:'first'}}});notify('turn/started',{threadId:'root',turn:{id:'first',status:'inProgress'}});complete('first','FIRST');}
 else if(m.method==='turn/steer'){if(p.expectedTurnId!=='second')throw Error('wrong native steering phase');send({id:m.id,result:{turnId:${steeringMode === 'wrong-ack' ? "'foreign'" : "'second'"}}});}
 else if(m.method==='turn/interrupt'){send({id:m.id,result:{}});notify('turn/completed',{threadId:'root',turn:{id:p.turnId,status:'interrupted'}});}
});
`, {mode: 0o700});
  const rpc = new CodexRpc(executable, cwd, process.env);
  const goals: HarnessNativeGoalRecord[] = [], phases: {reference: string; job?: string; observed?: true; execution?: string}[] = [];
  let reserved = false, completed = false;
  let controls: import("../types.js").HarnessActiveTurnControls | undefined;
  let steering: Promise<unknown> | undefined;
  const outcomes: string[] = [];
  const input: HarnessAdapterTurnInput = {payload: {session_id: "session", turn_id: "original", input: action === "start" ? "First phase" : "",
    goal: action === "start" ? {action, objective: "Finish both phases"} : {action, expected_native_created_at: 100}}, session: {adapter_session_id: "session", native_thread_id: "root"},
    startPayload: {session_id: "session", workspace_id: "workspace", provider_instance_id: "codex", driver_kind: "codex", cwd,
      sandbox_mode: "danger_full_access", approval_policy: "full_access", continue_session: false, execution_profile: "interactive",
      model_selection: {model: "fixture"}, mcp_servers: []},
    provider: {id: "codex", driver_kind: "codex", enabled: true, launch_args: [], env: {}, models: [], hidden_models: [], model_order: [], favorite_models: [], local_capabilities: []},
    beginNativeGoal(_reference, request, resume) {assert.equal(request.action, action); assert.equal(resume?.native_created_at, action === "resume" ? 100 : undefined); assert.equal(phases.length, 0); reserved = true; return "job";},
    confirmNativeGoal(goal) {assert.equal(reserved, true); goals.push(goal);},
    beginNativeExecution(reference, job, observed) {assert.ok(goals.length); phases.push({reference, ...(job ? {job} : {}), ...(observed ? {observed} : {})}); return String(phases.length - 1);},
    confirmNativeExecution(id, execution) {phases[Number(id)]!.execution = execution;},
    registerActiveTurnControls(value) {controls = value;},
    completeNativeExecution(id, status) {
      outcomes.push(status); assert.equal(phases[Number(id)]?.execution, Number(id) === 0 ? "first" : "second");
      if (id === "0" && steeringMode !== "none") queueMicrotask(() => {
        steering = controls!.steer("Steer the next owned phase"); void steering.catch(() => {});
      });
    },
  };
  try {
    const output = await runRetainedCodexTurn(input, new AbortController().signal, () => {}, {rpc, initialized: true,
      started: {thread: {id: "root"}, approvalPolicy: "never", approvalsReviewer: "user", sandbox: {type: "dangerFullAccess"}}}).then(value => {completed = true; return value;});
    assert.ok(steeringMode === "none" || steering);
    if (steeringMode === "wrong-ack") await assert.rejects(steering!, /different native execution/);
    else if (steering) await steering;
    assert.deepEqual(outcomes, ["completed", "completed"]);
    assert.equal(completed, true); assert.equal(output.final_text, "SECOND");
    assert.deepEqual(phases, [{reference: "root", job: "job", execution: "first"}, {reference: "root", job: "job", observed: true, execution: "second"}]);
    assert.deepEqual(goals.map(goal => goal.status), ["paused", "active", "active", "complete"]);
    assert.ok(goals.every(goal => goal.origin_turn_id === "original" && goal.admission_id === "job"));
    assert.equal(goals.at(-1)?.tokens_used, 20);
  } finally {await rpc.process.stop(); await rm(cwd, {recursive: true, force: true});}
});
