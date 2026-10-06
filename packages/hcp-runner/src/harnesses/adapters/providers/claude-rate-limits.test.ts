import assert from "node:assert/strict";
import {test} from "node:test";
import {claudeRateLimitObservation} from "./claude-rate-limits.js";

test("Claude quota frames preserve native window and overage evidence without guessed account identity", () => {
  const observedAt = "2026-10-06T12:00:00.000Z";
  assert.deepEqual(claudeRateLimitObservation({status: "rejected", rateLimitType: "seven_day_sonnet", utilization: 1.2,
    resetsAt: 1_800_000_000, overageStatus: "allowed", overageInUse: true, overageResetsAt: 1_800_000_001,
    overageDisabledReason: "out_of_credits", apiKey: "fixture-secret", accountId: "unverified"}, observedAt), {
    source: "native", native_source: "claude.sdk.rate_limit_event", scope: "native_session", observed_at: observedAt,
    windows: [{window_id: "seven_day_sonnet", status: "rejected", utilization: 1.2, resets_at: "2027-01-15T08:00:00.000Z"}],
    overage: {status: "allowed", in_use: true, resets_at: "2027-01-15T08:00:01.000Z", disabled_reason: "out_of_credits"},
  });
  const partial = claudeRateLimitObservation({status: "allowed_warning", resetsAt: -1}, observedAt)!;
  assert.deepEqual(partial.windows, [{window_id: "unknown", status: "allowed_warning"}]); assert.equal(partial.overage, undefined);
});
test("malformed and contradictory quota frames cannot claim native limits", () => {
  for (const info of [{status: "unknown"}, {status: "allowed", utilization: NaN}, {status: "allowed", utilization: -1},
    {status: "allowed", rateLimitType: "foreign"}, {status: "allowed", isUsingOverage: true, overageInUse: false}])
    assert.equal(claudeRateLimitObservation(info), undefined);
});
