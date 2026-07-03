import type { HarnessModel, McpServerAttachment } from "@harness-control/protocol";

import type { ProviderInstanceConfig } from "../../../config/index.js";
import { HarnessAdapterError, type HarnessAdapterEvent } from "../types.js";

export function normalizeProviderModels(models: ProviderInstanceConfig["models"]): HarnessModel[] {
  return models.map((model): HarnessModel => {
    const normalized: HarnessModel = {
      id: model.id,
      label: model.label,
      capabilities: {
        option_descriptors: model.capabilities.option_descriptors.map((option) => {
          const normalizedOption: HarnessModel["capabilities"]["option_descriptors"][number] = {
            id: option.id,
            label: option.label,
            type: option.type,
          };
          if (option.values !== undefined) {
            normalizedOption.values = option.values;
          }
          if (option.default_value !== undefined) {
            normalizedOption.default_value = option.default_value;
          }
          if (option.current_value !== undefined) {
            normalizedOption.current_value = option.current_value;
          }
          if (option.prompt_injected_values !== undefined) {
            normalizedOption.prompt_injected_values = option.prompt_injected_values;
          }
          return normalizedOption;
        }),
      },
    };
    if (model.is_default !== undefined) {
      normalized.is_default = model.is_default;
    }
    return normalized;
  });
}

export function turnFailedEvent(
  turnId: string,
  exitReason: string,
  code: string,
  message: string,
  retryable: boolean,
  details?: Record<string, unknown>,
): HarnessAdapterEvent {
  return {
    event_type: "turn.failed",
    turn_id: turnId,
    data: {
      status: "failed",
      final_output: {
        exit_reason: exitReason,
      },
      error: {
        code,
        message,
        retryable,
        ...(details ? { details } : {}),
      },
    },
  };
}

export function assertCliMcpAttachmentProxied(
  attachment: McpServerAttachment,
  providerLabel: string,
  errorPrefix: string,
): void {
  cliMcpServerConfigName(attachment.name, errorPrefix);
  if (Object.keys(attachment.headers).length > 0) {
    throw new HarnessAdapterError(
      `${errorPrefix}_mcp_attachment_requires_proxy`,
      `${providerLabel} MCP attachment '${attachment.name}' must not expose platform headers to ${providerLabel}; route it through the runner-owned proxy.`,
    );
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(attachment.url);
  } catch (error: unknown) {
    if (error instanceof Error) {
      throw new HarnessAdapterError(`${errorPrefix}_mcp_attachment_url_invalid`, error.message);
    }
    throw error;
  }

  const isLoopback: boolean =
    parsedUrl.protocol === "http:" && (parsedUrl.hostname === "127.0.0.1" || parsedUrl.hostname === "localhost");
  if (!isLoopback) {
    throw new HarnessAdapterError(
      `${errorPrefix}_mcp_attachment_requires_proxy`,
      `${providerLabel} MCP attachments must be routed through a runner-owned loopback MCP proxy so HCP proof headers can be injected.`,
    );
  }
}

export function cliMcpServerConfigName(name: string, errorPrefix: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new HarnessAdapterError(
      `${errorPrefix}_mcp_attachment_name_invalid`,
      `MCP attachment name '${name}' must contain only ASCII letters, numbers, underscores, or hyphens.`,
    );
  }
  return name;
}
