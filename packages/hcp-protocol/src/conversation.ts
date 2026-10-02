import { z } from "zod";

export const hcpConversationRequestPayloadSchema = z.object({session_id: z.string().min(1).max(512),
  operation: z.discriminatedUnion("kind", [z.object({kind: z.literal("read")}).strict(),
    z.object({kind: z.literal("rollback"), num_turns: z.number().int().min(1).max(100), expected_history_hash: z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
    z.object({kind: z.literal("retire")}).strict()])}).strict();
export const nativeConversationHistorySchema = z.object({history_hash: z.string().regex(/^[a-f0-9]{64}$/),
  turn_count: z.number().int().nonnegative(), truncated: z.boolean(),
  turns: z.array(z.object({id: z.string(), status: z.string(), items: z.array(z.record(z.string(), z.json()))}).strict()).max(100)}).strict();
export const hcpConversationResultPayloadSchema = z.object({command_id: z.string().min(1), session_id: z.string().min(1),
  operation: z.enum(["read", "rollback", "retire"]), filesystem_undo: z.literal(false),
  history: nativeConversationHistorySchema.optional()}).strict();
export type HcpConversationRequestPayload = z.infer<typeof hcpConversationRequestPayloadSchema>;
export type HcpConversationResultPayload = z.infer<typeof hcpConversationResultPayloadSchema>;
