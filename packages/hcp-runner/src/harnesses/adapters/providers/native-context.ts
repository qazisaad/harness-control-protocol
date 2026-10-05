import {harnessContextUsageSchema, type HarnessContextUsage, type HarnessModelSelection} from "@harness-control/protocol";

export function unavailableContext(selection: HarnessModelSelection, reason: string): HarnessContextUsage {
  return harnessContextUsageSchema.parse({status: "unavailable", selection: structuredClone(selection), reason,
    source: "hcp.context.lifecycle", measurement_scope: "retained_conversation", observed_at: new Date().toISOString()});
}

/** Native request counters describe the latest model request, never accumulated billing. */
export function measuredContext(selection: HarnessModelSelection, source: string, usedTokens: number,
  capacityTokens?: number | null, scope: HarnessContextUsage["measurement_scope"] = "last_request"): HarnessContextUsage {
  const result = harnessContextUsageSchema.safeParse({status: "measured", selection: structuredClone(selection), source,
    measurement_scope: scope, observed_at: new Date().toISOString(), used_tokens: usedTokens,
    ...(capacityTokens != null && capacityTokens > 0 ? {capacity_tokens: capacityTokens} : {})});
  return result.success ? result.data : {...unavailableContext(selection, "invalid_native_measurement"), source};
}
