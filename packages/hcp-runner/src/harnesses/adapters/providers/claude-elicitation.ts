import type {OnElicitation} from "@anthropic-ai/claude-agent-sdk";
import {z} from "zod";
import type {NativeInteractions} from "../../native-interactions.js";

type Owner = {threadId: string; turnId?: string; interactions: NativeInteractions; signal: AbortSignal; serverNames: readonly string[]};
/** SDK elicitations carry no agent/turn identity. Never route an unbound background request to a later root. */
export function claudeElicitation(resolve: () => Owner | undefined): OnElicitation {
  return async (request, options) => {
    const owner = resolve();
    if (!owner || !owner.serverNames.includes(request.serverName) || request.mode === "url" || !request.requestedSchema) return {action: "cancel"};
    const value = await owner.interactions.form({threadId: owner.threadId, ...(owner.turnId ? {turnId: owner.turnId} : {}), itemId: options.requestId}, request.message,
      request.requestedSchema, AbortSignal.any([owner.signal, options.signal]));
    return value === null ? {action: "cancel"} : {action: "accept", content: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).parse(value)};
  };
}
