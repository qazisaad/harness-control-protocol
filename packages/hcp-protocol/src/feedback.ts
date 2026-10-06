import {z} from "zod";

export const harnessNativeFeedbackCapabilitiesSchema = z.object({owner: z.literal("live_conversation"),
  classifications: z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)).min(1).max(16)
    .refine(value => new Set(value).size === value.length, "Feedback classifications must be unique."),
  diagnostics: z.boolean()}).strict();
export const harnessNativeFeedbackOperationSchema = z.object({kind: z.literal("feedback"),
  classification: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  reason: z.string().min(1).max(16 * 1024).optional(), include_diagnostics: z.boolean()}).strict();
export const harnessNativeFeedbackResultSchema = z.object({source: z.literal("native"),
  feedback_id: z.string().min(1).max(512), classification: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  diagnostics_requested: z.boolean()}).strict();
export type HarnessNativeFeedbackCapabilities = z.infer<typeof harnessNativeFeedbackCapabilitiesSchema>;
export type HarnessNativeFeedbackOperation = z.infer<typeof harnessNativeFeedbackOperationSchema>;
export type HarnessNativeFeedbackResult = z.infer<typeof harnessNativeFeedbackResultSchema>;
