import {z} from "zod";

const identity = z.string().min(1).max(512);
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** Explicit native job admission; product slash commands and run IDs stay in the consumer. */
export const harnessNativeGoalStartSchema = z.object({action: z.literal("start"),
  objective: z.string().min(1).max(128 * 1024), token_budget: counter.positive().optional()}).strict();
export type HarnessNativeGoalStart = z.infer<typeof harnessNativeGoalStartSchema>;
export const harnessNativeGoalResumeSchema = z.object({action: z.literal("resume"), expected_native_created_at: counter}).strict();
export const harnessNativeGoalRequestSchema = z.discriminatedUnion("action", [harnessNativeGoalStartSchema, harnessNativeGoalResumeSchema]);
export type HarnessNativeGoalRequest = z.infer<typeof harnessNativeGoalRequestSchema>;
export const harnessNativeGoalRecordSchema = z.object({source: z.literal("native"), scope: z.literal("root"),
  admission_id: identity, origin_turn_id: identity, native_reference: identity,
  /** Provider's native generation value, not a standardized clock unit or application-minted native job ID. */
  native_created_at: counter, native_updated_at: counter,
  objective: z.string().min(1).max(128 * 1024),
  status: z.enum(["active", "paused", "blocked", "usage_limited", "budget_limited", "complete"]),
  tokens_used: counter, time_used_seconds: counter, token_budget: counter.positive().optional(),
}).strict();
export type HarnessNativeGoalRecord = z.infer<typeof harnessNativeGoalRecordSchema>;
export const harnessNativeGoalObservationSchema = harnessNativeGoalRecordSchema.omit({admission_id: true, origin_turn_id: true});
export type HarnessNativeGoalObservation = z.infer<typeof harnessNativeGoalObservationSchema>;
export const harnessNativeGoalOperationSchema = z.discriminatedUnion("action", [
  z.object({kind: z.literal("goal"), action: z.literal("read")}).strict(),
  z.object({kind: z.literal("goal"), action: z.literal("pause"), expected_native_created_at: counter}).strict(),
  z.object({kind: z.literal("goal"), action: z.literal("clear"), expected_native_created_at: counter}).strict(),
]);
export type HarnessNativeGoalOperation = z.infer<typeof harnessNativeGoalOperationSchema>;
export const harnessNativeGoalResultSchema = z.discriminatedUnion("action", [
  z.object({action: z.literal("read"), source: z.literal("native"), native_reference: identity,
    goal: harnessNativeGoalObservationSchema.nullable()}).strict(),
  z.object({action: z.literal("pause"), source: z.literal("native"), native_reference: identity,
    target_native_created_at: counter, goal: harnessNativeGoalObservationSchema.extend({status: z.literal("paused")})}).strict(),
  z.object({action: z.literal("clear"), source: z.literal("native"), native_reference: identity,
    target_native_created_at: counter, goal: z.null()}).strict(),
]).superRefine((value, context) => {
  if (value.goal && value.goal.native_reference !== value.native_reference)
    context.addIssue({code: "custom", message: "Native goal readback changed its conversation."});
  if (value.action === "pause" && value.goal.native_created_at !== value.target_native_created_at)
    context.addIssue({code: "custom", message: "Native goal pause readback changed its target generation."});
});
export type HarnessNativeGoalResult = z.infer<typeof harnessNativeGoalResultSchema>;

/** Conversation-native transcript state; no execution admission, generation or completion claim. */
export const harnessNativeGoalTranscriptSchema = z.object({source: z.literal("native_transcript"), scope: z.literal("session"),
  native_reference: identity, native_message_reference: identity, kind: z.enum(["command", "stop_feedback"]),
  goal: z.object({objective: z.string().min(1).max(128 * 1024), status: z.literal("active"),
    observed_checks: counter, native_checks: counter.optional(), last_check: z.string().max(8192).optional()}).strict().nullable(),
}).strict();
export type HarnessNativeGoalTranscript = z.infer<typeof harnessNativeGoalTranscriptSchema>;
