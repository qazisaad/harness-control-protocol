import {z} from "zod";

const tokens = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const identity = z.string().min(1).max(512);
const base = z.object({
  actor: z.literal("root"), scope: z.literal("turn"),
  source: z.string().min(1).max(128), native_reference: identity,
  native_execution_reference: identity.optional(),
});
const counters = {
  input_tokens: tokens.optional(), output_tokens: tokens.optional(), total_tokens: tokens.optional(),
  cached_input_tokens: tokens.optional(), cache_creation_input_tokens: tokens.optional(),
  reasoning_output_tokens: tokens.optional(), cost_usd: z.number().finite().nonnegative().optional(),
};
/** Main-agent billing for an owned native root, separate from context occupancy and child totals.
 * Cache counters are subsets of input; reasoning is a subset of output. A physical execution
 * reference is included only when the native result identifies that execution unambiguously.
 */
export const harnessRootUsageSnapshotSchema = z.discriminatedUnion("status", [
  base.extend({...counters, status: z.literal("complete"), input_tokens: tokens, output_tokens: tokens}).strict(),
  base.extend({...counters, status: z.literal("partial")}).strict(),
  base.extend({status: z.literal("unavailable")}).strict(),
]);
export type HarnessRootUsageSnapshot = z.infer<typeof harnessRootUsageSnapshotSchema>;
