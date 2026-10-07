import {harnessNativeRequestIdentitySchema} from "@harness-control/protocol";
import {z} from "zod";
import {NativeInteractions} from "../../native-interactions.js";
import {HarnessAdapterError} from "../types.js";
import {verifyOpenCodeRequestOrigin} from "./opencode-request-binding.js";

export async function respondOpenCodeInteraction(event:{type:string;properties:Record<string,unknown>}, input:{
  sessionId:string;promptId:string;turnId:string;owner:Pick<NativeInteractions,"approval"|"questions">;signal:AbortSignal;sessionPermissions:boolean;
  readMessage:(id:string)=>Promise<unknown>;reply:(path:string,body:unknown,signal:AbortSignal)=>Promise<unknown>;
}):Promise<void> {
  const requestId=z.string().min(1).max(512).parse(event.properties.id);
  const verify=()=>verifyOpenCodeRequestOrigin(event.properties,input.sessionId,input.promptId,input.readMessage);
  await verify();input.signal.throwIfAborted();
  const tool = z.object({messageID: z.string(), callID: z.string()}).parse(event.properties.tool);
  const nativeRequest = harnessNativeRequestIdentitySchema.parse({source: "native", native_reference: input.sessionId,
    request_reference: requestId, execution_reference: input.promptId, message_reference: tool.messageID, call_reference: tool.callID});
  const binding={threadId:input.sessionId,turnId:input.turnId,itemId:requestId};
  let path:string,body:unknown;
  if(event.type==="permission.asked") {
    const permission=z.string().parse(event.properties.permission);
    const type=permission==="bash"?"command":permission==="read"?"file_read":permission==="edit"?"file_change":"other";
    const remembered=input.sessionPermissions&&z.array(z.string().min(1).max(4096)).min(1).max(128).safeParse(event.properties.always).success;
    const result=await input.owner.approval({...event.properties,...binding,
      availableDecisions:["accept",...(remembered?["accept_for_session"]:[]),"decline"]},type,input.signal,nativeRequest);
    path=`/permission/${encodeURIComponent(requestId)}/reply`;
    body={reply:result.decision==="accept_for_session"?"always":result.decision==="accept"?"once":"reject"};
  } else if(event.type==="question.asked") {
    const questions=z.array(z.object({question:z.string(),header:z.string(),options:z.array(z.object({label:z.string(),description:z.string()})),
      multiple:z.boolean().optional(),custom:z.boolean().optional()})).min(1).max(16).parse(event.properties.questions);
    const result=z.object({answers:z.record(z.string(),z.object({answers:z.array(z.string())}))}).parse(await input.owner.questions({...binding,
      questions:questions.map((question,index)=>({...question,id:`question-${index}`,isOther:question.custom!==false,multiSelect:question.multiple??false}))},input.signal,nativeRequest));
    const cancelled=!Object.keys(result.answers).length;
    path=`/question/${encodeURIComponent(requestId)}/${cancelled?"reject":"reply"}`;
    body=cancelled?{}:{answers:questions.map((_question,index)=>result.answers[`question-${index}`]!.answers)};
  } else throw new HarnessAdapterError("native_request_unsupported","The native interaction kind is unsupported.");
  // Human replies can arrive much later. Reconfirm the exact native tool immediately before dispatch.
  await verify();input.signal.throwIfAborted();
  try {
    if(await input.reply(path,body,input.signal)!==true)throw new Error("Unconfirmed native reply");
  } catch {throw new HarnessAdapterError("native_reply_unknown","OpenCode did not acknowledge the native interaction reply; its execution outcome is unknown.");}
}
