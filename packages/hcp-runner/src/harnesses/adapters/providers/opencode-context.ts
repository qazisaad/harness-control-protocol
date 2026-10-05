import {z} from "zod";
import type {HarnessContextUsage, HarnessModelSelection} from "@harness-control/protocol";
import {measuredContext, unavailableContext} from "./native-context.js";

const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const identitySchema = z.object({sessionID: z.string(), parentID: z.string(), role: z.literal("assistant"),
  providerID: z.string(), modelID: z.string(), variant: z.string().optional(), summary: z.boolean().optional()});
const tokensSchema = z.object({total: counter.optional(), input: counter, output: counter,
  cache: z.object({read: counter, write: counter})});

/** The final prompt response carries the last native request's counters, not summed turn billing.
 * Native calculation: opencode v1.3.15 session/overflow.ts; processor.ts replaces assistant.tokens per finish-step.
 */
export function openCodeContext(info: unknown, sessionId: string, promptId: string, selection: HarnessModelSelection): HarnessContextUsage {
  const unavailable = (reason: string) => ({...unavailableContext(selection, reason), source: "opencode.prompt.response"});
  const identity = identitySchema.safeParse(info);
  if (!identity.success || identity.data.sessionID !== sessionId || identity.data.parentID !== promptId || identity.data.summary)
    return unavailable("native_context_binding_unconfirmed");
  if (`${identity.data.providerID}/${identity.data.modelID}` !== selection.model ||
      (selection.options ?? []).some(option => option.id !== "variant" || option.value !== identity.data.variant))
    return unavailable("native_context_selection_unconfirmed");
  const parsed = z.object({tokens: tokensSchema}).safeParse(info);
  if (!parsed.success) return unavailable("native_context_measurement_unavailable");
  const tokens = parsed.data.tokens;
  // Match the native context display. Reasoning is not added again to output tokens.
  const count = tokens.total || tokens.input + tokens.output + tokens.cache.read + tokens.cache.write;
  return measuredContext(selection, "opencode.prompt.response", count);
}
