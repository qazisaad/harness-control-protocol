import { randomUUID } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { hcpProviderSetupAgentSchema } from "@harness-control/protocol";
import { z } from "zod";

const envRecordSchema = z.record(z.string(), z.string());
const controlPlaneUrlSchema = z.string().url().refine(
  (value: string): boolean => {
    const url: URL = new URL(value);
    return ["http:", "https:", "ws:", "wss:"].includes(url.protocol);
  },
  { message: "Control plane URL must use http, https, ws, or wss" },
);

const harnessOptionValueSchema = z.union([z.string(), z.boolean(), z.number()]);
const localCapabilityIdSchema = z.enum(["filesystem", "git", "shell", "dev_server", "browser"]);

export const LocalCapabilityConfigSchema = z.object({
  id: localCapabilityIdSchema,
  status: z.enum(["available", "unavailable", "disabled", "unknown"]).default("available"),
  scopes: z.array(z.string().min(1)).default([]),
  approval_required: z.boolean().default(false),
  message: z.string().min(1).optional(),
});

export type LocalCapabilityConfig = z.infer<typeof LocalCapabilityConfigSchema>;

const HarnessOptionDescriptorConfigSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(["select", "boolean", "number", "string"]),
  values: z.array(z.object({ value: z.string(), label: z.string().min(1) })).optional(),
  default_value: harnessOptionValueSchema.optional(),
  current_value: harnessOptionValueSchema.optional(),
  prompt_injected_values: z.array(z.string()).optional(),
});

const HarnessModelConfigSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  is_default: z.boolean().optional(),
  capabilities: z
    .object({
      option_descriptors: z.array(HarnessOptionDescriptorConfigSchema).default([]),
    })
    .default({ option_descriptors: [] }),
});

export const RunnerWorkspaceConfigSchema = z.object({
  display_name: z.string().trim().min(1).max(100).optional(),
  id: z.string().min(1),
  path: z.string().min(1),
  git_remote: z.string().optional(),
});

export type RunnerWorkspaceConfig = z.infer<typeof RunnerWorkspaceConfigSchema>;

export const ProviderInstanceConfigSchema = z.object({
  id: z.string().min(1),
  driver_kind: z.string().min(1),
  display_name: z.string().optional(),
  accent_color: z.string().optional(),
  enabled: z.boolean().default(true),
  continuation_group_key: z.string().min(1).optional(),
  account_usage: z.object({
    scope_id: z.string().min(1).max(256).optional(),
    allow_experimental_claude: z.boolean().default(false),
  }).strict().optional(),
  executable_path: z.string().optional(),
  home: z.string().optional(),
  launch_args: z.array(z.string()).default([]),
  env: envRecordSchema.default({}),
  models: z.array(HarnessModelConfigSchema).default([]),
  hidden_models: z.array(z.string().min(1)).default([]),
  model_order: z.array(z.string().min(1)).default([]),
  favorite_models: z.array(z.string().min(1)).default([]),
  local_capabilities: z.array(localCapabilityIdSchema).default(["filesystem", "git", "shell"]),
});

export type ProviderInstanceConfig = z.infer<typeof ProviderInstanceConfigSchema>;

export const McpStdioProfileConfigSchema = z.object({
  id: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: envRecordSchema.default({}),
  workspace_relative_cwd: z
    .string()
    .min(1)
    .refine((value: string): boolean => !isAbsolute(value), { message: "MCP stdio profile cwd must be workspace-relative" })
    .default("."),
  provider_instance_ids: z.array(z.string().min(1)).default([]),
  allowed_tools: z.array(z.string().min(1)).optional(),
  denied_tools: z.array(z.string().min(1)).default([]),
});

export type McpStdioProfileConfig = z.infer<typeof McpStdioProfileConfigSchema>;

