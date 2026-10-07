import assert from "node:assert/strict";
import {test} from "node:test";
import {respondOpenCodeInteraction} from "./opencode-interactions.js";

const event={type:"permission.asked",properties:{id:"request",sessionID:"session",permission:"bash",always:["echo *"],tool:{messageID:"assistant",callID:"call"}}};
const native={info:{id:"assistant",sessionID:"session",role:"assistant",parentID:"prompt"},
  parts:[{type:"tool",messageID:"assistant",sessionID:"session",callID:"call",state:{status:"running"}}]};
test("remembered native decisions require two matching origin reads and exact reply confirmation",async()=>{
  let reads=0;const replies:unknown[]=[];
  await respondOpenCodeInteraction(event,{sessionId:"session",promptId:"prompt",turnId:"turn",sessionPermissions:true,signal:new AbortController().signal,
    readMessage:async()=>{reads++;return native;},reply:async(path,body)=>{replies.push({path,body});return true;},owner:{
      approval:async (params,_type,_signal,nativeRequest)=>{assert.deepEqual(nativeRequest, {source:"native",native_reference:"session",request_reference:"request",execution_reference:"prompt",message_reference:"assistant",call_reference:"call"});assert.deepEqual((params as {availableDecisions:string[]}).availableDecisions,["accept","accept_for_session","decline"]);return {decision:"accept_for_session"};},
      questions:async()=>assert.fail("Unexpected question")}});
  assert.equal(reads,2);assert.deepEqual(replies,[{path:"/permission/request/reply",body:{reply:"always"}}]);
});
test("origin drift during a human decision prevents native reply dispatch",async()=>{
  let reads=0;
  await assert.rejects(respondOpenCodeInteraction(event,{sessionId:"session",promptId:"prompt",turnId:"turn",sessionPermissions:true,signal:new AbortController().signal,
    readMessage:async()=>++reads===1?native:{...native,info:{...native.info,parentID:"another-prompt"}},reply:async()=>assert.fail("Stale approval dispatched"),
    owner:{approval:async()=>({decision:"accept"}),questions:async()=>assert.fail("Unexpected question")}}),/admitted prompt and tool/);
  assert.equal(reads,2);
});
test("native lost acknowledgement reports unknown execution rather than success",async()=>{
  await assert.rejects(respondOpenCodeInteraction(event,{sessionId:"session",promptId:"prompt",turnId:"turn",sessionPermissions:false,signal:new AbortController().signal,
    readMessage:async()=>native,reply:async()=>false,owner:{approval:async()=>({decision:"accept"}),questions:async()=>assert.fail("Unexpected question")}}),/outcome is unknown/);
});


test("a tool finishing while a human decides prevents late native approval dispatch", async () => {
  let reads = 0, decisions = 0;
  await assert.rejects(respondOpenCodeInteraction(event, {sessionId: "session", promptId: "prompt", turnId: "turn",
    sessionPermissions: true, signal: new AbortController().signal,
    readMessage: async () => ++reads === 1 ? native : {...native, parts: [{...native.parts[0], state: {status: "completed"}}]},
    reply: async () => assert.fail("Completed tool received a stale approval"), owner: {
      approval: async () => {decisions++; return {decision: "accept"};}, questions: async () => assert.fail("Unexpected question")}}), /admitted prompt and tool/);
  assert.equal(decisions, 1); assert.equal(reads, 2);
});
