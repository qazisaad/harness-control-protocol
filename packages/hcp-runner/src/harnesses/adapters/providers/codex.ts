import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  type CodexProcessResult,
  type CodexProcessRunOptions,
  type CodexProcessSpawner,
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

const DEFAULT_CODEX_PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_CODEX_TURN_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_CODEX_PROCESS_KILL_GRACE_MS = 1_000;

export type CodexHarnessAdapterOptions = {
  processSpawner?: CodexProcessSpawner;
  probeTimeoutMs?: number;
  turnTimeoutMs?: number;
  processKillGraceMs?: number;
  temporaryDirectoryRoot?: string;
};

type CodexStopReason = "cancel_requested" | "session_stopped";

type ActiveCodexTurn = {
  sessionId: string;
  turnId: string;
  outputDirectory: string;
  process: CliManagedProcess;
  stopReason: CodexStopReason | undefined;
  cleanupPromise: Promise<void> | undefined;
};

export class CodexHarnessAdapter implements HarnessAdapter {
  readonly driverKind = "codex";

  readonly #processSpawner: CodexProcessSpawner;
  readonly #probeTimeoutMs: number;
  readonly #turnTimeoutMs: number;
  readonly #processKillGraceMs: number;
  readonly #temporaryDirectoryRoot: string;
  readonly #activeTurnsBySession = new Map<string, Map<string, ActiveCodexTurn>>();

  constructor(options: CodexHarnessAdapterOptions = {}) {
    this.#processSpawner = options.processSpawner ?? spawnProviderCliProcess;
    this.#probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_CODEX_PROBE_TIMEOUT_MS;
    this.#turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_CODEX_TURN_TIMEOUT_MS;
    this.#processKillGraceMs = options.processKillGraceMs ?? DEFAULT_CODEX_PROCESS_KILL_GRACE_MS;
    this.#temporaryDirectoryRoot = options.temporaryDirectoryRoot ?? tmpdir();
  }

