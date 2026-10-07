import assert from "node:assert/strict";
import {test} from "node:test";
import {codexApproval} from "./codex-approvals.js";
import {NativeInteractions} from "../../native-interactions.js";
import type {HarnessAdapterEvent} from "../types.js";

for (const interactive of [false,true]) test(`native cached permission is offered only by its verified interactive owner (${interactive})`,async()=>{
  const events:HarnessAdapterEvent[]=[];
  const owner=new NativeInteractions({session_id:"session",workspace_id:"workspace",provider_instance_id:"codex",driver_kind:"codex",cwd:process.cwd(),
    sandbox_mode:"danger_full_access",approval_policy:"ask",continue_session:false,model_selection:{model:"fixture"},mcp_servers:[],
    ...(interactive?{execution_profile:"interactive"}: {})}, {session_id:"session",turn_id:"root",input:"run"},
    {threadId:"native",turnId:()=>"turn"},event=>events.push(event));
  const pending=codexApproval(owner,{threadId:"native",turnId:"turn",itemId:"command",command:"controlled command",
    availableDecisions:["accept","acceptForSession",{acceptWithExecpolicyAmendment:{execpolicy_amendment:["dangerous-persistent-rule"]}},"cancel"]},"command",new AbortController().signal,interactive,{requestId:"actual-rpc-request"});
  await new Promise(resolve=>setImmediate(resolve));
  const event=events.find(event=>event.event_type==="approval.requested")!;
  assert.deepEqual(event.data.native_request, {source:"native",native_reference:"native",request_reference:"actual-rpc-request",execution_reference:"turn",item_reference:"command"});
  assert.deepEqual(event.data.allowed_decisions,interactive?["accept","accept_for_session","cancel"]:["accept","cancel"]);
  owner.respondApproval({session_id:"session",turn_id:"root",request_id:event.data.request_id as string,action_hash:event.data.action_hash as string,
    actor_id:"user",decision:interactive?"accept_for_session":"accept"});
  assert.deepEqual(await pending,{decision:interactive?"acceptForSession":"accept"});
  owner.close();
});

test("missing native decision advertisement never invents remembered acceptance",async()=>{
  let allowed:unknown;
  const owner=new NativeInteractions({session_id:"session",workspace_id:"workspace",provider_instance_id:"codex",driver_kind:"codex",cwd:process.cwd(),
    sandbox_mode:"danger_full_access",approval_policy:"ask",execution_profile:"interactive",continue_session:false,model_selection:{model:"fixture"},mcp_servers:[]},
    {session_id:"session",turn_id:"root",input:"run"},{threadId:"native",turnId:()=>"turn"},event=>{
      if(event.event_type==="approval.requested"){allowed=event.data.allowed_decisions;owner.respondApproval({session_id:"session",turn_id:"root",actor_id:"user",
        request_id:event.data.request_id as string,action_hash:event.data.action_hash as string,decision:"cancel"});}
    });
  assert.deepEqual(await codexApproval(owner,{threadId:"native",turnId:"turn",itemId:"item"},"command",new AbortController().signal,true),{decision:"cancel"});
  assert.deepEqual(allowed,["accept","decline","cancel"]);owner.close();
});
