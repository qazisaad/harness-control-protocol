import {z} from "zod";
import {HarnessAdapterError} from "../types.js";

const id=z.string().min(1).max(512);
/** Permission/question events identify a native tool; its assistant parent proves the admitted prompt. */
export async function verifyOpenCodeRequestOrigin(properties: Record<string,unknown>, sessionId:string, promptId:string,
  readMessage:(messageId:string)=>Promise<unknown>): Promise<void> {
  const request=z.object({sessionID:id,tool:z.object({messageID:id,callID:id})}).safeParse(properties);
  if(!request.success||request.data.sessionID!==sessionId)
    throw new HarnessAdapterError("native_request_origin_unconfirmed","OpenCode did not identify this callback's native tool origin.");
  const value=z.object({info:z.object({id,sessionID:id,role:z.literal("assistant"),parentID:id}),
    parts:z.array(z.record(z.string(),z.unknown())).max(1024)}).safeParse(await readMessage(request.data.tool.messageID));
  if(!value.success||value.data.info.id!==request.data.tool.messageID||value.data.info.sessionID!==sessionId||value.data.info.parentID!==promptId||
    !value.data.parts.some(part=>part.type==="tool"&&part.callID===request.data.tool.callID&&part.messageID===request.data.tool.messageID&&part.sessionID===sessionId))
    throw new HarnessAdapterError("native_request_origin_unconfirmed","The native callback does not belong to the admitted prompt and tool.");
}