  async probe(provider: ProviderInstanceConfig): Promise<ProviderDriverStatus> {
    const executable: string = provider.executable_path ?? "codex";
    const diagnosticPaths: string[] = codexDiagnosticPaths(provider, executable, process.cwd());
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
    if (versionResult.timedOut || versionResult.error || versionResult.exitCode !== 0) {
      return {
        provider_instance_id: provider.id,
        driver_kind: "codex",
        installed: false,
        available: false,
        status: "unavailable",
        message: versionResult.timedOut
          ? "Codex version probe timed out."
          : processFailureMessage(versionResult, "Codex executable is not available.", diagnosticPaths),
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
        installed: true,
        available: false,
        status: "unavailable",
        ...(version ? { version } : {}),
        message: authResult.timedOut
          ? "Codex authentication probe timed out."
          : processFailureMessage(authResult, "Codex authentication probe failed.", diagnosticPaths),
        models: normalizeProviderModels(provider.models),
      };
    }
    if (authResult.exitCode !== 0) {
      const version: string | undefined = firstLine(versionResult.stdout);
      return {
        provider_instance_id: provider.id,
        driver_kind: "codex",
        installed: true,
        available: false,
        status: "unauthenticated",
        ...(version ? { version } : {}),
        message: processFailureMessage(authResult, "Codex is not authenticated.", diagnosticPaths),
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

  async validateStart(input: HarnessAdapterStartInput): Promise<void> {
    mapCodexSandbox(input.payload.sandbox_mode);
    mapCodexApprovalPolicy(input.payload.approval_policy);
  }

  async startSession(input: HarnessAdapterStartInput): Promise<HarnessAdapterSession> {
    for (const attachment of input.payload.mcp_servers) {
      assertCodexMcpAttachmentProxied(attachment);
    }
    return {
      adapter_session_id: input.payload.session_id,
    };
  }

  async sendTurn(input: HarnessAdapterTurnInput): Promise<HarnessAdapterEvent[]> {
    const executable: string = input.provider.executable_path ?? "codex";
    if ((this.#activeTurnsBySession.get(input.payload.session_id)?.size ?? 0) > 0) {
      throw new HarnessAdapterError(
        "codex_turn_in_progress",
        `Codex session '${input.payload.session_id}' already has an active turn.`,
      );
    }

    const outputDirectory: string = await mkdtemp(join(this.#temporaryDirectoryRoot, "hcp-codex-output-"));
    const outputPath: string = join(outputDirectory, "final.txt");
    const diagnosticPaths: string[] = codexDiagnosticPaths(
      input.provider,
      executable,
      input.startPayload.cwd,
      outputDirectory,
      outputPath,
    );
    const args: string[] = [
      ...codexLaunchArgs(input.provider),
      ...codexMcpConfigArgs(input.startPayload.mcp_servers),
      "--ask-for-approval",
      mapCodexApprovalPolicy(input.startPayload.approval_policy),
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
      const process: CliManagedProcess = this.#startProcess(
        executable,
        args,
        {
          cwd: input.startPayload.cwd,
          env: providerEnvironment(input.provider),
        },
        this.#turnTimeoutMs,
      );
      const activeTurn: ActiveCodexTurn = {
        sessionId: input.payload.session_id,
        turnId: input.payload.turn_id,
        outputDirectory,
        process,
        stopReason: undefined,
        cleanupPromise: undefined,
      };
      this.#registerActiveTurn(activeTurn);

      try {
        const result: CodexProcessResult = await process.completion;
        if (activeTurn.stopReason === "cancel_requested") {
          return [];
        }

        if (activeTurn.stopReason === "session_stopped") {
          return [];
        }

        if (result.timedOut) {
          events.push(
            turnFailedEvent(
              input.payload.turn_id,
              "timeout",
              "codex_exec_timeout",
              `Codex execution timed out after ${this.#turnTimeoutMs}ms.`,
              true,
            ),
          );
          return events;
        }

        if (result.error || result.exitCode !== 0 || result.signal !== null) {
          const code: string = result.error ? "codex_process_error" : "codex_exec_failed";
          const message: string = processFailureMessage(result, "Codex execution failed.", diagnosticPaths);
          events.push(turnFailedEvent(input.payload.turn_id, "provider_error", code, message, false, processFailureDetails(result)));
          return events;
        }

        let finalText: string;
        try {
          finalText = await readFile(outputPath, "utf8");
        } catch (error: unknown) {
          events.push(
            turnFailedEvent(
              input.payload.turn_id,
              "output_unavailable",
              "codex_output_unavailable",
              "Codex completed but did not produce a final output file.",
              false,
            ),
          );
          return events;
        }

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
        this.#unregisterActiveTurn(activeTurn);
        await this.#cleanupActiveTurn(activeTurn);
      }
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  }

  async cancelTurn(input: HarnessAdapterCancelInput): Promise<HarnessAdapterEvent[]> {
    const activeTurn: ActiveCodexTurn | undefined = this.#activeTurn(input.sessionId, input.turnId);
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
    const activeTurns: Map<string, ActiveCodexTurn> | undefined = this.#activeTurnsBySession.get(input.sessionId);
    const events: HarnessAdapterEvent[] = [];
    if (activeTurns) {
      await Promise.all(
        [...activeTurns.values()].map(async (activeTurn: ActiveCodexTurn): Promise<void> => {
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

  #registerActiveTurn(activeTurn: ActiveCodexTurn): void {
    const activeTurns: Map<string, ActiveCodexTurn> =
      this.#activeTurnsBySession.get(activeTurn.sessionId) ?? new Map<string, ActiveCodexTurn>();
    activeTurns.set(activeTurn.turnId, activeTurn);
    this.#activeTurnsBySession.set(activeTurn.sessionId, activeTurns);
  }

  #activeTurn(sessionId: string, turnId: string): ActiveCodexTurn | undefined {
    return this.#activeTurnsBySession.get(sessionId)?.get(turnId);
  }

  #unregisterActiveTurn(activeTurn: ActiveCodexTurn): void {
    const activeTurns: Map<string, ActiveCodexTurn> | undefined = this.#activeTurnsBySession.get(activeTurn.sessionId);
    if (!activeTurns || activeTurns.get(activeTurn.turnId) !== activeTurn) {
      return;
    }
    activeTurns.delete(activeTurn.turnId);
    if (activeTurns.size === 0) {
      this.#activeTurnsBySession.delete(activeTurn.sessionId);
    }
  }

  async #terminateActiveTurn(activeTurn: ActiveCodexTurn, reason: CodexStopReason): Promise<void> {
    activeTurn.stopReason = reason;
    activeTurn.process.terminate();
    await activeTurn.process.completion;
    this.#unregisterActiveTurn(activeTurn);
    await this.#cleanupActiveTurn(activeTurn);
  }

  async #cleanupActiveTurn(activeTurn: ActiveCodexTurn): Promise<void> {
    if (!activeTurn.cleanupPromise) {
      activeTurn.cleanupPromise = rm(activeTurn.outputDirectory, { recursive: true, force: true });
    }
    await activeTurn.cleanupPromise;
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

function assertCodexMcpAttachmentProxied(attachment: McpServerAttachment): void {
  assertCliMcpAttachmentProxied(attachment, "Codex", "codex");
}

function codexMcpConfigArgs(attachments: McpServerAttachment[]): string[] {
  const args: string[] = [];
  for (const attachment of attachments) {
    const name: string = codexMcpServerConfigName(attachment.name);
    args.push("-c", `mcp_servers.${name}.url=${tomlString(attachment.url)}`);
  }
  return args;
}

function codexMcpServerConfigName(name: string): string {
  return cliMcpServerConfigName(name, "codex");
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function codexDiagnosticPaths(provider: ProviderInstanceConfig, executable: string, ...paths: string[]): string[] {
  return [provider.executable_path, provider.home, executable, ...paths].filter(
    (path): path is string => path !== undefined && path.length > 0,
  );
}

function providerEnvironment(provider: ProviderInstanceConfig): Record<string, string> {
  return {
    ...provider.env,
    ...(provider.home ? { CODEX_HOME: provider.home } : {}),
  };
}

function codexLaunchArgs(provider: ProviderInstanceConfig): string[] {
  return provider.launch_args;
}
