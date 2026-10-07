import {codexRequestIdentity} from "./codex-request-identity.js";
import type {RpcRequestContext} from "./codex-rpc.js";
import {z} from "zod";
import type {NativeInteractions} from "../../native-interactions.js";
import {HarnessAdapterError} from "../types.js";

/** Native cached approval is distinct from a persistent exec-policy amendment. */
export async function codexApproval(interactions: NativeInteractions, params: unknown,
  kind: "command" | "file_change", signal: AbortSignal, interactive: boolean, context?: RpcRequestContext): Promise<{decision:string}> {
  const request = z.object({availableDecisions:z.array(z.json()).nullish()}).passthrough().parse(params);
  const remembers = interactive && request.availableDecisions?.includes("acceptForSession");
  const answer = await interactions.approval({...request, ...(request.availableDecisions ? {
    availableDecisions:request.availableDecisions.map(value=>value==="acceptForSession" && remembers ? "accept_for_session" : value),
  } : {})}, kind, signal, codexRequestIdentity(params, context));
  if (answer.decision === "accept_for_session") {
    if (!remembers) throw new HarnessAdapterError("native_session_decision_unavailable", "Native session acceptance was not offered.");
    return {decision:"acceptForSession"};
  }
  return answer;
}
