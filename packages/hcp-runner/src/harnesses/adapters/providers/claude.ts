import type { HcpSessionStartPayload, McpServerAttachment } from "@harness-control/protocol";

import type { ProviderInstanceConfig } from "../../../config/index.js";
import type { ProviderDriverStatus } from "../../../host/provider-registry.js";
import { HarnessAdapterError } from "../types.js";
import type {
  HarnessAdapter,
  HarnessAdapterCancelInput,
  HarnessAdapterEvent,
  HarnessAdapterSession,
  HarnessAdapterStartInput,
  HarnessAdapterStopInput,
  HarnessAdapterTurnInput,
} from "../types.js";
import {
  type CliManagedProcess,
  type CliProcessResult,
  type CliProcessRunOptions,
  type CliProcessSpawner,
  firstLine,
  processFailureDetails,
  processFailureMessage,
  spawnProviderCliProcess,
  startManagedCliProcess,
} from "./cli-process.js";
import {
  assertCliMcpAttachmentProxied,
  cliMcpServerConfigName,
  normalizeProviderModels,
  turnFailedEvent,
} from "./shared.js";

const DEFAULT_CLAUDE_PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_CLAUDE_TURN_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_CLAUDE_PROCESS_KILL_GRACE_MS = 1_000;

export type ClaudeHarnessAdapterOptions = {
  processSpawner?: CliProcessSpawner;
  probeTimeoutMs?: number;
  turnTimeoutMs?: number;
  processKillGraceMs?: number;
};

type ClaudeStopReason = "cancel_requested" | "session_stopped";

type ActiveClaudeTurn = {
  sessionId: string;
  turnId: string;
  process: CliManagedProcess;
  stopReason: ClaudeStopReason | undefined;
};

type ClaudeJsonOutput = {
  finalText: string;
  isError: boolean;
  errorMessage?: string;
};

type ClaudeMcpServerConfig = {
  type: "http";
  url: string;
};

type ClaudeMcpConfig = {
  mcpServers: Record<string, ClaudeMcpServerConfig>;
};

export class ClaudeHarnessAdapter implements HarnessAdapter {
  readonly driverKind = "claude";

  readonly #processSpawner: CliProcessSpawner;
  readonly #probeTimeoutMs: number;
  readonly #turnTimeoutMs: number;
  readonly #processKillGraceMs: number;
  readonly #activeTurnsBySession = new Map<string, Map<string, ActiveClaudeTurn>>();

  constructor(options: ClaudeHarnessAdapterOptions = {}) {
    this.#processSpawner = options.processSpawner ?? spawnProviderCliProcess;
    this.#probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_CLAUDE_PROBE_TIMEOUT_MS;
    this.#turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_CLAUDE_TURN_TIMEOUT_MS;
    this.#processKillGraceMs = options.processKillGraceMs ?? DEFAULT_CLAUDE_PROCESS_KILL_GRACE_MS;
  }

  async probe(provider: ProviderInstanceConfig): Promise<ProviderDriverStatus> {
    const executable: string = provider.executable_path ?? "claude";
    const diagnosticPaths: string[] = claudeDiagnosticPaths(provider, executable, process.cwd());
    const launchArgs: string[] = claudeLaunchArgs(provider);
    const versionResult: CliProcessResult = await this.#runProcess(
      executable,
      [...launchArgs, "--version"],
      {
        cwd: process.cwd(),
        env: claudeEnvironment(provider),
      },
      this.#probeTimeoutMs,
    );
    if (versionResult.timedOut || versionResult.error || versionResult.exitCode !== 0) {
      return {
        provider_instance_id: provider.id,
        driver_kind: "claude",
        installed: false,
        available: false,
        status: "unavailable",
        message: versionResult.timedOut
          ? "Claude Code version probe timed out."
          : processFailureMessage(versionResult, "Claude Code executable is not available.", diagnosticPaths),
        models: normalizeProviderModels(provider.models),
      };
    }

