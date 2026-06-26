import { readFile } from "node:fs/promises";

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

export const RunnerConfigSchema = z.object({
  runner_id: z.string().min(1),
  host_id: z.string().min(1).optional(),
  control_plane_url: controlPlaneUrlSchema,
  credentials_path: z.string().min(1).optional(),
  workspaces: z.array(RunnerWorkspaceConfigSchema).default([]),
  provider_instances: z.array(ProviderInstanceConfigSchema).default([]),
  local_capabilities: z
    .array(LocalCapabilityConfigSchema)
    .default([
      { id: "filesystem", status: "available", scopes: ["workspace_read", "workspace_write"], approval_required: false },
      { id: "git", status: "available", scopes: ["workspace_read"], approval_required: false },
      { id: "shell", status: "available", scopes: ["workspace"], approval_required: true },
      { id: "dev_server", status: "available", scopes: ["workspace"], approval_required: true },
    ]),
});

export type RunnerConfig = z.infer<typeof RunnerConfigSchema>;

export async function loadRunnerConfig(path: string): Promise<RunnerConfig> {
  const raw: string = await readFile(path, "utf8");
  const parsed: unknown = JSON.parse(raw);
  return RunnerConfigSchema.parse(parsed);
}
