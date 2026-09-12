import { z } from "zod";
import { accountUsageAvailableSchema, type AccountUsageView, type AccountLimit } from "@harness-control/protocol";

const money = z.number().int().nonnegative().safe();
const timestamp = z.iso.datetime({ offset: true });
export const capacityPolicySchema = z.object({
  threshold_percent: z.number().positive().max(100).default(95),
  reset_grace_minutes: z.number().int().nonnegative().max(1440).default(30),
  max_observation_age_seconds: z.number().int().positive().max(86400).default(300),
  renewal_notice_days: z.number().int().nonnegative().max(90).default(7),
}).strict();
export type CapacityPolicy = z.infer<typeof capacityPolicySchema>;

export const capacityQuoteSchema = z.object({
  id: z.string().min(1), account_key: z.string().min(1),
  kind: z.enum(["extra_usage", "upgrade"]), currency: z.string().regex(/^[A-Z]{3}$/),
  incremental_cost_minor: money,
  valid_until: timestamp,
  coverage: z.array(z.object({ limit_id: z.string().min(1), resets_at: timestamp }).strict()).min(1),
  description: z.string().min(1).max(512),
}).strict();
export type CapacityQuote = z.infer<typeof capacityQuoteSchema>;

export const capacityBudgetSchema = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/),
  account_remaining_minor: money, organization_remaining_minor: money,
}).strict();
export type CapacityBudget = z.infer<typeof capacityBudgetSchema>;

export type CapacityDecision = {
  id: string;
  account_key: string;
  kind: "healthy" | "refresh" | "wait_for_reset" | "review_capacity" | "recommend_extra_usage" | "recommend_upgrade" | "budget_exhausted";
  reason: string;
  limit_ids: string[];
  quote?: CapacityQuote;
};

/** Quotes are all-in incremental charges for the exact quota windows, supplied by the billing owner. */
export function evaluateCapacity(input: {
  view: AccountUsageView; policy: CapacityPolicy; now: Date;
  quotes?: readonly CapacityQuote[]; budget?: CapacityBudget;
}): CapacityDecision {
  const policy: CapacityPolicy = capacityPolicySchema.parse(input.policy);
  const observation = accountUsageAvailableSchema.parse(input.view.observation);
  const now: number = input.now.getTime();
  if (!Number.isFinite(now)) throw new Error("Invalid evaluation time.");
  const accountKey: string = observation.account.key;
  const limits: AccountLimit[] = observation.limits;
  const decision = (kind: CapacityDecision["kind"], reason: string, selected: AccountLimit[] = [], quote?: CapacityQuote): CapacityDecision => ({
    id: JSON.stringify([accountKey, kind, selected.map(limit => [limit.id, limit.resets_at ?? observation.observed_at]), quote?.id ?? null]),
    account_key: accountKey, kind, reason, limit_ids: selected.map(limit => limit.id), ...(quote ? { quote } : {}),
  });
  const age: number = now - Date.parse(observation.observed_at);
  if (input.view.freshness !== "fresh" || age < 0 || age > policy.max_observation_age_seconds * 1000) {
    return decision("refresh", "A fresh successful account reading is required before evaluating capacity.");
  }
  if (!limits.length || limits.some(limit => limit.used_percent === undefined || !limit.resets_at || Date.parse(limit.resets_at) <= now)) {
    return decision("refresh", "Some quota values or reset times are unavailable or expired; do not assume zero usage.");
  }
  const reached: AccountLimit[] = limits.filter(limit => limit.used_percent! >= policy.threshold_percent);
  if (!reached.length) return decision("healthy", "All reported limits are below the configured threshold.");
  const urgent: AccountLimit[] = reached.filter(limit => Date.parse(limit.resets_at!) - now > policy.reset_grace_minutes * 60_000);
  if (!urgent.length) return decision("wait_for_reset", "The affected limits reset within the configured waiting period.", reached);
  if (!input.budget) return decision("review_capacity", "Near a limit. Supply verified billing quotes and remaining account/organization budgets.", urgent);
  const budget: CapacityBudget = capacityBudgetSchema.parse(input.budget);
  const eligible: CapacityQuote[] = (input.quotes ?? []).map(quote => capacityQuoteSchema.parse(quote)).filter(quote =>
    quote.account_key === accountKey && quote.currency === budget.currency && Date.parse(quote.valid_until) > now
    && urgent.every(limit => quote.coverage.some(coverage => coverage.limit_id === limit.id && coverage.resets_at === limit.resets_at)),
  );
  if (!eligible.length) return decision("review_capacity", "No current, comparable quote covers all affected limit windows.", urgent);
  const affordable: CapacityQuote[] = eligible.filter(quote => quote.incremental_cost_minor <= Math.min(budget.account_remaining_minor, budget.organization_remaining_minor));
  affordable.sort((a, b) => a.incremental_cost_minor - b.incremental_cost_minor || a.id.localeCompare(b.id));
  const quote: CapacityQuote | undefined = affordable[0];
  if (!quote) return decision("budget_exhausted", "Available capacity options exceed the remaining account or organization budget.", urgent);
  return decision(quote.kind === "upgrade" ? "recommend_upgrade" : "recommend_extra_usage", `Lowest quoted incremental charge covering the affected windows: ${quote.description}`, urgent, quote);
}

export const renewalContractSchema = z.object({
  account_key: z.string().min(1), current_plan: z.string().min(1), baseline_plan: z.string().min(1),
  currency: z.string().regex(/^[A-Z]{3}$/),
  current_next_period_cost_minor: money,
  baseline_next_period_cost_minor: money,
  baseline_expected_extra_usage_minor: money.optional(),
  renewal_at: timestamp, change_deadline_at: timestamp,
}).strict().refine(value => Date.parse(value.change_deadline_at) <= Date.parse(value.renewal_at), "Change deadline must not follow renewal.");
export type RenewalContract = z.infer<typeof renewalContractSchema>;
export type RenewalDecision = { kind: "not_due" | "review" | "keep" | "recommend_baseline" | "deadline_missed"; reason: string; effective_at: string };

export function evaluateRenewal(input: RenewalContract, policyInput: CapacityPolicy, now: Date): RenewalDecision {
  const contract: RenewalContract = renewalContractSchema.parse(input);
  const policy: CapacityPolicy = capacityPolicySchema.parse(policyInput);
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid evaluation time.");
  const result = (kind: RenewalDecision["kind"], reason: string): RenewalDecision => ({ kind, reason, effective_at: contract.renewal_at });
  if (now.getTime() >= Date.parse(contract.change_deadline_at)) return result("deadline_missed", "Reconcile the actual subscription before scheduling another change.");
  if (Date.parse(contract.change_deadline_at) - now.getTime() > policy.renewal_notice_days * 86400_000) return result("not_due", "The subscription change deadline is outside the review window.");
  if (contract.current_plan === contract.baseline_plan) return result("keep", "This account already uses its baseline plan.");
  if (contract.baseline_expected_extra_usage_minor === undefined) return result("review", "Expected extra usage on the baseline plan is unknown.");
  const baselineCost: number = contract.baseline_next_period_cost_minor + contract.baseline_expected_extra_usage_minor;
  if (!Number.isSafeInteger(baselineCost)) throw new Error("Renewal cost exceeds supported precision.");
  return baselineCost < contract.current_next_period_cost_minor
    ? result("recommend_baseline", "The baseline plan plus forecast extra usage costs less for the next billing period.")
    : result("keep", "The baseline plan would not reduce forecast cost for the next billing period.");
}
