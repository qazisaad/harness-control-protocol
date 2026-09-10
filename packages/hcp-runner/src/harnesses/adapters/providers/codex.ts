import { codexModels } from "./codex-models.js";
import type { HarnessModel } from "@harness-control/protocol";
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
import { runCodexTurn } from "./codex-runtime.js";
export type CodexHarnessAdapterOptions = {
  processSpawner?: CliProcessSpawner;
  probeTimeoutMs?: number;
  turnTimeoutMs?: number;
  processKillGraceMs?: number;
};
export class CodexHarnessAdapter implements HarnessAdapter {
  readonly driverKind = "codex";
  readonly #processSpawner: CliProcessSpawner;
  readonly #probeTimeoutMs: number;
  readonly #processKillGraceMs: number;
  readonly #turns: NativeTurns;

  constructor(options: CodexHarnessAdapterOptions = {}) {
    this.#processSpawner = options.processSpawner ?? spawnProviderCliProcess;
    this.#probeTimeoutMs = options.probeTimeoutMs ?? 5_000;
    this.#processKillGraceMs = options.processKillGraceMs ?? 1_000;
    this.#turns = new NativeTurns(
      "codex",
      options.turnTimeoutMs ?? 10 * 60 * 1000,
    );
  }
  async probe(provider: ProviderInstanceConfig): Promise<ProviderDriverStatus> {
    const executable: string = provider.executable_path ?? "codex";
    const diagnosticPaths: string[] = codexDiagnosticPaths(
      provider,
      executable,
      process.cwd(),
    );
    const launchArgs: string[] = codexLaunchArgs(provider);
    const versionResult: CodexProcessResult = await this.#runProcess(
      executable,
      [...launchArgs, "--version"],
      {
        cwd: process.cwd(),
        env: providerEnvironment(provider),
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
        driver_kind: "codex",
        execution_capabilities: nativeExecutionCapabilities("codex"),
        installed: false,
        available: false,
        status: "unavailable",
        message: versionResult.timedOut
          ? "Codex version probe timed out."
          : processFailureMessage(
              versionResult,
              "Codex executable is not available.",
              diagnosticPaths,
            ),
        models: normalizeProviderModels(provider.models),
      };
    }

    const authResult: CodexProcessResult = await this.#runProcess(
      executable,
      [...launchArgs, "login", "status"],
      {
        cwd: process.cwd(),
        env: providerEnvironment(provider),
      },
      this.#probeTimeoutMs,
    );
    if (authResult.timedOut || authResult.error) {
      const version: string | undefined = firstLine(versionResult.stdout);
      return {
        provider_instance_id: provider.id,
        driver_kind: "codex",
        execution_capabilities: nativeExecutionCapabilities("codex"),
        installed: true,
        available: false,
        status: "unavailable",
        ...(version ? { version } : {}),
        message: authResult.timedOut
          ? "Codex authentication probe timed out."
          : processFailureMessage(
              authResult,
              "Codex authentication probe failed.",
              diagnosticPaths,
            ),
        models: normalizeProviderModels(provider.models),
      };
    }
    if (authResult.exitCode !== 0) {
      const version: string | undefined = firstLine(versionResult.stdout);
      return {
        provider_instance_id: provider.id,
        driver_kind: "codex",
        execution_capabilities: nativeExecutionCapabilities("codex"),
        installed: true,
        available: false,
        status: "unauthenticated",
        ...(version ? { version } : {}),
        message: processFailureMessage(
          authResult,
          "Codex is not authenticated.",
          diagnosticPaths,
        ),
        models: normalizeProviderModels(provider.models),
      };
    }

    let models: HarnessModel[];
    try {
      models =
        provider.models.length > 0
          ? normalizeProviderModels(provider.models)
          : await codexModels(provider, this.#probeTimeoutMs);
    } catch {
      return {
        provider_instance_id: provider.id,
        driver_kind: "codex",
        installed: true,
        available: false,
        status: "unavailable",
        message: "Codex native model discovery failed.",
        models: [],
        execution_capabilities: nativeExecutionCapabilities("codex"),
      };
    }
    const version: string | undefined = firstLine(versionResult.stdout);
    return {
      provider_instance_id: provider.id,
      driver_kind: "codex",
      execution_capabilities: nativeExecutionCapabilities("codex"),
      installed: true,
      available: true,
      status: "ready",
      ...(version ? { version } : {}),
      authStatus: "authenticated",
      models,
    };
  }

  async validateStart(input: HarnessAdapterStartInput): Promise<void> {
    validateNativeStart(input, "codex");
  }
  async startSession(
    input: HarnessAdapterStartInput,
  ): Promise<HarnessAdapterSession> {
    await this.validateStart(input);
    for (const attachment of adapterMcpServers(input.mcpServers, input.payload))
      assertCliMcpAttachmentProxied(attachment, "Codex", "codex");
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
      return runCodexTurn(request, signal, emit);
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
    options: CodexProcessRunOptions,
    timeoutMs: number,
  ): Promise<CodexProcessResult> {
    return this.#startProcess(executable, argv, options, timeoutMs).completion;
  }

  #startProcess(
    executable: string,
    argv: string[],
    options: CodexProcessRunOptions,
    timeoutMs: number,
  ): CliManagedProcess {
    return startManagedCliProcess({
      processSpawner: this.#processSpawner,
      executable,
      argv,
      runOptions: options,
      timeoutMs,
      processKillGraceMs: this.#processKillGraceMs,
      timeoutErrorMessage: "Codex execution timed out.",
      terminatedErrorMessage: "Codex process was terminated.",
      startFailureMessage: "Codex process failed before start.",
    });
  }
}
function codexDiagnosticPaths(
  provider: ProviderInstanceConfig,
  executable: string,
  ...paths: string[]
): string[] {
  return [provider.executable_path, provider.home, executable, ...paths].filter(
    (value): value is string => value !== undefined && value.length > 0,
  );
}
function providerEnvironment(
  provider: ProviderInstanceConfig,
): Record<string, string> {
  return {
    ...provider.env,
    ...(provider.home ? { CODEX_HOME: provider.home } : {}),
  };
}
function codexLaunchArgs(provider: ProviderInstanceConfig): string[] {
  return provider.launch_args;
}