    const authResult: CliProcessResult = await this.#runProcess(
      executable,
      [...launchArgs, "auth", "status", "--json"],
      {
        cwd: process.cwd(),
        env: claudeEnvironment(provider),
      },
      this.#probeTimeoutMs,
    );
    const version: string | undefined = firstLine(versionResult.stdout);
    if (authResult.timedOut || authResult.error) {
      return {
        provider_instance_id: provider.id,
        driver_kind: "claude",
        installed: true,
        available: false,
        status: "unavailable",
        ...(version ? { version } : {}),
        message: authResult.timedOut
          ? "Claude Code authentication probe timed out."
          : processFailureMessage(authResult, "Claude Code authentication probe failed.", diagnosticPaths),
        models: normalizeProviderModels(provider.models),
      };
    }
    if (authResult.exitCode !== 0 || claudeAuthStatus(authResult.stdout) === false) {
      return {
        provider_instance_id: provider.id,
        driver_kind: "claude",
        installed: true,
        available: false,
        status: "unauthenticated",
        ...(version ? { version } : {}),
        message: processFailureMessage(authResult, "Claude Code is not authenticated.", diagnosticPaths),
        models: normalizeProviderModels(provider.models),
      };
    }

    return {
      provider_instance_id: provider.id,
      driver_kind: "claude",
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
                id: "sonnet",
                label: "Claude Sonnet",
                is_default: true,
                capabilities: {
                  option_descriptors: [
                    {
                      id: "effort",
                      label: "Effort",
                      type: "select",
                      values: ["low", "medium", "high", "xhigh", "max"].map((value) => ({ value, label: value })),
                    },
                  ],
                },
              },
              {
                id: "opus",
                label: "Claude Opus",
                capabilities: { option_descriptors: [] },
              },
              {
                id: "haiku",
                label: "Claude Haiku",
                capabilities: { option_descriptors: [] },
              },
            ],
    };
  }

  async validateStart(input: HarnessAdapterStartInput): Promise<void> {
    mapClaudePermissionMode(input.payload.approval_policy);
  }

  async startSession(input: HarnessAdapterStartInput): Promise<HarnessAdapterSession> {
    for (const attachment of input.payload.mcp_servers) {
      assertCliMcpAttachmentProxied(attachment, "Claude Code", "claude");
    }
    return {
      adapter_session_id: input.payload.session_id,
    };
  }

  async sendTurn(input: HarnessAdapterTurnInput): Promise<HarnessAdapterEvent[]> {
    const executable: string = input.provider.executable_path ?? "claude";
    if ((this.#activeTurnsBySession.get(input.payload.session_id)?.size ?? 0) > 0) {
      throw new HarnessAdapterError(
        "claude_turn_in_progress",
        `Claude Code session '${input.payload.session_id}' already has an active turn.`,
      );
    }

    const diagnosticPaths: string[] = claudeDiagnosticPaths(input.provider, executable, input.startPayload.cwd);
    const args: string[] = [
      ...claudeLaunchArgs(input.provider),
      ...claudeMcpConfigArgs(input.startPayload.mcp_servers),
      "-p",
      "--output-format",
      "json",
      "--no-session-persistence",
      "--permission-mode",
      mapClaudePermissionMode(input.startPayload.approval_policy),
      "--model",
      input.payload.model_selection?.model ?? input.startPayload.model_selection.model,
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

    const process: CliManagedProcess = this.#startProcess(
      executable,
      args,
      {
        cwd: input.startPayload.cwd,
        env: claudeEnvironment(input.provider),
      },
      this.#turnTimeoutMs,
    );
    const activeTurn: ActiveClaudeTurn = {
      sessionId: input.payload.session_id,
      turnId: input.payload.turn_id,
      process,
      stopReason: undefined,
    };
    this.#registerActiveTurn(activeTurn);

    try {
      const result: CliProcessResult = await process.completion;
      if (activeTurn.stopReason === "cancel_requested" || activeTurn.stopReason === "session_stopped") {
        return [];
      }

      if (result.timedOut) {
        events.push(
          turnFailedEvent(
            input.payload.turn_id,
            "timeout",
            "claude_exec_timeout",
            `Claude Code execution timed out after ${this.#turnTimeoutMs}ms.`,
            true,
          ),
        );
        return events;
      }

      if (result.error || result.exitCode !== 0 || result.signal !== null) {
        const code: string = result.error ? "claude_process_error" : "claude_exec_failed";
        const message: string = processFailureMessage(result, "Claude Code execution failed.", diagnosticPaths);
        events.push(turnFailedEvent(input.payload.turn_id, "provider_error", code, message, false, processFailureDetails(result)));
        return events;
      }

      let output: ClaudeJsonOutput;
      try {
        output = parseClaudeJsonOutput(result.stdout);
      } catch (error: unknown) {
        events.push(
          turnFailedEvent(
            input.payload.turn_id,
            "output_unavailable",
            "claude_output_unparseable",
            error instanceof Error ? error.message : "Claude Code completed but returned unparseable JSON output.",
            false,
          ),
        );
        return events;
      }

      if (output.isError) {
        events.push(
          turnFailedEvent(
            input.payload.turn_id,
            "provider_error",
            "claude_result_error",
            output.errorMessage ?? "Claude Code returned an error result.",
            false,
          ),
        );
        return events;
      }

      if (output.finalText.length > 0) {
        events.push({
          event_type: "content.delta",
          turn_id: input.payload.turn_id,
          data: {
            delta: output.finalText,
          },
        });
      }
      events.push({
        event_type: "turn.completed",
        turn_id: input.payload.turn_id,
        data: {
          status: "completed",
          final_output: {
            final_text: output.finalText,
          },
        },
      });
      return events;
    } finally {
      this.#unregisterActiveTurn(activeTurn);
    }
  }

  async cancelTurn(input: HarnessAdapterCancelInput): Promise<HarnessAdapterEvent[]> {
    const activeTurn: ActiveClaudeTurn | undefined = this.#activeTurn(input.sessionId, input.turnId);
    if (!activeTurn) {
      return [];
    }
    await this.#terminateActiveTurn(activeTurn, "cancel_requested");
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

  async stopSession(input: HarnessAdapterStopInput): Promise<HarnessAdapterEvent[]> {
    const activeTurns: Map<string, ActiveClaudeTurn> | undefined = this.#activeTurnsBySession.get(input.sessionId);
    const events: HarnessAdapterEvent[] = [];
    if (activeTurns) {
      await Promise.all(
        [...activeTurns.values()].map(async (activeTurn: ActiveClaudeTurn): Promise<void> => {
          await this.#terminateActiveTurn(activeTurn, "session_stopped");
          events.push({
            event_type: "turn.cancelled",
            turn_id: activeTurn.turnId,
            data: {
              status: "cancelled",
              final_output: {
                exit_reason: "session_stopped",
              },
            },
          });
        }),
      );
    }
    return events;
  }

  #runProcess(
    executable: string,
    argv: string[],
    options: CliProcessRunOptions,
    timeoutMs: number,
  ): Promise<CliProcessResult> {
    return this.#startProcess(executable, argv, options, timeoutMs).completion;
  }

  #startProcess(
    executable: string,
    argv: string[],
    options: CliProcessRunOptions,
    timeoutMs: number,
  ): CliManagedProcess {
    return startManagedCliProcess({
      processSpawner: this.#processSpawner,
      executable,
      argv,
      runOptions: options,
      timeoutMs,
      processKillGraceMs: this.#processKillGraceMs,
      timeoutErrorMessage: "Claude Code execution timed out.",
      terminatedErrorMessage: "Claude Code process was terminated.",
      startFailureMessage: "Claude Code process failed before start.",
    });
  }

  #registerActiveTurn(activeTurn: ActiveClaudeTurn): void {
    const activeTurns: Map<string, ActiveClaudeTurn> =
      this.#activeTurnsBySession.get(activeTurn.sessionId) ?? new Map<string, ActiveClaudeTurn>();
    activeTurns.set(activeTurn.turnId, activeTurn);
    this.#activeTurnsBySession.set(activeTurn.sessionId, activeTurns);
  }

  #activeTurn(sessionId: string, turnId: string): ActiveClaudeTurn | undefined {
    return this.#activeTurnsBySession.get(sessionId)?.get(turnId);
  }

  #unregisterActiveTurn(activeTurn: ActiveClaudeTurn): void {
    const activeTurns: Map<string, ActiveClaudeTurn> | undefined = this.#activeTurnsBySession.get(activeTurn.sessionId);
    if (!activeTurns || activeTurns.get(activeTurn.turnId) !== activeTurn) {
      return;
    }
    activeTurns.delete(activeTurn.turnId);
    if (activeTurns.size === 0) {
      this.#activeTurnsBySession.delete(activeTurn.sessionId);
    }
  }

  async #terminateActiveTurn(activeTurn: ActiveClaudeTurn, reason: ClaudeStopReason): Promise<void> {
    activeTurn.stopReason = reason;
    activeTurn.process.terminate();
    await activeTurn.process.completion;
    this.#unregisterActiveTurn(activeTurn);
  }
}

