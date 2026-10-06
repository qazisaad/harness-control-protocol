import assert from "node:assert/strict";
import {mkdtemp, readFile, writeFile, access} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {HarnessSessionManager} from "@harness-control/runner/harnesses";
import {RunnerConfigSchema} from "@harness-control/runner/config";
import {JsonRunnerStateStore} from "@harness-control/runner/state";
import {hcpHarnessEventPayloadSchema} from "@harness-control/protocol";

if (process.env.HCP_NATIVE_LIVE !== "1") throw new Error("Set HCP_NATIVE_LIVE=1 for authenticated native acceptance.");
const driver = process.env.HCP_LIVE_PROVIDER ?? "codex";
assert.ok(["codex", "opencode"].includes(driver));
const cwd = await mkdtemp(join(tmpdir(), `hcp-live-${driver}-child-input-`));
const config = RunnerConfigSchema.parse({runner_id:"work-input-acceptance", control_plane_url:"ws://localhost:8787",
  workspaces:[{id:"workspace",path:cwd}],provider_instances:[{id:driver,driver_kind:driver}]});
const manager = new HarnessSessionManager(config,{stateStore:new JsonRunnerStateStore(join(cwd,"state.json"))});
const events=[],seen=new Set(),passed=[];
const observe=event=>{hcpHarnessEventPayloadSchema.parse(event);if(!seen.has(event.sequence)){seen.add(event.sequence);events.push(event);}};
const unsubscribe=manager.subscribeEvents(observe);
const until=async predicate=>{const deadline=Date.now()+120000;while(Date.now()<deadline){const value=await predicate();if(value)return value;await new Promise(resolve=>setTimeout(resolve,100));}throw new Error("Native child input acceptance timed out");};
const readWork=async()=>{const result=await manager.conversationOperation(randomUUID(),{session_id:"work",operation:{kind:"work",action:"read"}});return result.work.items;};
const send=async(turn_id,input)=>{
  console.log(JSON.stringify({driver,stage:turn_id,cwd}));
  await manager.sendTurn({session_id:"work",turn_id,input},observe);
  assert.equal(events.findLast(event=>event.turn_id===turn_id&&["turn.completed","turn.failed","turn.cancelled"].includes(event.event_type))?.event_type,"turn.completed");
};
const spawn=async(turn_id,target,marker)=>{
  const command=`printf '%s' '${marker}' > '${target}'`;
  await send(turn_id,driver === "opencode"
    ? `Use task exactly once with background: true, subagent_type: general and this exact child prompt: Use bash to execute exactly this command, with no prefix or suffix: ${command}. Use no other tool. Wait for permission, then return done.\nAfter launching, immediately reply ROOT_RETURNED. Do not wait, poll or use other tools.`
    : `Spawn exactly one native child agent with this exact prompt: Use the shell tool to execute exactly this command, with no prefix or suffix: ${command}. Use no other tool. Wait for permission if required, then return done.\nAfter launching it, immediately return ROOT_RETURNED. Do not wait, send follow-up messages or do the child's work yourself.`);
  const request=await until(()=>events.find(event=>event.event_type==="approval.requested"&&event.turn_id===turn_id&&event.data.native_work_id));
  const details=JSON.parse(request.data.action).details;
  assert.ok(details.command===command||details.command===`/bin/bash -lc "${command}"`||driver === "opencode"&&details.metadata?.command===command,"Unexpected action outside the controlled child write");
  assert.ok(request.data.allowed_decisions.includes("accept"));
  return request;
};
try {
  const model=driver === "opencode" ? process.env.HCP_LIVE_OPENCODE_MODEL ?? "opencode-go/glm-5.3-flash"
    : process.env.HCP_LIVE_CODEX_MODEL??(await manager.providerDriverStatuses()).find(status=>status.driver_kind===driver)?.models.find(model=>model.is_default)?.id;
  assert.ok(model);
  await manager.startSession({session_id:"work",workspace_id:"workspace",provider_instance_id:driver,driver_kind:driver,cwd,
    execution_profile:driver === "opencode" ? "background" : "interactive",
    ...(driver === "opencode" ? {configuration_inheritance:{user_settings:false,project_settings:false,hooks:false,mcp_servers:false,plugins:false}} : {}),
    sandbox_mode:"danger_full_access",approval_policy:"ask",continue_session:false,model_selection:{model},mcp_servers:[]});
  const target=join(cwd,"approved-child.txt"),marker=randomUUID();
  const request=await spawn("approval-root",target,marker);
  passed.push("child-approval-after-root");
  await send("new-root","Reply FOLLOWUP only. Use no tools and do not wait for any child.");
  const response={session_id:"work",turn_id:request.turn_id,request_id:request.data.request_id,action_hash:request.data.action_hash,decision:"accept",actor_id:"live-test"};
  await assert.rejects(manager.respondToMcpReview({...response,turn_id:"new-root"},observe),/another active session or turn/);
  passed.push("new-root-cannot-answer-old-child");
  assert.deepEqual(await manager.respondToMcpReview(response,observe),{kind:"live"});
  await until(async()=>(await readWork()).find(item=>item.work.work_id===request.data.native_work_id&&item.work.status==="completed"));
  assert.equal(await readFile(target,"utf8"),marker);
  passed.push("original-child-owner-accepts","observed-approved-child-effect");
  if (driver === "opencode") await until(async()=>{
    const related=(await readWork()).filter(item=>item.work.origin_turn_id==="approval-root");
    return related.some(item=>item.work.kind==="task")&&related.every(item=>["completed","failed","cancelled"].includes(item.work.status));
  });
  const cancelledTarget=join(cwd,"cancelled-child.txt");
  const cancelled=await spawn("cancel-root",cancelledTarget,randomUUID());
  const item=(await readWork()).find(item=>item.work.work_id===cancelled.data.native_work_id);
  assert.ok(item);
  await manager.conversationOperation(randomUUID(),{session_id:"work",operation:{kind:"work",action:"cancel",work_id:item.work.work_id,expected_revision:item.work.revision}});
  await until(async()=>(await readWork()).find(value=>value.work.work_id===item.work.work_id&&value.work.status==="cancelled"));
  await until(()=>events.find(event=>event.event_type==="native.request.lost"&&event.data.native_work_id===item.work.work_id));
  await assert.rejects(access(cancelledTarget),{code:"ENOENT"});
  await assert.rejects(manager.respondToMcpReview({...response,turn_id:cancelled.turn_id,request_id:cancelled.data.request_id,action_hash:cancelled.data.action_hash},observe));
  passed.push("child-cancel-at-approval","lost-callback-keeps-work-origin","no-cancelled-effect","stale-child-reply-refused");
  await send("after-cancel","Reply READY only. Use no tools.");
  if (driver === "opencode") {
    await send("question-root", "Use task exactly once with background: true, subagent_type: general and this exact child prompt: Use question to ask exactly one question: Which test color? Offer Green and Blue, allow one choice. Do not answer it yourself. After the user replies, respond with their color only. Do not use other tools. After launching, immediately reply ROOT_RETURNED. Do not wait or poll.");
    const question = await until(() => events.find(event => event.event_type === "user_input.requested" && event.turn_id === "question-root" && event.data.native_work_id));
    const fields = Object.keys(question.data.form_schema?.properties?.answers?.properties ?? {});
    assert.equal(fields.length, 1);
    const answer = {session_id: "work", turn_id: question.turn_id, request_id: question.data.request_id,
      actor_id: "live-test", value: {answers: {[fields[0]]: {answers: ["Green"]}}}};
    await send("question-followup", "Reply READY only. Use no tools. Do not answer or wait for any child's question.");
    await assert.rejects(manager.respondToMcpInput({...answer, turn_id: "question-followup"}, observe), /another active session or turn/);
    await manager.respondToMcpInput(answer, observe);
    await until(async () => {
      const related = (await readWork()).filter(item => item.work.origin_turn_id === "question-root");
      return related.some(item => item.work.kind === "task") && related.every(item => ["completed", "failed", "cancelled"].includes(item.work.status));
    });
    passed.push("child-question-after-root", "new-root-cannot-answer-old-child-question", "original-child-question-owner-answers");
  }
  await manager.stopSession("work","acceptance-complete");
  passed.push("followup-after-child-cancel","safe-unload");
  console.log(JSON.stringify({driver,passed,cwd,event_count:events.length}));
} catch(error){process.exitCode=1;console.error(JSON.stringify({driver,passed,cwd,failed:error instanceof Error?error.message:String(error)}));}
finally {
  if(manager.activeSessionCount())try{await manager.stopSession("work","acceptance-cleanup");}catch(error){console.error(error.message);process.exitCode=1;}
  unsubscribe();await writeFile(join(cwd,"events.json"),JSON.stringify(events,null,2));
}