export const RunnerConfigSchema = z.object({
  runner_id: z.string().min(1),
  host_id: z.string().min(1).optional(),
  control_plane_url: controlPlaneUrlSchema,
  credentials_path: z.string().min(1).optional(),
  state_path: z.string().min(1).optional(),
  workspaces: z.array(RunnerWorkspaceConfigSchema).max(128).default([]),
  workspace_revision: z.string().min(1).optional(),
  workspace_management: z.object({ allowed_roots: z.array(z.string().min(1).refine(isAbsolute, "Use an absolute folder path")).max(32) }).optional(),
  /** Agents the control plane may install or update on this machine. Absent means remote setup is off; only the local user edits it. */
  provider_setup: z.object({
    remote_agents: z.array(hcpProviderSetupAgentSchema).min(1)
      .refine(agents => new Set(agents).size === agents.length, "List each agent once."),
  }).strict().optional(),
  provider_instances: z.array(ProviderInstanceConfigSchema).max(32).default([]),
  mcp_stdio_profiles: z.array(McpStdioProfileConfigSchema).default([]),
  local_capabilities: z
    .array(LocalCapabilityConfigSchema)
    .default([
      { id: "filesystem", status: "available", scopes: ["workspace_read", "workspace_write"], approval_required: false },
      { id: "git", status: "available", scopes: ["workspace_read"], approval_required: false },
      { id: "shell", status: "available", scopes: ["workspace"], approval_required: true },
      { id: "dev_server", status: "available", scopes: ["workspace"], approval_required: true },
    ]),
}).superRefine((config, context): void => {
  if (new Set(config.workspaces.map(workspace => workspace.id)).size !== config.workspaces.length) {
    context.addIssue({ code: "custom", path: ["workspaces"], message: "Workspace ids must be unique" });
  }
  if (new Set(config.provider_instances.map(provider => provider.id)).size !== config.provider_instances.length) {
    context.addIssue({ code: "custom", path: ["provider_instances"], message: "Provider ids must be unique." });
  }
  const profileIds = new Set<string>();
  const providerIds: ReadonlySet<string> = new Set(config.provider_instances.map((provider): string => provider.id));
  for (const [index, profile] of config.mcp_stdio_profiles.entries()) {
    if (profileIds.has(profile.id)) {
      context.addIssue({
        code: "custom",
        path: ["mcp_stdio_profiles", index, "id"],
        message: `Duplicate MCP stdio profile id '${profile.id}'`,
      });
    }
    profileIds.add(profile.id);
    for (const providerId of profile.provider_instance_ids) {
      if (!providerIds.has(providerId)) {
        context.addIssue({
          code: "custom",
          path: ["mcp_stdio_profiles", index, "provider_instance_ids"],
          message: `Unknown provider instance '${providerId}'`,
        });
      }
    }
  }
});

export type RunnerConfig = z.infer<typeof RunnerConfigSchema>;

export async function loadRunnerConfig(path: string): Promise<RunnerConfig> {
  const raw: string = await readFile(path, "utf8");
  const parsed: unknown = JSON.parse(raw);
  return RunnerConfigSchema.parse(parsed);
}

/** The saved configuration changed underneath the runner, or the edit would make it invalid. Nothing was written. */
export class RunnerConfigUpdateError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RunnerConfigUpdateError";
  }
}

/**
 * Applies one edit to the saved runner configuration and to the shared in-memory `current` config.
 * The edit sees the raw file so fields the user wrote stay as written and defaults are not expanded.
 * Refuses when the file no longer matches `current`, so a runner never overwrites a hand edit it has not loaded.
 */
export async function updateRunnerConfigFile(
  configPath: string,
  current: RunnerConfig,
  edit: (raw: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  const raw = z.record(z.string(), z.unknown()).parse(JSON.parse(await readFile(configPath, "utf8")));
  const saved = RunnerConfigSchema.safeParse(raw);
  if (!saved.success || !isDeepStrictEqual(saved.data, current)) throw new RunnerConfigUpdateError("Runner configuration changed on disk. Restart the runner before changing it remotely.");
  const nextRaw = edit(raw);
  const next = RunnerConfigSchema.safeParse(nextRaw);
  if (!next.success) throw new RunnerConfigUpdateError(`The change would make the runner configuration invalid: ${z.prettifyError(next.error)}`, { cause: next.error });
  const temporaryPath = `${configPath}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporaryPath, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(nextRaw, null, 2)}\n`);
      await file.sync();
    } finally { await file.close(); }
    await rename(temporaryPath, configPath);
  } finally { await rm(temporaryPath, { force: true }); }
  Object.assign(current, next.data);
}
