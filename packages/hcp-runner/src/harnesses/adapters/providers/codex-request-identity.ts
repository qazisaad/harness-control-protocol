import {z} from "zod";
import {harnessNativeRequestIdentitySchema, type HarnessNativeRequestIdentity} from "@harness-control/protocol";
import type {RpcRequestContext} from "./codex-rpc.js";

/** The transport supplies the native request ID; params cannot impersonate that transport context. */
export function codexRequestIdentity(params: unknown, context?: RpcRequestContext): HarnessNativeRequestIdentity | undefined {
  if (!context) return;
  const native = z.object({threadId: z.string().min(1).max(512), turnId: z.string().min(1).max(512),
    itemId: z.string().min(1).max(512).optional()}).parse(params);
  return harnessNativeRequestIdentitySchema.parse({source: "native", native_reference: native.threadId,
    request_reference: String(context.requestId), execution_reference: native.turnId,
    ...(native.itemId ? {item_reference: native.itemId} : {})});
}
