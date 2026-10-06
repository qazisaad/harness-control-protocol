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
import {claudeConversation, readClaudeOwnedHistory, type ClaudeSessionHelper} from "./claude-conversation.js";
import {PersistentClaudeSession} from "./claude-session.js";
import {claudeModelCatalog} from "./claude-models.js";
import type {HarnessModel} from "@harness-control/protocol";
export type ClaudeHarnessAdapterOptions = {
  processSpawner?: CliProcessSpawner;
  probeTimeoutMs?: number;
  turnTimeoutMs?: number;
  processKillGraceMs?: number;
  queryFactory?: ClaudeQueryFactory;
  sessionHelper?: ClaudeSessionHelper;
  modelCatalog?: typeof claudeModelCatalog;
};
export class ClaudeHarnessAdapter implements HarnessAdapter {
  readonly fileContextInputs = true;
  readonly promptContextInputs = true;
  readonly executionProfiles = nativeExecutionCapabilities("claude").execution_profiles!;
  readonly sessionEvents = true;
  readonly nativeWork = true;
  readonly #persistent = new Map<string, PersistentClaudeSession>();
  readonly #queryFactory: ClaudeQueryFactory | undefined;
  readonly portableHistory = true;
  readonly liveHistoryRead = true;
  readonly instructionRoles = ["system"] as const;
  readonly configurationInheritance = nativeExecutionCapabilities("claude").configuration_inheritance!;
  readonly driverKind = "claude";
  readonly conversationOperations = ["read", "rollback", "fork"] as const;
  readonly #sessionHelper: ClaudeSessionHelper | undefined;
  readonly #modelCatalog: typeof claudeModelCatalog;
  readonly #processSpawner: CliProcessSpawner;
  readonly #probeTimeoutMs: number;
  readonly #processKillGraceMs: number;
  readonly #turns: NativeTurns;
  readonly #execute: ReturnType<typeof createClaudeTurn>;
  constructor(options: ClaudeHarnessAdapterOptions = {}) {
    this.#queryFactory = options.queryFactory;
    this.#sessionHelper = options.sessionHelper;
    this.#modelCatalog = options.modelCatalog ?? claudeModelCatalog;
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

    const modelCapabilities = {image_input: true};
    let models: HarnessModel[] = normalizeProviderModels(provider.models).map(model => ({...model, capabilities: {...model.capabilities, ...modelCapabilities}}));
    let catalogUnavailable = false;
    if (!models.length) {
      try {models = await this.#modelCatalog(provider, process.cwd());}
      catch {catalogUnavailable = true;}
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
      models,
      ...(catalogUnavailable ? {message: "Claude Code is authenticated; its native model catalog is unavailable."} : {}),
    };
  }

  async validateStart(input: HarnessAdapterStartInput): Promise<void> {
    validateNativeStart(input, "claude");
    if (input.payload.conversation_transition && (input.payload.execution_profile !== "interactive"
      || adapterMcpServers(input.mcpServers, input.payload).length))
      throw new HarnessAdapterError("native_configuration_transition_unsupported", "Idle Claude policy replacement requires the interactive owner without unverified MCP reattachment.");
  }
  async conversationOperation(input: HarnessAdapterConversationInput) {
    return claudeConversation(input, this.#sessionHelper);
  }
  async startSession(
    input: HarnessAdapterStartInput,
  ): Promise<HarnessAdapterSession> {
    await this.validateStart(input);
    if (input.payload.continue_session && !input.nativeConversation)
      throw new HarnessAdapterError("native_continuation_binding", "Claude resume requires the runner-authorized retained binding.");
    for (const attachment of adapterMcpServers(input.mcpServers, input.payload))
      assertCliMcpAttachmentProxied(attachment, "Claude", "claude");
    if (input.payload.execution_profile === "interactive") {
      if (this.#persistent.has(input.payload.session_id)) throw new HarnessAdapterError("session_exists", "The interactive Claude session already has a native owner.");
      const runtime = new PersistentClaudeSession(input, this.#queryFactory);
      this.#persistent.set(input.payload.session_id, runtime);
      const native_policy_readback = input.payload.conversation_transition ? await runtime.confirmIdlePolicy() : undefined;
      return {adapter_session_id: input.payload.session_id, native_thread_id: runtime.nativeId,
        ...(native_policy_readback ? {native_policy_readback} : {})};
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
        const runtime = this.#persistent.get(request.payload.session_id);
        if (!runtime) throw new HarnessAdapterError("native_owner_unavailable", "The interactive Claude session has no live owner.");
        return runtime.run(request, signal, emit);
      }
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
    const events = await this.#turns.stop(input.sessionId);
    const runtime = this.#persistent.get(input.sessionId);
    if (runtime) {await runtime.stop(); this.#persistent.delete(input.sessionId);}
    return events;
  }
  async cancelNativeWork(input: Parameters<NonNullable<HarnessAdapter["cancelNativeWork"]>>[0]): Promise<void> {
    const runtime = this.#persistent.get(input.sessionId);
    if (!runtime || input.startPayload.execution_profile !== "interactive") throw new HarnessAdapterError("native_work_unsupported", "Native task control requires the interactive Claude profile.");
    await runtime.cancel(input.work.work_id, input.signal);
  }
  async readNativeWorkHistory(input: Parameters<NonNullable<HarnessAdapter["readNativeWorkHistory"]>>[0]) {
    const runtime = this.#persistent.get(input.sessionId);
    if (!runtime || input.startPayload.execution_profile !== "interactive")
      throw new HarnessAdapterError("native_work_history_unavailable", "Native child history requires the interactive Claude owner.");
    const owner = runtime.historyOwner(input.work);
    const history = await readClaudeOwnedHistory(input.provider, input.startPayload.cwd, owner, input.signal, input.page, input.publishContent, this.#sessionHelper);
    runtime.historyOwner(input.work);
    return history;
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
