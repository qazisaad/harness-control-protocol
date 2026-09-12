import assert from "node:assert/strict";
import test from "node:test";
import type { AccountUsageView } from "@harness-control/protocol";
import { capacityPolicySchema, evaluateCapacity, evaluateRenewal, type CapacityQuote } from "./policy.js";
import { evaluateSpendIncrease } from "./spend-policy.js";

const now = new Date("2026-09-12T10:00:00Z");
const reset = "2026-09-15T00:00:00Z";
const policy = capacityPolicySchema.parse({});
const view: AccountUsageView = {
  account: { key: "a", provider: "codex", scope_source: "operator", label: "Work" },
  observation: { status: "available", observed_at: now.toISOString(), source: "codex_app_server",
    account: { key: "a", provider: "codex", scope_source: "operator", label: "Work" },
    limits: [{ id: "weekly", label: "Weekly", kind: "quota", used_percent: 95, resets_at: reset }],
  }, freshness: "fresh", sources: [{ host_id: "h", provider_instance_id: "p" }],
};
const quote = (id: string, cost: number, kind: CapacityQuote["kind"] = "upgrade"): CapacityQuote => ({
  id, account_key: "a", kind, currency: "USD", incremental_cost_minor: cost, valid_until: "2026-09-13T00:00:00Z",
  coverage: [{ limit_id: "weekly", resets_at: reset }], description: id,
});
const budget = { currency: "USD", account_remaining_minor: 5000, organization_remaining_minor: 10000 };

test("95 percent triggers review, not a purchase; comparable costs select the cheapest approved option", () => {
  assert.equal(evaluateCapacity({ view, policy, now }).kind, "review_capacity");
  const result = evaluateCapacity({ view, policy, now, budget, quotes: [quote("upgrade", 3000), quote("burst", 700, "extra_usage")] });
  assert.equal(result.kind, "recommend_extra_usage");
  assert.equal(result.quote?.id, "burst");
  assert.equal(result.id, evaluateCapacity({ view, policy, now, budget, quotes: [quote("burst", 700, "extra_usage")] }).id);
});

test("missing, failed, stale and reset-passed observations never produce a spend recommendation", () => {
  assert.equal(evaluateCapacity({ view: { ...view, freshness: "unavailable" }, policy, now, budget, quotes: [quote("buy", 1)] }).kind, "refresh");
  assert.equal(evaluateCapacity({ view, policy, now: new Date("2026-09-12T11:00:00Z") }).kind, "refresh");
  for (const limits of [[], [{ id: "weekly", label: "Weekly", kind: "quota" as const }], [{ ...view.observation.limits[0]!, resets_at: now.toISOString() }]]) {
    assert.equal(evaluateCapacity({ view: { ...view, observation: { ...view.observation, limits } }, policy, now }).kind, "refresh");
  }
});

test("short reset waits, different currency/window/account quotes and both budgets are respected", () => {
  const near = { ...view, observation: { ...view.observation, limits: [{ ...view.observation.limits[0]!, resets_at: "2026-09-12T10:10:00Z" }] } };
  assert.equal(evaluateCapacity({ view: near, policy, now }).kind, "wait_for_reset");
  const wrong = [{ ...quote("euro", 1), currency: "EUR" }, { ...quote("other", 1), account_key: "other" }, { ...quote("old", 1), coverage: [{ limit_id: "weekly", resets_at: "2026-09-14T00:00:00Z" }] }];
  assert.equal(evaluateCapacity({ view, policy, now, budget, quotes: wrong }).kind, "review_capacity");
  assert.equal(evaluateCapacity({ view, policy, now, budget: { ...budget, organization_remaining_minor: 10 }, quotes: [quote("buy", 20)] }).kind, "budget_exhausted");
});

test("renewal decisions use actual change deadlines and all-in forecast, not calendar-month resets", () => {
  const contract = { account_key: "a", current_plan: "premium", baseline_plan: "standard", currency: "USD",
    current_next_period_cost_minor: 12000, baseline_next_period_cost_minor: 2500,
    renewal_at: "2027-09-18T00:00:00Z", change_deadline_at: "2027-09-17T00:00:00Z",
  };
  assert.equal(evaluateRenewal(contract, policy, now).kind, "not_due");
  const reviewDate = new Date("2027-09-12T00:00:00Z");
  assert.equal(evaluateRenewal(contract, policy, reviewDate).kind, "review");
  assert.equal(evaluateRenewal({ ...contract, baseline_expected_extra_usage_minor: 1500 }, policy, reviewDate).kind, "recommend_baseline");
  assert.equal(evaluateRenewal({ ...contract, baseline_expected_extra_usage_minor: 15000 }, policy, reviewDate).kind, "keep");
  assert.equal(evaluateRenewal(contract, policy, new Date(contract.change_deadline_at)).kind, "deadline_missed");
});

test("spending policies preserve fractional minor-unit precision and never enable disabled usage implicitly", () => {
  const limits = { threshold_percent: 95, increment_minor: "10000", maximum_minor: "60000", organization_remaining_minor: "1000" };
  assert.equal(evaluateSpendIncrease({ amount: "50000", period_to_date_spend: "47499.999" }, limits).kind, "keep");
  assert.deepEqual(evaluateSpendIncrease({ amount: "50000", period_to_date_spend: "47500.001" }, limits), {
    kind: "recommend_increase", amount_minor: "51000", reason: "Increase is bounded by the member ceiling and remaining organization budget.",
  });
  assert.equal(evaluateSpendIncrease({ amount: "0", period_to_date_spend: "0" }, limits).kind, "review");
  assert.equal(evaluateSpendIncrease({ amount: null, period_to_date_spend: "900000" }, limits).kind, "keep");
  assert.equal(evaluateSpendIncrease({ amount: "60000", period_to_date_spend: "59000" }, limits).kind, "budget_exhausted");
});
