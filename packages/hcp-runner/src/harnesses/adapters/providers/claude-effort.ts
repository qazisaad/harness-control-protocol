import {z} from "zod";
import type {Query} from "@anthropic-ai/claude-agent-sdk";
import type {HarnessModelSelection} from "@harness-control/protocol";
import {HarnessAdapterError} from "../types.js";

type Effort = "low" | "medium" | "high" | "xhigh" | "max";
type BooleanOptions = {thinking?: boolean; ultracode?: boolean; fastMode?: boolean};
type Control = {applyFlagSettings(settings: {effortLevel: Effort | null; alwaysThinkingEnabled?: boolean | null; ultracode?: boolean | null; fastMode?: boolean | null}): Promise<void>; getSettings(): Promise<unknown>;
  reinitialize?: () => Promise<unknown>};
export type ClaudeEffectiveOptions = {model: string; effort: Effort | null; booleans?: BooleanOptions};
const effortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);
const readbackSchema = z.object({applied: z.object({model: z.string().min(1).max(512), effort: effortSchema.nullable()}),
  effective: z.record(z.string(), z.unknown()).optional(),
  sources: z.array(z.object({source: z.string(), settings: z.record(z.string(), z.unknown())})).optional()});

/** Feature detection covers SDKs that implement the native readback before adding it to their public typings. */
export function claudeBooleanOptions(selection: HarnessModelSelection): BooleanOptions {
  return Object.fromEntries((selection.options ?? []).filter(option => ["thinking", "ultracode", "fastMode"].includes(option.id))
    .map(option => [option.id, z.boolean().parse(option.value)]));
}
export function claudeEffortControl(stream: Query, requested: string | undefined,
  booleans?: BooleanOptions, previous?: BooleanOptions): () => Promise<ClaudeEffectiveOptions> {
  const effort = requested === undefined ? null : effortSchema.parse(requested);
  const candidate = stream as unknown as Partial<Control>;
  if (typeof candidate.applyFlagSettings !== "function" || typeof candidate.getSettings !== "function")
    throw new HarnessAdapterError("native_option_transition_unsupported", "The Claude runtime does not support effort updates with effective-settings readback.");
  const control = candidate as Control;
  if ((booleans?.fastMode !== undefined || previous?.fastMode !== undefined) && typeof control.reinitialize !== "function")
    throw new HarnessAdapterError("native_option_transition_unsupported", "Claude fast mode requires fresh native initialization status.");
  return async () => {
    // Flag-layer changes are session scoped; never write user or project settings.
    const settings = {effortLevel: effort,
      ...(booleans?.thinking !== undefined || previous?.thinking !== undefined ? {alwaysThinkingEnabled: booleans?.thinking ?? null} : {}),
      ...(booleans?.ultracode !== undefined || previous?.ultracode !== undefined ? {ultracode: booleans?.ultracode ?? null} : {}),
      ...(booleans?.fastMode !== undefined || previous?.fastMode !== undefined ? {fastMode: booleans?.fastMode ?? null} : {})};
    await control.applyFlagSettings(settings);
    const raw = await control.getSettings();
    const observed = readbackSchema.safeParse(raw);
    if (!observed.success || effort !== null && observed.data.applied.effort !== effort)
      throw new HarnessAdapterError("native_settings_mismatch", "Claude did not confirm the requested effective effort; policy or model support may have changed it.");
    if (effort === null) {
      const flags = observed.data.sources?.filter(source => source.source === "flagSettings");
      if (!flags || flags.length !== 1 || Object.hasOwn(flags[0]!.settings, "effortLevel"))
        throw new HarnessAdapterError("native_settings_mismatch", "Claude did not confirm removal of the session effort override.");
    }
    const actual: BooleanOptions = {};
    for (const [option, key] of [["thinking", "alwaysThinkingEnabled"], ["ultracode", "ultracode"], ["fastMode", "fastMode"]] as const) {
      if (!Object.hasOwn(settings, key)) continue;
      const desired = booleans?.[option];
      const flags = observed.data.sources?.filter(source => source.source === "flagSettings");
      if (!flags || flags.length !== 1 || (desired === undefined
        ? Object.hasOwn(flags[0]!.settings, key) : flags[0]!.settings[key] !== desired))
        throw new HarnessAdapterError("native_settings_mismatch", "Claude did not confirm the session option override or its removal.");
      if (option === "thinking") {
        const effective = observed.data.effective?.[key];
        if (desired !== undefined && effective !== desired)
          throw new HarnessAdapterError("native_settings_mismatch", "Claude did not confirm the requested native thinking setting.");
        if (typeof effective === "boolean") actual.thinking = effective;
      } else if (option === "ultracode") {
        const applied = z.object({applied: z.object({ultracode: z.boolean()})}).safeParse(raw);
        if (!applied.success || desired !== undefined && applied.data.applied.ultracode !== desired)
          throw new HarnessAdapterError("native_settings_mismatch", "Claude did not confirm the requested effective ultracode option.");
        actual.ultracode = applied.data.applied.ultracode;
      } else {
        // This may redeliver outstanding native callbacks; callers must establish idle ownership first.
        const fresh = z.object({fast_mode_state: z.enum(["on", "off", "cooldown"])}).safeParse(await control.reinitialize!());
        if (!fresh.success || fresh.data.fast_mode_state === "cooldown"
          || desired !== undefined && (fresh.data.fast_mode_state === "on") !== desired)
          throw new HarnessAdapterError("native_settings_mismatch", "Claude did not confirm the requested effective fast mode.");
        actual.fastMode = fresh.data.fast_mode_state === "on";
      }
    }
    return {model: observed.data.applied.model, effort: observed.data.applied.effort,
      ...(Object.keys(actual).length ? {booleans: actual} : {})};
  };
}
