import type { ProviderInstanceConfig } from "../../../config/index.js";
import type { ProviderDriverStatus } from "../../../host/provider-registry.js";
import {
  HarnessAdapterError,
  type HarnessAdapter,
  type HarnessAdapterStartInput,
  type HarnessAdapterSession,
  type HarnessAdapterTurnInput,
  type HarnessAdapterEvent,
  type HarnessAdapterCancelInput,
  type HarnessAdapterStopInput,
} from "../types.js";
import {
  type CliProcessSpawner,
  type CliProcessResult,
  type CliProcessRunOptions,
  type CliManagedProcess,
  type CodexProcessResult,
  type CodexProcessRunOptions,
  firstLine,
  processFailureMessage,
  spawnProviderCliProcess,
  startManagedCliProcess,
} from "./cli-process.js";
import {
  normalizeProviderModels,
  adapterMcpServers,
  assertCliMcpAttachmentProxied,
} from "./shared.js";
import {
  NativeTurns,
  nativeExecutionCapabilities,
  validateNativeStart,
} from "./native-turn.js";
import { createClaudeTurn, type ClaudeQueryFactory } from "./claude-runtime.js";
export type ClaudeHarnessAdapterOptions = {
  processSpawner?: CliProcessSpawner;
  probeTimeoutMs?: number;
  turnTimeoutMs?: number;
  processKillGraceMs?: number;
  queryFactory?: ClaudeQueryFactory;
};
export class ClaudeHarnessAdapter implements HarnessAdapter {
  readonly driverKind = "claude";
  readonly #processSpawner: CliProcessSpawner;
  readonly #probeTimeoutMs: number;
  readonly #processKillGraceMs: number;
  readonly #turns: NativeTurns;
  readonly #execute: ReturnType<typeof createClaudeTurn>;
  constructor(options: ClaudeHarnessAdapterOptions = {}) {
    this.#processSpawner = options.processSpawner ?? spawnProviderCliProcess;
    this.#probeTimeoutMs = options.probeTimeoutMs ?? 5_000;
    this.#processKillGraceMs = options.processKillGraceMs ?? 1_000;
    this.#turns = new NativeTurns(
      "claude",
      options.turnTimeoutMs ?? 10 * 60 * 1000,
    );
    this.#execute = createClaudeTurn(options.queryFactory);
  }
  async probe(provider: ProviderInstanceConfig): Promise<ProviderDriverStatus> {
    const executable: string = provider.executable_path ?? "claude";
    const diagnosticPaths: string[] = claudeDiagnosticPaths(
      provider,
      executable,
      process.cwd(),
    );
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
    if (
      versionResult.timedOut ||
      versionResult.error ||
      versionResult.exitCode !== 0
    ) {
      return {
        provider_instance_id: provider.id,
        driver_kind: "claude",
        execution_capabilities: nativeExecutionCapabilities("claude"),
        installed: false,
        available: false,
        status: "unavailable",
        message: versionResult.timedOut
          ? "Claude Code version probe timed out."
          : processFailureMessage(
              versionResult,
              "Claude Code executable is not available.",
              diagnosticPaths,
            ),
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
        execution_capabilities: nativeExecutionCapabilities("claude"),
        installed: true,
        available: false,
        status: "unavailable",
        ...(version ? { version } : {}),
        message: authResult.timedOut
          ? "Claude Code authentication probe timed out."
          : processFailureMessage(
              authResult,
              "Claude Code authentication probe failed.",
              diagnosticPaths,
            ),
        models: normalizeProviderModels(provider.models),
      };
    }
    if (
      authResult.exitCode !== 0 ||
      claudeAuthStatus(authResult.stdout) === false
    ) {
      return {
        provider_instance_id: provider.id,
        driver_kind: "claude",
        execution_capabilities: nativeExecutionCapabilities("claude"),
        installed: true,
        available: false,
        status: "unauthenticated",
        ...(version ? { version } : {}),
        message: processFailureMessage(
          authResult,
          "Claude Code is not authenticated.",
          diagnosticPaths,
        ),
        models: normalizeProviderModels(provider.models),
      };
    }

    return {
      provider_instance_id: provider.id,
      driver_kind: "claude",
      execution_capabilities: nativeExecutionCapabilities("claude"),
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
                      values: ["low", "medium", "high", "xhigh", "max"].map(
                        (value) => ({ value, label: value }),
                      ),
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
    validateNativeStart(input, "claude");
  }
  async startSession(
    input: HarnessAdapterStartInput,
  ): Promise<HarnessAdapterSession> {
    await this.validateStart(input);
    for (const attachment of adapterMcpServers(input.mcpServers, input.payload))
      assertCliMcpAttachmentProxied(attachment, "Claude", "claude");
    return { adapter_session_id: input.payload.session_id };
  }
  async sendTurn(
    input: HarnessAdapterTurnInput,
  ): Promise<HarnessAdapterEvent[]> {
    return this.#turns.run(input, async (request, signal, emit) => {
      await this.validateStart({
        payload: request.startPayload,
        provider: request.provider,
      });
      return this.#execute(request, signal, emit);
    });
  }
  async cancelTurn(
    input: HarnessAdapterCancelInput,
  ): Promise<HarnessAdapterEvent[]> {
    return this.#turns.cancel(input.sessionId, input.turnId);
  }
  async stopSession(
    input: HarnessAdapterStopInput,
  ): Promise<HarnessAdapterEvent[]> {
    return this.#turns.stop(input.sessionId);
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
}
function claudeDiagnosticPaths(
  provider: ProviderInstanceConfig,
  executable: string,
  ...paths: string[]
): string[] {
  return [provider.executable_path, provider.home, executable, ...paths].filter(
    (value): value is string => value !== undefined && value.length > 0,
  );
}
function claudeEnvironment(
  provider: ProviderInstanceConfig,
): Record<string, string> {
  return {
    ...provider.env,
    ...(provider.home ? { CLAUDE_CONFIG_DIR: provider.home } : {}),
  };
}
function claudeLaunchArgs(provider: ProviderInstanceConfig): string[] {
  return provider.launch_args;
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

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
