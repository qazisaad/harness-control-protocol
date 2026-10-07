import assert from "node:assert/strict";
import {test} from "node:test";
import {verifyOpenCodeRequestOrigin} from "./opencode-request-binding.js";

const request={sessionID:"session",tool:{messageID:"assistant",callID:"call"}};
const message={info:{id:"assistant",sessionID:"session",role:"assistant",parentID:"admitted-prompt"},
  parts:[{type:"tool",callID:"call",messageID:"assistant",sessionID:"session",state:{status:"running"}}]};
test("failed native origin lookup cannot leave an unverified callback owner alive",async()=>{
  await assert.rejects(verifyOpenCodeRequestOrigin(request,"session","admitted-prompt",async()=>{throw new Error("lookup timed out");}),
    error=>error instanceof Error&&"code" in error&&error.code==="native_request_origin_unconfirmed");
});
test("native permission/question origin requires its admitted assistant parent and tool",async()=>{
  const reads:string[]=[];
  await verifyOpenCodeRequestOrigin(request,"session","admitted-prompt",async id=>{reads.push(id);return message;});
  assert.deepEqual(reads,["assistant"]);
});
test("missing and foreign callback origins fail before history lookup",async()=>{
  for(const properties of [{sessionID:"session"},{...request,sessionID:"foreign"},{...request,tool:{messageID:"assistant"}}])
    await assert.rejects(verifyOpenCodeRequestOrigin(properties,"session","admitted-prompt",async()=>assert.fail("unbound history read")),/native tool origin/);
});
test("a delayed callback from an earlier root cannot adopt the currently running root",async()=>{
  for(const value of [
    {...message,info:{...message.info,parentID:"older-prompt"}},
    {...message,info:{...message.info,id:"foreign"}},
    {...message,info:{...message.info,sessionID:"foreign"}},
    {...message,info:{...message.info,role:"user"}},
    {...message,parts:[{...message.parts[0],callID:"another-call"}]},
    {...message,parts:[{...message.parts[0],messageID:"foreign"}]},
    {...message,parts:[{...message.parts[0],sessionID:"foreign"}]},
  ])await assert.rejects(verifyOpenCodeRequestOrigin(request,"session","admitted-prompt",async()=>value),/admitted prompt and tool/);
});


test("terminal, missing-state and ambiguous native tool records cannot authorize a callback", async () => {
  for (const parts of [[{...message.parts[0], state: {status: "completed"}}], [{...message.parts[0], state: {status: "error"}}],
    [{...message.parts[0], state: undefined}], [message.parts[0], message.parts[0]]])
    await assert.rejects(verifyOpenCodeRequestOrigin(request, "session", "admitted-prompt", async () => ({...message, parts})), /admitted prompt and tool/);
});
