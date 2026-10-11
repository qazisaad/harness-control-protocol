import {z} from "zod";
import type {HarnessModel} from "@harness-control/protocol";
import type {ProviderInstanceConfig} from "../../../config/index.js";
import {NativeProcess} from "./native-process.js";
import {HarnessAdapterError} from "../types.js";

const modelSchema = z.object({
  value: z.string().min(1).max(256), displayName: z.string().min(1).max(512),
  resolvedModel: z.string().min(1).max(256).optional(),
  supportsEffort: z.boolean().optional(),
  supportsAdaptiveThinking: z.boolean().optional(),
  supportsFastMode: z.boolean().optional(),
  supportedEffortLevels: z.array(z.enum(["low", "medium", "high", "xhigh", "max"])).max(5).optional(),
});

const catalogSchema = z.union([z.array(modelSchema).max(256),
  z.object({models: z.array(modelSchema).max(256), ultracodeAvailable: z.boolean().optional()}).strict()]);

/**
 * Claude Code offers 1M context through `[1m]` aliases for the Opus, Sonnet and
 * Fable families only; selection is still confirmed by settings readback.
 */
const LONG_CONTEXT_FAMILY = /(^|[-/])(opus|sonnet|fable)([-\[]|$)/i;

export function projectClaudeModels(value: unknown): HarnessModel[] {
  const catalog = catalogSchema.parse(value);
  const models = Array.isArray(catalog) ? catalog : catalog.models;
  const ultracodeAvailable = !Array.isArray(catalog) && catalog.ultracodeAvailable === true;
  if (new Set(models.map(model => model.value)).size !== models.length)
    throw new HarnessAdapterError("native_catalog_invalid", "Claude returned duplicate model identifiers.");
  return models.map(model => ({id: model.value, label: model.displayName, capabilities: {
    image_input: true,
    option_descriptors: [...(model.supportsEffort && model.supportedEffortLevels?.length ? [{
      id: "effort", label: "Effort", type: "select" as const,
      values: model.supportedEffortLevels.map(value => ({value, label: value})),
    }] : []),
      ...(model.supportsAdaptiveThinking ? [{id: "thinking", label: "Thinking", type: "boolean" as const}] : []),
      ...(model.supportsFastMode ? [{id: "fastMode", label: "Fast mode", type: "boolean" as const}] : []),
      // Native settings report whether the account can enable ultracode; it needs xhigh effort.
      ...(ultracodeAvailable && model.supportedEffortLevels?.includes("xhigh") ? [{id: "ultracode", label: "Ultracode", type: "boolean" as const}] : []),
      ...(LONG_CONTEXT_FAMILY.test(model.resolvedModel ?? model.value) ? [{id: "contextWindow", label: "Context window", type: "select" as const,
        default_value: "default", values: [{value: "default", label: "Default"}, {value: "1m", label: "1M"}]}] : [])],
  }}));
}

const script = `
import {query} from ${JSON.stringify(import.meta.resolve("@anthropic-ai/claude-agent-sdk"))};
let input = ''; for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
let finish;
const pending = new Promise(resolve => {finish = resolve;});
async function* idle() {await pending;}
const runtime = query({prompt: idle(), options: {
  pathToClaudeCodeExecutable: request.executable, cwd: request.cwd,
  settingSources: [], settings: {disableAllHooks: true},
  strictMcpConfig: true, mcpServers: {}, persistSession: false,
}});
try {
  const models = await runtime.supportedModels();
  // Optional account capability; older runtimes without settings readback omit it.
  const settings = typeof runtime.getSettings === "function" ? await runtime.getSettings().catch(() => undefined) : undefined;
  const ultracodeAvailable = settings?.applied?.ultracodeAvailable;
  process.stdout.write(JSON.stringify(typeof ultracodeAvailable === "boolean" ? {models, ultracodeAvailable} : models));
}
finally {finish(); runtime.close();}
`;

/** Discover through a control request, with no user turn and no process-global account mutation. */
export async function claudeModelCatalog(provider: ProviderInstanceConfig, cwd: string): Promise<HarnessModel[]> {
  const runtime = new NativeProcess(process.execPath, ["--input-type=module", "-e", script], cwd,
    {...process.env, ...provider.env, ...(provider.home ? {CLAUDE_CONFIG_DIR: provider.home} : {})});
  const chunks: Buffer[] = [];
  let size = 0, timedOut = false, exceeded = false;
  runtime.child.stderr.resume();
  runtime.child.stdout.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > 1024 * 1024) {exceeded = true; void runtime.stop();}
    else chunks.push(chunk);
  });
  const timer = setTimeout(() => {timedOut = true; void runtime.stop();}, 15_000);
  try {
    runtime.child.stdin.end(JSON.stringify({cwd, executable: provider.executable_path ?? "claude"}));
    await runtime.closed;
    if (timedOut || exceeded || runtime.child.exitCode !== 0)
      throw new HarnessAdapterError("native_catalog_unavailable", "Claude model catalog control request could not complete.");
    try {return projectClaudeModels(JSON.parse(Buffer.concat(chunks).toString("utf8")));}
    catch {throw new HarnessAdapterError("native_catalog_invalid", "Claude returned an invalid model catalog.");}
  } finally {clearTimeout(timer); await runtime.stop();}
}
