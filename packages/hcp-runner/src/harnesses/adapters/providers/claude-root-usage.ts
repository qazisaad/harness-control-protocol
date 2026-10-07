import {z} from "zod";
import type {HarnessRootUsageSnapshot} from "@harness-control/protocol";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const usageSchema = z.object({input_tokens: count.optional(), output_tokens: count.optional(),
  cache_read_input_tokens: count.optional(), cache_creation_input_tokens: count.optional(),
  output_tokens_details: z.object({thinking_tokens: count.optional()}).optional()});

/** Result.usage is the root's own usage. modelUsage and total_cost_usd may include children. */
export function claudeRootUsage(nativeReference: string, result: unknown, completed: boolean): HarnessRootUsageSnapshot {
  const base = {actor: "root", scope: "turn", source: "claude.sdk.result.usage", native_reference: nativeReference} as const;
  const envelope = z.object({subtype: z.string(), is_error: z.boolean(), usage: usageSchema.optional()}).safeParse(result);
  if (!envelope.success || !envelope.data.usage) return {...base, status: "unavailable"};
  const usage = envelope.data.usage;
  // Missing cache counts are unknown rather than silently added as zero.
  const input = usage.input_tokens !== undefined && usage.cache_read_input_tokens !== undefined
      && usage.cache_creation_input_tokens !== undefined
    ? usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens : undefined;
  const output = usage.output_tokens;
  const reasoning = usage.output_tokens_details?.thinking_tokens;
  if (input !== undefined && !Number.isSafeInteger(input)
      || input !== undefined && output !== undefined && !Number.isSafeInteger(input + output)
      || reasoning !== undefined && output !== undefined && reasoning > output)
    return {...base, status: "unavailable"};
  const counters = {...(input !== undefined ? {input_tokens: input} : {}),
    ...(output !== undefined ? {output_tokens: output} : {}),
    ...(input !== undefined && output !== undefined ? {total_tokens: input + output} : {}),
    ...(usage.cache_read_input_tokens !== undefined ? {cached_input_tokens: usage.cache_read_input_tokens} : {}),
    ...(usage.cache_creation_input_tokens !== undefined ? {cache_creation_input_tokens: usage.cache_creation_input_tokens} : {}),
    ...(reasoning !== undefined && output !== undefined ? {reasoning_output_tokens: reasoning} : {})};
  if (!Object.keys(counters).length) return {...base, status: "unavailable"};
  if (completed && envelope.data.subtype === "success" && !envelope.data.is_error && input !== undefined && output !== undefined)
    return {...base, ...counters, status: "complete", input_tokens: input, output_tokens: output};
  return {...base, ...counters, status: "partial"};
}