function mapClaudePermissionMode(approvalPolicy: HcpSessionStartPayload["approval_policy"]): string {
  switch (approvalPolicy) {
    case "ask":
      return "default";
    case "auto_edits":
      return "acceptEdits";
    case "full_access":
      return "bypassPermissions";
  }
}

function claudeMcpConfigArgs(attachments: McpServerAttachment[]): string[] {
  if (attachments.length === 0) {
    return [];
  }

  const config: ClaudeMcpConfig = { mcpServers: {} };
  for (const attachment of attachments) {
    assertCliMcpAttachmentProxied(attachment, "Claude Code", "claude");
    config.mcpServers[claudeMcpServerConfigName(attachment.name)] = {
      type: "http",
      url: attachment.url,
    };
  }
  return ["--mcp-config", JSON.stringify(config), "--strict-mcp-config"];
}

function claudeMcpServerConfigName(name: string): string {
  return cliMcpServerConfigName(name, "claude");
}

function parseClaudeJsonOutput(stdout: string): ClaudeJsonOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error: unknown) {
    if (error instanceof Error) {
      throw new Error(`Claude Code completed but returned unparseable JSON output: ${error.message}`);
    }
    throw error;
  }
  if (!isJsonObject(parsed)) {
    throw new Error("Claude Code completed but returned a non-object JSON result.");
  }

  const result: unknown = parsed["result"];
  const finalText: string = typeof result === "string" ? result : serializeUnknownJsonValue(result);
  const isError: boolean = parsed["is_error"] === true || parsed["subtype"] === "error";
  const output: ClaudeJsonOutput = {
    finalText,
    isError,
  };
  const errorMessage: string | undefined = isError ? claudeErrorMessage(parsed) : undefined;
  if (errorMessage !== undefined) {
    output.errorMessage = errorMessage;
  }
  return output;
}

