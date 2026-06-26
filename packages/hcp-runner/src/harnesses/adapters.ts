import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import type { HarnessModel, HcpEventType, HcpSessionStartPayload, HcpTurnSendPayload } from "@hcp-runner/protocol";

import type { ProviderInstanceConfig } from "../config/index.js";
import type { ProviderDriverStatus } from "../host/provider-registry.js";

export type HarnessAdapterEvent = {
  event_type: HcpEventType;
  turn_id?: string;
  data: Record<string, unknown>;
};

export type HarnessAdapterSession = {
  adapter_session_id: string;
};

export type HarnessAdapterStartInput = {
  payload: HcpSessionStartPayload;
  provider: ProviderInstanceConfig;
};

export type HarnessAdapterTurnInput = {
  payload: HcpTurnSendPayload;
  session: HarnessAdapterSession;
  startPayload: HcpSessionStartPayload;
  provider: ProviderInstanceConfig;
};

export type HarnessAdapterCancelInput = {
  sessionId: string;
  turnId: string;
};

export type HarnessAdapterStopInput = {
  sessionId: string;
  reason?: string;
};

export type HarnessAdapter = {
  readonly driverKind: string;
  probe(provider: ProviderInstanceConfig): Promise<ProviderDriverStatus>;
  startSession(input: HarnessAdapterStartInput): Promise<HarnessAdapterSession>;
  sendTurn(input: HarnessAdapterTurnInput): Promise<HarnessAdapterEvent[]>;
  cancelTurn(input: HarnessAdapterCancelInput): Promise<HarnessAdapterEvent[]>;
  stopSession(input: HarnessAdapterStopInput): Promise<HarnessAdapterEvent[]>;
};

export class HarnessAdapterError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HarnessAdapterError";
  }
}

export class HarnessAdapterRegistry {
  readonly #adapters: Map<string, HarnessAdapter>;

  constructor(adapters: HarnessAdapter[]) {
    this.#adapters = new Map(adapters.map((adapter: HarnessAdapter): [string, HarnessAdapter] => [adapter.driverKind, adapter]));
  }

  get(driverKind: string): HarnessAdapter | undefined {
    return this.#adapters.get(driverKind);
  }

  require(driverKind: string): HarnessAdapter {
    const adapter: HarnessAdapter | undefined = this.get(driverKind);
    if (!adapter) {
      throw new HarnessAdapterError("provider_driver_unavailable", `Provider driver '${driverKind}' is not available in this runner.`);
    }
    return adapter;
  }

  async probeProviders(providers: ProviderInstanceConfig[]): Promise<ProviderDriverStatus[]> {
    return await Promise.all(
      providers.map(async (provider: ProviderInstanceConfig): Promise<ProviderDriverStatus> => {
        const adapter: HarnessAdapter | undefined = this.get(provider.driver_kind);
        if (!adapter) {
          return {
            provider_instance_id: provider.id,
            driver_kind: provider.driver_kind,
            installed: false,
            available: false,
            status: "unavailable",
            message: `Unsupported provider driver '${provider.driver_kind}'.`,
            models: [],
          };
        }
        return adapter.probe(provider);
      }),
    );
  }
}

export function createDefaultHarnessAdapterRegistry(): HarnessAdapterRegistry {
  return new HarnessAdapterRegistry([new MockHarnessAdapter(), new CodexHarnessAdapter()]);
}

export class MockHarnessAdapter implements HarnessAdapter {
  readonly driverKind = "mock";

  async probe(provider: ProviderInstanceConfig): Promise<ProviderDriverStatus> {
    return {
      provider_instance_id: provider.id,
      driver_kind: provider.driver_kind,
      installed: true,
      available: true,
      status: "ready",
      version: "0.0.0-mock",
      models: normalizeProviderModels(provider.models),
    };
  }

  async startSession(input: HarnessAdapterStartInput): Promise<HarnessAdapterSession> {
    return {
      adapter_session_id: input.payload.session_id,
    };
  }

