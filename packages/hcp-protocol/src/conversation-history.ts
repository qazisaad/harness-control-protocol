import {z} from "zod";
import {harnessPortableHistoryItemSchema} from "./portable-history.js";
import {harnessContentReferenceSchema} from "./content.js";

export const nativeConversationHistorySchema = z.object({history_hash: z.string().regex(/^[a-f0-9]{64}$/),
  turn_count: z.number().int().nonnegative(), truncated: z.boolean(),
  next_cursor: z.string().min(1).max(1024).optional(),
  turns: z.array(z.object({id: z.string(), status: z.string(), items: z.array(z.record(z.string(), z.json())),
    items_ref: harnessContentReferenceSchema.optional(),
    portable_items: z.array(harnessPortableHistoryItemSchema).max(100).optional(), portable_items_ref: harnessContentReferenceSchema.optional(),
    portable_fidelity: z.enum(["full", "partial"]).optional()}).strict()).max(100)}).strict();
export type NativeConversationHistory = z.infer<typeof nativeConversationHistorySchema>;
