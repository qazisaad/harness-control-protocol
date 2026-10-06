import {z} from "zod";
import {harnessRateLimitObservationSchema, type HarnessRateLimitObservation} from "@harness-control/protocol";

const status = z.enum(["allowed", "allowed_warning", "rejected"]);
const nativeInfo = z.object({status, resetsAt: z.number().finite().optional(),
  rateLimitType: z.enum(["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet", "seven_day_overage_included", "overage"]).optional(),
  utilization: z.number().finite().nonnegative().optional(), overageStatus: status.optional(), overageResetsAt: z.number().finite().optional(),
  overageDisabledReason: z.enum(["overage_not_provisioned", "org_level_disabled", "org_level_disabled_until", "out_of_credits", "seat_tier_level_disabled",
    "member_level_disabled", "seat_tier_zero_credit_limit", "group_zero_credit_limit", "member_zero_credit_limit", "org_service_level_disabled",
    "no_limits_configured", "fetch_error", "unknown"]).optional(), isUsingOverage: z.boolean().optional(), overageInUse: z.boolean().optional()});
const timestamp = (seconds: number | undefined): string | undefined => seconds !== undefined && seconds >= 0 && seconds < 253402300800
  ? new Date(seconds * 1000).toISOString() : undefined;
/** Whitelisted native observations; absent/reset-invalid fields do not become a guessed quota. */
export function claudeRateLimitObservation(value: unknown, observedAt = new Date().toISOString()): HarnessRateLimitObservation | undefined {
  const parsed = nativeInfo.safeParse(value); if (!parsed.success) return undefined;
  const info = parsed.data, reset = timestamp(info.resetsAt), overageReset = timestamp(info.overageResetsAt);
  if (info.isUsingOverage !== undefined && info.overageInUse !== undefined && info.isUsingOverage !== info.overageInUse) return undefined;
  const inUse = info.isUsingOverage ?? info.overageInUse;
  return harnessRateLimitObservationSchema.parse({source: "native", native_source: "claude.sdk.rate_limit_event", scope: "native_session", observed_at: observedAt,
    windows: [{window_id: info.rateLimitType ?? "unknown", status: info.status,
      ...(info.utilization !== undefined ? {utilization: info.utilization} : {}), ...(reset ? {resets_at: reset} : {})}],
    ...(info.overageStatus !== undefined || inUse !== undefined || overageReset !== undefined || info.overageDisabledReason !== undefined ? {
      overage: {...(info.overageStatus !== undefined ? {status: info.overageStatus} : {}), ...(inUse !== undefined ? {in_use: inUse} : {}),
        ...(overageReset ? {resets_at: overageReset} : {}), ...(info.overageDisabledReason ? {disabled_reason: info.overageDisabledReason} : {})}} : {}),
  });
}
