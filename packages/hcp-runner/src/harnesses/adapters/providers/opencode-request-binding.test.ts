import assert from "node:assert/strict";
import {test} from "node:test";
import {verifyOpenCodeRequestOrigin} from "./opencode-request-binding.js";

const request={sessionID:"session",tool:{messageID:"assistant",callID:"call"}};
const message={info:{id:"assistant",sessionID:"session",role:"assistant",parentID:"admitted-prompt"},
  parts:[{type:"tool",callID:"call",messageID:"assistant",sessionID:"session"}]};
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
