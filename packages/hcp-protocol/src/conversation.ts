import { z } from "zod";
import {harnessContentChunkSchema} from "./content.js";
import {harnessNativeWorkOperationSchema, harnessNativeWorkResultSchema} from "./native-work.js";
import {harnessPortableHistoryItemSchema} from "./portable-history.js";
import {harnessContentReferenceSchema} from "./content.js";
import {harnessInputFileOperationSchema, harnessInputFileResultSchema} from "./input-file.js";

export const hcpConversationRequestPayloadSchema = z.object({session_id: z.string().min(1).max(512),
  operation: z.discriminatedUnion("kind", [z.object({kind: z.literal("read"), cursor: z.string().min(1).max(1024).optional(), limit: z.number().int().min(1).max(100).optional()}).strict(),
    z.object({kind: z.literal("inject"), expected_history_hash: z.string().regex(/^[a-f0-9]{64}$/),
      messages: z.array(z.object({role: z.enum(["user", "assistant"]), content: z.string().min(1).max(128 * 1024)}).strict()).min(1).max(100),
    }).strict().refine(value => value.messages.reduce((size, message) => size + message.content.length, 0) <= 128 * 1024,
      "Injected context exceeds the bounded text limit."),
    z.object({kind: z.literal("rollback"), num_turns: z.number().int().min(1).max(100), expected_history_hash: z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
    z.object({kind: z.literal("steer"), turn_id: z.string().min(1).max(512), input: z.string().min(1).max(128 * 1024)}).strict(),
    z.object({kind: z.literal("fork"), target_session_id: z.string().min(1).max(512), continuation_group_key: z.string().min(1).max(512),
      expected_history_hash: z.string().regex(/^[a-f0-9]{64}$/), last_turn_id: z.string().min(1).max(512).optional()}).strict(),
    z.object({kind: z.literal("content"), content_id: z.string().regex(/^[a-f0-9]{64}$/), offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(64 * 1024).default(64 * 1024)}).strict(),
    z.object({kind: z.literal("retire")}).strict(), harnessNativeWorkOperationSchema, harnessInputFileOperationSchema])}).strict();
export const nativeConversationHistorySchema = z.object({history_hash: z.string().regex(/^[a-f0-9]{64}$/),
  turn_count: z.number().int().nonnegative(), truncated: z.boolean(),
  next_cursor: z.string().min(1).max(1024).optional(),
  turns: z.array(z.object({id: z.string(), status: z.string(), items: z.array(z.record(z.string(), z.json())),
    items_ref: harnessContentReferenceSchema.optional(),
    portable_items: z.array(harnessPortableHistoryItemSchema).max(100).optional(), portable_items_ref: harnessContentReferenceSchema.optional(),
    portable_fidelity: z.enum(["full", "partial"]).optional()}).strict()).max(100)}).strict();
export const hcpConversationResultPayloadSchema = z.object({command_id: z.string().min(1), session_id: z.string().min(1),
  operation: z.enum(["read", "rollback", "retire", "steer", "fork", "content", "work", "inject", "input_file"]), filesystem_undo: z.literal(false),
  input_file: harnessInputFileResultSchema.optional(),
  injection: z.discriminatedUnion("outcome", [
    z.object({outcome: z.literal("applied"), message_count: z.number().int().min(1).max(100)}).strict(),
    z.object({outcome: z.literal("unsupported"), reason: z.literal("native_method_unavailable")}).strict(),
  ]).optional(),
  work: harnessNativeWorkResultSchema.optional(),
  content: harnessContentChunkSchema.optional(),
  native_reference: z.string().min(1).optional(),
  native_fresh: z.literal(true).optional(),
  turn_id: z.string().min(1).optional(),
  fork: z.object({session_id: z.string().min(1), continuation_group_key: z.string().min(1), native_reference: z.string().min(1)}).strict().optional(),
  history: nativeConversationHistorySchema.optional()}).strict().superRefine((result, context) => {
    const missing = (field: string) => context.addIssue({code: "custom", path: [field], message: `The ${result.operation} result requires ${field}.`});
    if (["read", "rollback"].includes(result.operation) && !result.history) missing("history");
    if (result.operation === "fork" && !result.fork) missing("fork");
    if (result.operation === "steer" && !result.turn_id) missing("turn_id");
    if (result.operation === "content" && !result.content) missing("content");
    if (result.operation === "work" && !result.work) missing("work");
    if (result.operation === "input_file" && !result.input_file) missing("input_file");
    if (result.operation !== "input_file" && result.input_file)
      context.addIssue({code: "custom", path: ["input_file"], message: "Only input-file results may carry file state."});
    if (result.operation === "inject" && !result.injection) missing("injection");
    if (result.operation !== "inject" && result.injection)
      context.addIssue({code: "custom", path: ["injection"], message: "Only injection results may carry an injection outcome."});
    if (result.native_fresh && !["fork", "rollback"].includes(result.operation))
      context.addIssue({code: "custom", path: ["native_fresh"], message: "Only fork or rollback may allocate a fresh native conversation."});
  });
export type HcpConversationRequestPayload = z.infer<typeof hcpConversationRequestPayloadSchema>;
export type HcpConversationResultPayload = z.infer<typeof hcpConversationResultPayloadSchema>;
