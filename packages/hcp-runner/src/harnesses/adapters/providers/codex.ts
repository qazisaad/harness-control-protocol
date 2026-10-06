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
  type HarnessAdapterConversationInput,
} from "../types.js";
import { nativeConversationOperation } from "../../native-conversation.js";
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
} from "./shared.js";
import {
  NativeTurns,
  nativeExecutionCapabilities,
  validateNativeStart,
} from "./native-turn.js";
import { runCodexTurn, runRetainedCodexTurn, type CodexRuntimeLease } from "./codex-runtime.js";
import {CodexRpc} from "./codex-rpc.js";
const retainedProfiles = [
  {id: "isolated", runtime_lifetime: "turn", native_work: false, session_events: false},
  {id: "interactive", runtime_lifetime: "session", native_work: false, session_events: false},
] as const;
function retainedVersion(version: string | undefined): boolean {return /^codex-cli 0\.160\.0$/.test(version ?? "");}
export type CodexHarnessAdapterOptions = {
  processSpawner?: CliProcessSpawner;
  probeTimeoutMs?: number;
  turnTimeoutMs?: number;
  processKillGraceMs?: number;
};
export class CodexHarnessAdapter implements HarnessAdapter {
  readonly executionProfiles = retainedProfiles;
  readonly #leases = new Map<string, CodexRuntimeLease>();
  readonly portableHistory = true;
  readonly liveHistoryRead = true;
  readonly instructionRoles = ["system", "developer"] as const;
  readonly configurationInheritance = nativeExecutionCapabilities("codex").configuration_inheritance!;
  readonly driverKind = "codex";
  readonly durableMcpContinuation = true;
  readonly conversationOperations = ["read", "rollback", "fork", "inject"] as const;

  conversationOperation(input: HarnessAdapterConversationInput) {
    return nativeConversationOperation(input.commandId, input.request, input.conversation, input.provider, input.save, input.beginMutation, input.publishContent);
  }
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
      execution_capabilities: {...nativeExecutionCapabilities("codex"), ...(retainedVersion(version) ? {execution_profiles: [...retainedProfiles]} : {})},
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
    if (input.payload.continue_session && !input.nativeConversation)
      throw new HarnessAdapterError("native_continuation_binding", "Codex resume requires the runner-authorized retained binding.");
    if (input.payload.execution_profile === "interactive") {
      if (this.#leases.has(input.payload.session_id)) throw new HarnessAdapterError("codex_session_exists", "This session already has a retained native owner.");
      const version = await this.#runProcess(input.provider.executable_path ?? "codex", ["--version"],
        {cwd: input.payload.cwd, env: providerEnvironment(input.provider)}, this.#probeTimeoutMs);
      if (version.timedOut || version.exitCode !== 0 || !retainedVersion(firstLine(version.stdout)))
        throw new HarnessAdapterError("native_profile_unsupported", "Persistent Codex requires the verified 0.160.0 app-server protocol.");
      this.#leases.set(input.payload.session_id, {initialized: false, rpc: new CodexRpc(input.provider.executable_path ?? "codex", input.payload.cwd,
        {...process.env, ...providerEnvironment(input.provider)})});
    }
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
      if (request.startPayload.execution_profile === "interactive") {
        const lease = this.#leases.get(request.payload.session_id);
        if (!lease) throw new HarnessAdapterError("native_session_unavailable", "The persistent native owner is unavailable.");
        return runRetainedCodexTurn(request, signal, emit, lease);
      }
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
    const events = await this.#turns.stop(input.sessionId);
    const lease = this.#leases.get(input.sessionId);
    this.#leases.delete(input.sessionId);
    await lease?.rpc.process.stop();
    return events;
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