  async sendTurn(input: HarnessAdapterTurnInput): Promise<HarnessAdapterEvent[]> {
    return [
      {
        event_type: "turn.started",
        turn_id: input.payload.turn_id,
        data: {
          provider_instance_id: input.provider.id,
          input_length: input.payload.input.length,
          ...(input.payload.model_selection ? { model_selection: input.payload.model_selection } : {}),
        },
      },
      {
        event_type: "turn.completed",
        turn_id: input.payload.turn_id,
        data: {
          status: "accepted",
          final_output: {
            final_text: "",
          },
        },
      },
    ];
  }

  async cancelTurn(input: HarnessAdapterCancelInput): Promise<HarnessAdapterEvent[]> {
    return [
      {
        event_type: "turn.cancelled",
        turn_id: input.turnId,
        data: {
          status: "cancelled",
          final_output: {
            exit_reason: "cancel_requested",
          },
        },
      },
    ];
  }

  async stopSession(): Promise<HarnessAdapterEvent[]> {
    return [];
  }
}

export class CodexHarnessAdapter implements HarnessAdapter {
  readonly driverKind = "codex";

  async probe(provider: ProviderInstanceConfig): Promise<ProviderDriverStatus> {
    const executable: string = provider.executable_path ?? "codex";
    const versionResult: ProcessResult = await runProcess(executable, ["--version"], {
      cwd: process.cwd(),
      env: providerEnvironment(provider),
      timeoutMs: 5_000,
    });
    if (versionResult.error) {
      return {
        provider_instance_id: provider.id,
        driver_kind: "codex",
        installed: false,
        available: false,
        status: "unavailable",
        message: versionResult.error,
        models: normalizeProviderModels(provider.models),
      };
    }

    const authResult: ProcessResult = await runProcess(executable, ["login", "status"], {
      cwd: process.cwd(),
      env: providerEnvironment(provider),
      timeoutMs: 5_000,
    });
    if (authResult.exitCode !== 0) {
      const version: string | undefined = firstLine(versionResult.stdout);
      return {
        provider_instance_id: provider.id,
        driver_kind: "codex",
        installed: true,
        available: false,
        status: "unauthenticated",
        ...(version ? { version } : {}),
        message: firstNonEmpty(authResult.stderr, authResult.stdout, "Codex is not authenticated."),
        models: normalizeProviderModels(provider.models),
      };
    }

    const version: string | undefined = firstLine(versionResult.stdout);
    return {
      provider_instance_id: provider.id,
      driver_kind: "codex",
      installed: true,
      available: true,
      status: "ready",
      ...(version ? { version } : {}),
      authStatus: "authenticated",
      models:
        provider.models.length > 0
          ? normalizeProviderModels(provider.models)
          : [
              {
                id: "gpt-5-codex",
                label: "GPT-5 Codex",
                is_default: true,
                capabilities: {
                  option_descriptors: [
                    {
                      id: "reasoningEffort",
                      label: "Reasoning effort",
                      type: "select",
                      values: ["minimal", "low", "medium", "high", "xhigh"].map((value) => ({ value, label: value })),
                    },
                  ],
                },
              },
            ],
    };
  }

  async startSession(input: HarnessAdapterStartInput): Promise<HarnessAdapterSession> {
    mapCodexSandbox(input.payload.sandbox_mode);
    mapCodexApprovalPolicy(input.payload.approval_policy);
    if (input.payload.mcp_servers.length > 0) {
      throw new HarnessAdapterError(
        "codex_mcp_attachment_unsupported",
        "Codex MCP attachments require a session-local config overlay, which this runner does not yet implement.",
      );
    }
    return {
      adapter_session_id: input.payload.session_id,
    };
  }

