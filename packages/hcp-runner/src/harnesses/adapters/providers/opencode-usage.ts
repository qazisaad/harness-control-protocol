import {randomBytes} from "node:crypto";
import {z} from "zod";
import type {HarnessUsageSnapshot} from "@harness-control/protocol";
import {HarnessAdapterError} from "../types.js";

let lastTime = 0n;
/** Native ascending message identity, shared by admission and ownership checks. */
export function openCodeMessageId(): string {
  const now = BigInt(Date.now()) * 0x1000n;
  lastTime = now > lastTime ? now : lastTime + 1n;
  return `msg_${BigInt.asUintN(48, lastTime).toString(16).padStart(12, "0")}${randomBytes(14).toString("hex")}`;
}

const stepSchema = z.object({id: z.string(), messageID: z.string(), sessionID: z.string(), type: z.literal("step-finish"),
  cost: z.number().nonnegative(), tokens: z.object({input: z.number().int().nonnegative(), output: z.number().int().nonnegative(),
    reasoning: z.number().int().nonnegative(), cache: z.object({read: z.number().int().nonnegative(), write: z.number().int().nonnegative()})})});
type Step = z.infer<typeof stepSchema>;

/** Counts only steps belonging to this admitted root prompt; arrival order is irrelevant. */
export class OpenCodeUsage {
  readonly #owners = new Map<string, boolean>();
  readonly #steps = new Map<string, Step>();
  #conflict = false;
  constructor(readonly sessionId: string, readonly promptId: string) {}

  observe(event: {type: string; properties: Record<string, unknown>}): void {
    if (event.type === "message.updated") this.message(event.properties.info);
    if (event.type === "message.part.updated") this.part(event.properties.part);
  }

  message(value: unknown): void {
    const result = z.object({id: z.string(), sessionID: z.string(), role: z.string(), parentID: z.string().optional()}).safeParse(value);
    if (!result.success || result.data.sessionID !== this.sessionId || result.data.role !== "assistant" || !result.data.parentID) return;
    const owned = result.data.parentID === this.promptId;
    const previous = this.#owners.get(result.data.id);
    if (previous !== undefined && previous !== owned) this.#conflict = true;
    else this.#owners.set(result.data.id, owned);
    this.#bound();
  }

  part(value: unknown): void {
    const candidate = z.object({sessionID: z.string(), type: z.string()}).safeParse(value);
    if (!candidate.success || candidate.data.sessionID !== this.sessionId || candidate.data.type !== "step-finish") return;
    const step = stepSchema.parse(value);
    const previous = this.#steps.get(step.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(step)) this.#conflict = true;
    else this.#steps.set(step.id, step);
    this.#bound();
  }

  snapshot(): HarnessUsageSnapshot | undefined {
    const owned = [...this.#steps.values()].filter(step => this.#owners.get(step.messageID) === true);
    if (!owned.length) return undefined;
    let input = 0, output = 0, cached = 0, created = 0, reasoning = 0, cost = 0;
    for (const step of owned) {
      cached += step.tokens.cache.read; created += step.tokens.cache.write; reasoning += step.tokens.reasoning;
      input += step.tokens.input + step.tokens.cache.read + step.tokens.cache.write;
      output += step.tokens.output + step.tokens.reasoning; cost += step.cost;
    }
    const unresolved = [...this.#steps.values()].some(step => !this.#owners.has(step.messageID));
    return {scope: "turn", status: this.#conflict || unresolved ? "partial" : "complete", source: "opencode.message.step-finish",
      input_tokens: input, output_tokens: output, total_tokens: input + output, cached_input_tokens: cached,
      cache_creation_input_tokens: created, reasoning_output_tokens: reasoning, cost_usd: cost};
  }

  #bound(): void {
    if (this.#owners.size + this.#steps.size > 10_000)
      throw new HarnessAdapterError("native_usage_limit", "OpenCode exceeded the bounded usage observation limit.");
  }
}
