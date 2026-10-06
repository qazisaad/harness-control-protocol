import {z} from "zod";
import type {Query} from "@anthropic-ai/claude-agent-sdk";
import {HarnessAdapterError} from "../types.js";

type Effort = "low" | "medium" | "high" | "xhigh" | "max";
type Control = {applyFlagSettings(settings: {effortLevel: Effort | null}): Promise<void>; getSettings(): Promise<unknown>};
export type ClaudeEffectiveOptions = {model: string; effort: Effort | null};
const effortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);
const readbackSchema = z.object({applied: z.object({model: z.string().min(1).max(512), effort: effortSchema.nullable()}),
  sources: z.array(z.object({source: z.string(), settings: z.record(z.string(), z.unknown())})).optional()});

/** Feature detection covers SDKs that implement the native readback before adding it to their public typings. */
export function claudeEffortControl(stream: Query, requested: string | undefined): () => Promise<ClaudeEffectiveOptions> {
  const effort = requested === undefined ? null : effortSchema.parse(requested);
  const candidate = stream as unknown as Partial<Control>;
  if (typeof candidate.applyFlagSettings !== "function" || typeof candidate.getSettings !== "function")
    throw new HarnessAdapterError("native_option_transition_unsupported", "The Claude runtime does not support effort updates with effective-settings readback.");
  const control = candidate as Control;
  return async () => {
    // Flag-layer changes are session scoped; never write user or project settings.
    await control.applyFlagSettings({effortLevel: effort});
    const observed = readbackSchema.safeParse(await control.getSettings());
    if (!observed.success || effort !== null && observed.data.applied.effort !== effort)
      throw new HarnessAdapterError("native_settings_mismatch", "Claude did not confirm the requested effective effort; policy or model support may have changed it.");
    if (effort === null) {
      const flags = observed.data.sources?.filter(source => source.source === "flagSettings");
      if (!flags || flags.length !== 1 || Object.hasOwn(flags[0]!.settings, "effortLevel"))
        throw new HarnessAdapterError("native_settings_mismatch", "Claude did not confirm removal of the session effort override.");
    }
    return {model: observed.data.applied.model, effort: observed.data.applied.effort};
  };
}
