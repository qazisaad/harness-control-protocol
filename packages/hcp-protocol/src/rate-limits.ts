import {z} from "zod";

const status = z.enum(["allowed", "allowed_warning", "rejected"]);
export const harnessRateLimitObservationSchema = z.object({
  source: z.literal("native"), native_source: z.string().min(1).max(128), scope: z.literal("native_session"),
  observed_at: z.iso.datetime(),
  windows: z.array(z.object({window_id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), status,
    utilization: z.number().finite().nonnegative().optional(), resets_at: z.iso.datetime().optional()}).strict()).min(1).max(16),
  overage: z.object({status: status.optional(), in_use: z.boolean().optional(), resets_at: z.iso.datetime().optional(),
    disabled_reason: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/).optional()}).strict().optional(),
}).strict();
export type HarnessRateLimitObservation = z.infer<typeof harnessRateLimitObservationSchema>;
