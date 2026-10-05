import {z} from "zod";
import {harnessContentReferenceSchema} from "./content.js";

/** Values stay typed at the transport boundary even when their full bytes are retained separately. */
export const harnessHistoryValueSchema = z.discriminatedUnion("storage", [
  z.object({storage: z.literal("inline"), value: z.json()}).strict(),
  z.object({storage: z.literal("reference"), content_ref: harnessContentReferenceSchema, preview: z.string().max(8192).optional()}).strict(),
  z.object({storage: z.literal("unavailable"), reason: z.enum(["not_retained", "unsupported_native_shape"])}).strict(),
]);
export const harnessHistoryFileChangeSchema = z.object({path: z.string().min(1).max(4096),
  change_type: z.enum(["added", "modified", "deleted", "renamed", "unknown"]), previous_path: z.string().min(1).max(4096).optional(),
  diff: z.string().max(8 * 1024 * 1024).optional()}).strict();
export const harnessHistoryFileChangesSchema = z.array(harnessHistoryFileChangeSchema).max(10_000);
const base = z.object({id: z.string().min(1).max(512),
  status: z.enum(["pending", "running", "waiting", "completed", "failed", "cancelled", "unknown"])});
export const harnessPortableHistoryItemSchema = z.discriminatedUnion("type", [
  base.extend({type: z.literal("message"), role: z.enum(["user", "assistant", "system", "developer", "unknown"]), body: harnessHistoryValueSchema}).strict(),
  base.extend({type: z.literal("reasoning"), body: harnessHistoryValueSchema}).strict(),
  base.extend({type: z.literal("tool_call"), tool_name: z.string().min(1).max(512), arguments: harnessHistoryValueSchema}).strict(),
  base.extend({type: z.literal("tool_result"), call_id: z.string().min(1).max(512), result: harnessHistoryValueSchema}).strict(),
  base.extend({type: z.literal("command"), command: harnessHistoryValueSchema, output: harnessHistoryValueSchema.optional(),
    cwd: z.string().max(4096).optional(), exit_code: z.number().int().optional()}).strict(),
  base.extend({type: z.literal("file_change"), changes: harnessHistoryValueSchema}).strict(),
  base.extend({type: z.literal("plan"), body: harnessHistoryValueSchema}).strict(),
  base.extend({type: z.literal("context_marker"), body: harnessHistoryValueSchema}).strict(),
  base.extend({type: z.literal("extension"), namespace: z.string().min(1).max(128), name: z.string().min(1).max(512), body: harnessHistoryValueSchema}).strict(),
]);
export const harnessPortableHistoryItemsSchema = z.array(harnessPortableHistoryItemSchema).max(10_000);
export type HarnessHistoryValue = z.infer<typeof harnessHistoryValueSchema>;
export type HarnessPortableHistoryItem = z.infer<typeof harnessPortableHistoryItemSchema>;
