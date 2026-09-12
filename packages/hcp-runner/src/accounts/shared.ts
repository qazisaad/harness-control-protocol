import { createHash } from "node:crypto";
import type { AccountIdentity, AccountUsageObservation } from "@harness-control/protocol";
import type { ProviderInstanceConfig } from "../config/index.js";

export type AccountReadContext = { provider: ProviderInstanceConfig; hostId: string; signal: AbortSignal };
export type AccountCollector = (context: AccountReadContext) => Promise<AccountUsageObservation>;

export function accountIdentity(context: AccountReadContext, subject: string | undefined, scope?: string): AccountIdentity {
  const configuredScope: string | undefined = context.provider.account_usage?.scope_id;
  const effectiveScope: string | undefined = scope ?? configuredScope;
  const source = !subject || !effectiveScope ? "local" : scope ? "provider" : "operator";
  const key: string = createHash("sha256").update(JSON.stringify([
    context.provider.driver_kind, subject?.trim().toLowerCase() ?? "unknown",
    source === "local" ? [context.hostId, context.provider.id] : effectiveScope,
  ])).digest("hex");
  return {
    key, provider: context.provider.driver_kind, scope_source: source,
    label: context.provider.display_name ?? context.provider.id,
  };
}

export function unavailable(reason: Extract<AccountUsageObservation, { status: "unavailable" }>["reason"], message: string): AccountUsageObservation {
  return { status: "unavailable", observed_at: new Date().toISOString(), reason, message };
}
