import {isDeepStrictEqual} from "node:util";
import type {Options, Query, SandboxSettings} from "@anthropic-ai/claude-agent-sdk";
import type {HarnessAdapterStartInput} from "../types.js";
import {HarnessAdapterError} from "../types.js";
import {z} from "zod";

type Payload = HarnessAdapterStartInput["payload"];

// Native Write/Edit and delegated agents execute outside the Bash sandbox.
// Contained modes expose read tools and Bash so every filesystem mutation runs
// under OS enforcement, including when native approval prompts are disabled.
const containedTools = ["Bash", "Read", "Glob", "Grep", "TodoWrite", "AskUserQuestion", "EnterPlanMode", "ExitPlanMode"];

export function claudeSandboxSettings(payload: Payload): SandboxSettings {
  if (payload.sandbox_mode === "danger_full_access") return {enabled: false};
  return {
    enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false,
    // Being sandboxed must not override the separately selected approval policy.
    autoAllowBashIfSandboxed: false,
    filesystem: {
      disabled: false,
      allowWrite: payload.sandbox_mode === "workspace_write"
        ? [payload.cwd, ...(payload.sandbox_options?.writable_roots?.map(root => root.path) ?? [])] : [],
      ...(payload.sandbox_mode === "read_only" ? {denyWrite: ["/"]} : {}),
    },
    ...(payload.sandbox_options?.network_access === true ? {} : {
      network: {allowedDomains: [], strictAllowlist: true},
    }),
  };
}

export function claudeSandboxOptions(payload: Payload): Pick<Options, "sandbox" | "tools"> {
  return {sandbox: claudeSandboxSettings(payload),
    ...(payload.sandbox_mode !== "danger_full_access" ? {tools: [...containedTools]} : {})};
}

const readbackSchema = z.object({
  sources: z.array(z.object({source: z.string(), settings: z.object({sandbox: z.unknown().optional()})})),
  effective: z.object({sandbox: z.record(z.string(), z.unknown())}),
});

export async function confirmClaudeSandbox(stream: Query, payload: Payload): Promise<void> {
  if (payload.sandbox_mode === "danger_full_access") return;
  const reader = stream as Query & {getSettings?: () => Promise<unknown>};
  if (typeof reader.getSettings !== "function")
    throw new HarnessAdapterError("sandbox_unconfirmed", "Contained Claude execution requires native sandbox settings readback.");
  const observed = readbackSchema.safeParse(await reader.getSettings());
  const expected = claudeSandboxSettings(payload);
  if (!observed.success)
    throw new HarnessAdapterError("sandbox_unconfirmed", "Claude did not report effective sandbox settings.");
  const flags = observed.data.sources.filter(source => source.source === "flagSettings");
  const effective = observed.data.effective.sandbox;
  if (flags.length !== 1 || !isDeepStrictEqual(flags[0]!.settings.sandbox, expected)
    || effective.enabled !== true || effective.failIfUnavailable !== true || effective.allowUnsandboxedCommands !== false
    || effective.autoAllowBashIfSandboxed !== false
    || !isDeepStrictEqual(effective.filesystem, expected.filesystem)
    || expected.network && !isDeepStrictEqual(effective.network, expected.network))
    throw new HarnessAdapterError("sandbox_unconfirmed", "Claude did not confirm the requested filesystem and network containment.");
}
