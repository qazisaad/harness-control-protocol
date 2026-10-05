import {z} from "zod";
import type {Query} from "@anthropic-ai/claude-agent-sdk";
import {HarnessAdapterError} from "../types.js";

type Effort = "low" | "medium" | "high" | "xhigh" | "max";
type Control = {applyFlagSettings(settings: {effortLevel: Effort}): Promise<void>; getSettings(): Promise<unknown>};

/** Feature detection covers SDKs that implement the native readback before adding it to their public typings. */
export function claudeEffortControl(stream: Query, requested: string | undefined): () => Promise<void> {
  if (requested === undefined) throw new HarnessAdapterError("native_option_transition_unsupported", "Removing a native effort override requires an explicit supported reset operation.");
  const effort = z.enum(["low", "medium", "high", "xhigh", "max"]).parse(requested);
  const candidate = stream as unknown as Partial<Control>;
  if (typeof candidate.applyFlagSettings !== "function" || typeof candidate.getSettings !== "function")
    throw new HarnessAdapterError("native_option_transition_unsupported", "The Claude runtime does not support effort updates with effective-settings readback.");
  const control = candidate as Control;
  return async () => {
    // Flag-layer changes are session scoped; never write user or project settings.
    await control.applyFlagSettings({effortLevel: effort});
    const observed = z.object({applied: z.object({effort: z.enum(["low", "medium", "high", "xhigh", "max"]).nullable()})}).safeParse(await control.getSettings());
    if (!observed.success || observed.data.applied.effort !== effort)
      throw new HarnessAdapterError("native_settings_mismatch", "Claude did not confirm the requested effective effort; policy or model support may have changed it.");
  };
}
