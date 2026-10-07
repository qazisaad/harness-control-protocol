import {z} from "zod";
import type {HarnessRootUsageSnapshot} from "@harness-control/protocol";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const codexUsageBreakdownSchema = z.object({inputTokens: count, outputTokens: count, totalTokens: count,
  cachedInputTokens: count, reasoningOutputTokens: count, cacheWriteInputTokens: count.optional()});
type Counts = z.infer<typeof codexUsageBreakdownSchema>;
const required = ["inputTokens", "outputTokens", "totalTokens", "cachedInputTokens", "reasoningOutputTokens"] as const;
const zero: Counts = {inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0, cacheWriteInputTokens: 0};
function consistent(value: Counts): boolean {
  return value.cachedInputTokens <= value.inputTokens && (value.cacheWriteInputTokens ?? 0) <= value.inputTokens
    && value.cachedInputTokens + (value.cacheWriteInputTokens ?? 0) <= value.inputTokens
    && value.reasoningOutputTokens <= value.outputTokens && value.totalTokens === value.inputTokens + value.outputTokens;
}

/** One live physical root phase. Unknown retained baselines never become complete billing. */
export class CodexRootUsage {
  #baseline: Counts | undefined;
  #phase: string | undefined;
  #counts: Counts = {...zero};
  #observed = false;
  #complete: boolean;
  constructor(readonly nativeReference: string, fresh: boolean) {
    this.#baseline = fresh ? {...zero} : undefined; this.#complete = fresh;
  }
  begin(phase: string): void {
    if (this.#phase === phase) return;
    this.#phase = phase; this.#counts = {...zero}; this.#observed = false;
  }
  observe(phase: string, lastValue: unknown, totalValue: unknown): void {
    const last = codexUsageBreakdownSchema.safeParse(lastValue), total = codexUsageBreakdownSchema.safeParse(totalValue);
    if (!last.success || !total.success || !consistent(last.data) || !consistent(total.data)) {
      this.#complete = false; this.#baseline = undefined; return;
    }
    const previous = this.#baseline; this.#baseline = total.data;
    if (phase !== this.#phase) {this.#complete = false; return;}
    let delta: Counts;
    if (previous && required.every(key => total.data[key] >= previous[key])) {
      delta = {...zero}; for (const key of required) delta[key] = total.data[key] - previous[key];
      if (previous.cacheWriteInputTokens !== undefined && total.data.cacheWriteInputTokens !== undefined
          && total.data.cacheWriteInputTokens >= previous.cacheWriteInputTokens)
        delta.cacheWriteInputTokens = total.data.cacheWriteInputTokens - previous.cacheWriteInputTokens;
      else delta.cacheWriteInputTokens = undefined;
      if (!consistent(delta)) {this.#complete = false; return;}
    } else {
      // Only the observed newest response is known after a missing/reset baseline.
      this.#complete = false; delta = last.data;
    }
    if (!required.some(key => delta[key] > 0)) return;
    const next = {...this.#counts}; for (const key of required) next[key] += delta[key];
    next.cacheWriteInputTokens = next.cacheWriteInputTokens !== undefined && delta.cacheWriteInputTokens !== undefined
      ? next.cacheWriteInputTokens + delta.cacheWriteInputTokens : undefined;
    if (!required.every(key => Number.isSafeInteger(next[key])) || !consistent(next)) {
      this.#complete = false; return;
    }
    this.#counts = next; this.#observed = true;
  }
  snapshot(completed = false): HarnessRootUsageSnapshot {
    const base = {actor: "root", scope: "turn", source: "codex.thread.tokenUsage.owned_delta", native_reference: this.nativeReference,
      ...(this.#phase ? {native_execution_reference: this.#phase} : {})} as const;
    if (!this.#observed) return {...base, status: "unavailable"};
    const counts = this.#counts;
    return {...base, status: completed && this.#complete ? "complete" : "partial",
      input_tokens: counts.inputTokens, output_tokens: counts.outputTokens, total_tokens: counts.totalTokens,
      cached_input_tokens: counts.cachedInputTokens, reasoning_output_tokens: counts.reasoningOutputTokens,
      ...(counts.cacheWriteInputTokens !== undefined ? {cache_creation_input_tokens: counts.cacheWriteInputTokens} : {})};
  }
}
