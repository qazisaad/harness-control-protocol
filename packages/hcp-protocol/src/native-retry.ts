import {z} from "zod";

/** A native retry notice without an invented app-turn or child identity. */
export const harnessNativeRetryObservationSchema = z.object({
  source: z.literal("native"), native_source: z.string().min(1).max(128),
  item_id: z.string().min(1).max(512), scope: z.literal("session"), correlation: z.literal("unattributed"),
  observed_at: z.iso.datetime(), status: z.literal("retrying"),
  attempt: z.number().int().min(1).max(2147483647),
  max_retries: z.number().int().min(0).max(2147483647),
  retry_delay_ms: z.number().int().min(0).max(2147483647),
  http_status: z.number().int().min(100).max(599).nullable(),
  native_error_code: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.-]+$/),
  no_response: z.object({waited_ms: z.number().int().min(0).max(2147483647),
    retry_wait_ms: z.number().int().min(0).max(2147483647)}).strict().optional(),
}).strict();
export type HarnessNativeRetryObservation = z.infer<typeof harnessNativeRetryObservationSchema>;