  async sendTurn(input: HarnessAdapterTurnInput): Promise<HarnessAdapterEvent[]> {
    const executable: string = input.provider.executable_path ?? "codex";
    const outputDirectory: string = await mkdtemp(join(tmpdir(), "hcp-codex-output-"));
    const outputPath: string = join(outputDirectory, "final.txt");
    const args: string[] = [
      "exec",
      "--json",
      "--ephemeral",
      "--skip-git-repo-check",
      "--cd",
      input.startPayload.cwd,
      "--model",
      input.payload.model_selection?.model ?? input.startPayload.model_selection.model,
      "--sandbox",
      mapCodexSandbox(input.startPayload.sandbox_mode),
      "--ask-for-approval",
      mapCodexApprovalPolicy(input.startPayload.approval_policy),
      "--output-last-message",
      outputPath,
      input.payload.input,
    ];

    const events: HarnessAdapterEvent[] = [
      {
        event_type: "turn.started",
        turn_id: input.payload.turn_id,
        data: {
          provider_instance_id: input.provider.id,
          input_length: input.payload.input.length,
          model_selection: input.payload.model_selection ?? input.startPayload.model_selection,
        },
      },
    ];

    try {
      const result: ProcessResult = await runProcess(executable, args, {
        cwd: input.startPayload.cwd,
        env: providerEnvironment(input.provider),
        timeoutMs: 10 * 60 * 1000,
      });
      if (result.exitCode !== 0) {
        events.push({
          event_type: "turn.failed",
          turn_id: input.payload.turn_id,
          data: {
            status: "failed",
            final_output: {
              exit_reason: "provider_error",
            },
            error: {
              code: "codex_exec_failed",
              message: firstNonEmpty(result.stderr, result.stdout, "Codex execution failed."),
              retryable: false,
            },
          },
        });
        return events;
      }

      const finalText: string = await readFile(outputPath, "utf8");
      if (finalText.length > 0) {
        events.push({
          event_type: "content.delta",
          turn_id: input.payload.turn_id,
          data: {
            delta: finalText,
          },
        });
      }
      events.push({
        event_type: "turn.completed",
        turn_id: input.payload.turn_id,
        data: {
          status: "completed",
          final_output: {
            final_text: finalText,
          },
        },
      });
      return events;
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  }

  async cancelTurn(input: HarnessAdapterCancelInput): Promise<HarnessAdapterEvent[]> {
    return [
      {
        event_type: "turn.cancelled",
        turn_id: input.turnId,
        data: {
          status: "cancelled",
          final_output: {
            exit_reason: "cancel_requested",
          },
        },
      },
    ];
  }

  async stopSession(): Promise<HarnessAdapterEvent[]> {
    return [];
  }
}

function mapCodexSandbox(sandboxMode: HcpSessionStartPayload["sandbox_mode"]): string {
  switch (sandboxMode) {
    case "read_only":
      return "read-only";
    case "workspace_write":
      return "workspace-write";
    case "danger_full_access":
      return "danger-full-access";
  }
}

function mapCodexApprovalPolicy(approvalPolicy: HcpSessionStartPayload["approval_policy"]): string {
  switch (approvalPolicy) {
    case "ask":
      return "on-request";
    case "auto_edits":
      return "on-request";
    case "full_access":
      return "never";
  }
}

type ProcessResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: string;
};

async function runProcess(
  executable: string,
  argv: string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    timeoutMs: number;
  },
): Promise<ProcessResult> {
  return await new Promise<ProcessResult>((resolve) => {
    const child = spawn(executable, argv, {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...options.env,
      },
      stdio: "pipe",
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
    }, options.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error: Error) => {
      clearTimeout(timeout);
      resolve({
        exitCode: null,
        stdout,
        stderr,
        error: error.message,
      });
    });
    child.once("close", (exitCode: number | null) => {
      clearTimeout(timeout);
      resolve({
        exitCode,
        stdout,
        stderr,
      });
    });
  });
}

function firstLine(value: string): string | undefined {
  const line: string | undefined = value.split(/\r?\n/).find((candidate: string): boolean => candidate.trim().length > 0);
  return line?.trim();
}

function firstNonEmpty(...values: string[]): string {
  const found: string | undefined = values.find((value: string): boolean => value.trim().length > 0);
  return found?.trim() ?? "Provider command failed.";
}

function providerEnvironment(provider: ProviderInstanceConfig): Record<string, string> {
  return {
    ...provider.env,
    ...(provider.home ? { CODEX_HOME: provider.home } : {}),
  };
}

function normalizeProviderModels(models: ProviderInstanceConfig["models"]): HarnessModel[] {
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
