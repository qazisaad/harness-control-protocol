import {z} from "zod";
import type {HarnessContextUsage} from "@harness-control/protocol";

/** Match the root's actual model, rather than borrowing a child model's window or guessing an alias. */
export function claudeContextCapacity(context: HarnessContextUsage, nativeModel: string | undefined, modelUsage: unknown): HarnessContextUsage {
  if (context.status !== "measured" || !nativeModel) return context;
  const usage = z.record(z.string(), z.object({contextWindow: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional()})).safeParse(modelUsage);
  const capacity = usage.success ? usage.data[nativeModel]?.contextWindow : undefined;
  return capacity === undefined ? context : {...context, capacity_tokens: capacity,
    source: "claude.sdk.root.assistant_and_modelUsage", observed_at: new Date().toISOString()};
}