function claudeAuthStatus(stdout: string): boolean | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error: unknown) {
    if (error instanceof Error) {
      return undefined;
    }
    throw error;
  }
  if (!isJsonObject(parsed) || typeof parsed["loggedIn"] !== "boolean") {
    return undefined;
  }
  return parsed["loggedIn"];
}

function claudeErrorMessage(output: Record<string, unknown>): string | undefined {
  return firstDefinedText(output["api_error_status"], output["result"], output["subtype"]);
}

function firstDefinedText(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value === "string") {
      return value;
    }
    return serializeUnknownJsonValue(value);
  }
  return undefined;
}

function serializeUnknownJsonValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  const serialized: string | undefined = JSON.stringify(value);
  return serialized ?? String(value);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function claudeDiagnosticPaths(provider: ProviderInstanceConfig, executable: string, ...paths: string[]): string[] {
  return [provider.executable_path, provider.home, executable, ...paths].filter(
    (path): path is string => path !== undefined && path.length > 0,
  );
}

function claudeEnvironment(provider: ProviderInstanceConfig): Record<string, string> {
  return {
    ...provider.env,
    ...(provider.home ? { CLAUDE_CONFIG_DIR: provider.home } : {}),
  };
}

function claudeLaunchArgs(provider: ProviderInstanceConfig): string[] {
  return provider.launch_args;
}
