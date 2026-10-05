import {z} from "zod";
import {harnessContentReferenceSchema} from "./content.js";

export const harnessNativeWorkObservationSchema = z.object({
  work_id: z.string().min(1).max(512), native_reference: z.string().min(1).max(512),
  origin_turn_id: z.string().min(1).max(512), parent_work_id: z.string().min(1).max(512).optional(),
  kind: z.enum(["agent", "task", "command"]), background: z.boolean(),
  status: z.enum(["running", "waiting", "completed", "failed", "cancelled", "unknown"]),
  supports_cancel: z.boolean(), summary: z.string().max(2048).optional(),
  content_ref: harnessContentReferenceSchema.optional(),
}).strict();
export const harnessNativeWorkRecordSchema = harnessNativeWorkObservationSchema.extend({
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  control: z.object({command_id: z.string().min(1).max(512), request_hash: z.string().regex(/^[a-f0-9]{64}$/),
    action: z.literal("cancel"), phase: z.enum(["pending", "accepted"])}).strict().optional(),
}).strict();
export type HarnessNativeWorkObservation = z.infer<typeof harnessNativeWorkObservationSchema>;
export type HarnessNativeWorkRecord = z.infer<typeof harnessNativeWorkRecordSchema>;
export function isNativeWorkTerminal(status: HarnessNativeWorkRecord["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export const harnessNativeWorkOperationSchema = z.discriminatedUnion("action", [
  z.object({kind: z.literal("work"), action: z.literal("read"), cursor: z.string().min(1).max(1024).optional(), limit: z.number().int().min(1).max(32).optional()}).strict(),
  ...(["cancel", "retire"] as const).map(action => z.object({kind: z.literal("work"), action: z.literal(action),
    work_id: z.string().min(1).max(512), expected_revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)}).strict()),
]);
export const harnessNativeWorkResultSchema = z.discriminatedUnion("action", [
  z.object({action: z.literal("read"), owner_status: z.enum(["active", "unavailable"]), observation_hash: z.string().regex(/^[a-f0-9]{64}$/),
    closure_unconfirmed: z.literal(true).optional(),
    total_count: z.number().int().nonnegative().max(128), next_cursor: z.string().min(1).max(1024).optional(), items: z.array(z.object({
    work: harnessNativeWorkRecordSchema, owner_status: z.enum(["active", "unavailable"])}).strict()).max(32)}).strict(),
  z.object({action: z.literal("cancel"), work_id: z.string().min(1).max(512), accepted: z.literal(true), already_terminal: z.literal(true).optional()}).strict(),
  z.object({action: z.literal("retire"), work_id: z.string().min(1).max(512), retired: z.literal(true)}).strict(),
]);
