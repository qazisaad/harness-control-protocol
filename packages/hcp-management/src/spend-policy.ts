import { z } from "zod";
import type { ClaudeMemberSpend } from "./claude-admin.js";

const integer = z.string().regex(/^(0|[1-9][0-9]*)$/).max(18);
export const spendIncreasePolicySchema = z.object({
  threshold_percent: z.number().int().min(1).max(100).default(95),
  increment_minor: integer.refine(value => BigInt(value) > 0n, "Increment must be positive."),
  maximum_minor: integer,
  organization_remaining_minor: integer,
}).strict();
export type SpendIncreasePolicy = z.infer<typeof spendIncreasePolicySchema>;
export type SpendIncreaseDecision =
  | { kind: "keep" | "review" | "budget_exhausted"; reason: string }
  | { kind: "recommend_increase"; amount_minor: string; reason: string };

/** Uses decimal minor units exactly, including the fractional spending returned by Claude. */
export function evaluateSpendIncrease(spend: Pick<ClaudeMemberSpend, "amount" | "period_to_date_spend">, input: SpendIncreasePolicy): SpendIncreaseDecision {
  const policy: SpendIncreasePolicy = spendIncreasePolicySchema.parse(input);
  const current: string | null = integer.nullable().parse(spend.amount);
  const spent = z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/).max(100).parse(spend.period_to_date_spend);
  if (current === null) return { kind: "keep", reason: "This member has no finite spend limit." };
  if (BigInt(current) === 0n) return { kind: "review", reason: "Usage credits are disabled; an administrator must authorize enabling them." };
  const [whole, fraction = ""] = spent.split(".");
  const scale: bigint = 10n ** BigInt(fraction.length);
  const used: bigint = BigInt(whole! + fraction);
  if (used * 100n < BigInt(current) * scale * BigInt(policy.threshold_percent)) return { kind: "keep", reason: "Spending is below the configured threshold." };
  const headroom: bigint = BigInt(policy.maximum_minor) - BigInt(current);
  const increase: bigint = [BigInt(policy.increment_minor), headroom, BigInt(policy.organization_remaining_minor)].reduce((a, b) => a < b ? a : b);
  if (increase <= 0n || (BigInt(current) + increase) * scale <= used) return { kind: "budget_exhausted", reason: "The authorized member or organization budget cannot provide additional headroom." };
  return { kind: "recommend_increase", amount_minor: (BigInt(current) + increase).toString(), reason: "Increase is bounded by the member ceiling and remaining organization budget." };
}
