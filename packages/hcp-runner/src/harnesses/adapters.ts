import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { HarnessModel, HcpEventType, HcpSessionStartPayload, HcpTurnSendPayload } from "@hcp-runner/protocol";

import type { ProviderInstanceConfig } from "../config/index.js";
import type { ProviderDriverStatus } from "../host/provider-registry.js";
import { redactValue } from "../mcp/redaction.js";

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
  validateStart(input: HarnessAdapterStartInput): Promise<void>;
  startSession(input: HarnessAdapterStartInput): Promise<HarnessAdapterSession>;
  sendTurn(input: HarnessAdapterTurnInput): Promise<HarnessAdapterEvent[]>;
  cancelTurn(input: HarnessAdapterCancelInput): Promise<HarnessAdapterEvent[]>;
  stopSession(input: HarnessAdapterStopInput): Promise<HarnessAdapterEvent[]>;
};

export type CodexProcessRunOptions = {
  cwd: string;
  env: Record<string, string>;
};

export type CodexProcessResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error: string | undefined;
  timedOut: boolean;
};

export type CodexProcessHandle = {
  readonly result: Promise<CodexProcessResult>;
  kill(signal?: NodeJS.Signals): void;
};

export type CodexProcessSpawner = (
  executable: string,
  argv: string[],
  options: CodexProcessRunOptions,
) => CodexProcessHandle;

export type CodexHarnessAdapterOptions = {
  processSpawner?: CodexProcessSpawner;
  probeTimeoutMs?: number;
  turnTimeoutMs?: number;
  processKillGraceMs?: number;
  temporaryDirectoryRoot?: string;
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

  async validateStart(): Promise<void> {
    return;
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

const DEFAULT_CODEX_PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_CODEX_TURN_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_CODEX_PROCESS_KILL_GRACE_MS = 1_000;
const MAX_CODEX_CAPTURED_OUTPUT_BYTES = 64 * 1024;

type CodexStopReason = "cancel_requested" | "session_stopped";

type CodexManagedProcess = {
  readonly completion: Promise<CodexProcessResult>;
  terminate(): void;
};

type ActiveCodexTurn = {
  sessionId: string;
  turnId: string;
  outputDirectory: string;
  process: CodexManagedProcess;
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
    this.#processSpawner = options.processSpawner ?? spawnCodexProcess;
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
    if (input.payload.mcp_servers.length > 0) {
      throw new HarnessAdapterError(
        "codex_mcp_attachment_unsupported",
        "Codex MCP attachments require a session-local config overlay, which this runner does not yet implement.",
      );
    }
  }

  async startSession(input: HarnessAdapterStartInput): Promise<HarnessAdapterSession> {
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
      const process: CodexManagedProcess = this.#startProcess(
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
  ): CodexManagedProcess {
    const handle: CodexProcessHandle = this.#spawnProcess(executable, argv, options);
    return this.#manageProcess(handle, timeoutMs);
  }

  #spawnProcess(executable: string, argv: string[], options: CodexProcessRunOptions): CodexProcessHandle {
    try {
      return this.#processSpawner(executable, argv, options);
    } catch (error: unknown) {
      return resolvedProcessHandle(processExceptionResult(error));
    }
  }

  #manageProcess(handle: CodexProcessHandle, timeoutMs: number): CodexManagedProcess {
    let settled = false;
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    let settleProcess: (result: CodexProcessResult) => void = () => {};
    const completion: Promise<CodexProcessResult> = new Promise<CodexProcessResult>((resolve) => {
      settleProcess = (result: CodexProcessResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeout) {
          clearTimeout(timeout);
        }
        if (forceKill) {
          clearTimeout(forceKill);
        }
        resolve({
          ...result,
          timedOut: result.timedOut || timedOut,
        });
      };
    });

    const terminate = (asTimeout: boolean): void => {
      if (asTimeout) {
        timedOut = true;
      }
      handle.kill("SIGTERM");
      if (!forceKill) {
        forceKill = setTimeout((): void => {
          handle.kill("SIGKILL");
          settleProcess({
            exitCode: null,
            signal: "SIGKILL",
            stdout: "",
            stderr: "",
            error: asTimeout ? "Codex execution timed out." : "Codex process was terminated.",
            timedOut: asTimeout,
          });
        }, this.#processKillGraceMs);
      }
    };

    timeout = setTimeout((): void => terminate(true), timeoutMs);
    handle.result.then(
      (result: CodexProcessResult): void => settleProcess(result),
      (error: unknown): void => settleProcess(processExceptionResult(error)),
    );

    return {
      completion,
      terminate: (): void => terminate(false),
    };
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

function firstLine(value: string): string | undefined {
  const line: string | undefined = value.split(/\r?\n/).find((candidate: string): boolean => candidate.trim().length > 0);
  return line?.trim();
}

function firstNonEmpty(...values: string[]): string {
  const found: string | undefined = values.find((value: string): boolean => value.trim().length > 0);
  return found?.trim() ?? "Provider command failed.";
}

function spawnCodexProcess(
  executable: string,
  argv: string[],
  options: CodexProcessRunOptions,
): CodexProcessHandle {
  const child: ChildProcessWithoutNullStreams = spawn(executable, argv, {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...options.env,
    },
    stdio: "pipe",
    detached: process.platform !== "win32",
  });
  let stdout = "";
  let stderr = "";
  let settled = false;

  child.stdin.end();

  const result: Promise<CodexProcessResult> = new Promise<CodexProcessResult>((resolve) => {
    const settle = (processResult: CodexProcessResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(processResult);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendLimitedProcessOutput(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendLimitedProcessOutput(stderr, chunk);
    });
    child.once("error", (error: Error) => {
      settle({
        exitCode: null,
        signal: null,
        stdout,
        stderr,
        error: error.message,
        timedOut: false,
      });
    });
    child.once("close", (exitCode: number | null, signal: NodeJS.Signals | null) => {
      settle({
        exitCode,
        signal,
        stdout,
        stderr,
        error: undefined,
        timedOut: false,
      });
    });
  });

  return {
    result,
    kill(signal: NodeJS.Signals = "SIGTERM"): void {
      killChildProcess(child, signal);
    },
  };
}

function appendLimitedProcessOutput(existing: string, chunk: Buffer): string {
  const combined: Buffer = Buffer.concat([Buffer.from(existing), chunk]);
  if (combined.byteLength <= MAX_CODEX_CAPTURED_OUTPUT_BYTES) {
    return combined.toString("utf8");
  }
  return combined.subarray(0, MAX_CODEX_CAPTURED_OUTPUT_BYTES).toString("utf8");
}

function killChildProcess(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  try {
    if (process.platform === "win32" && child.pid !== undefined) {
      const argv: string[] = ["/pid", String(child.pid), "/T"];
      if (signal === "SIGKILL") {
        argv.push("/F");
      }
      const killer = spawn("taskkill", argv, { stdio: "ignore" });
      killer.once("error", () => {
        child.kill(signal);
      });
      return;
    }
    if (process.platform !== "win32" && child.pid !== undefined) {
      process.kill(-child.pid, signal);
      return;
    }
    child.kill(signal);
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return;
    }
    throw error;
  }
}

function resolvedProcessHandle(result: CodexProcessResult): CodexProcessHandle {
  return {
    result: Promise.resolve(result),
    kill(): void {
      return;
    },
  };
}

function processExceptionResult(error: unknown): CodexProcessResult {
  return {
    exitCode: null,
    signal: null,
    stdout: "",
    stderr: "",
    error: error instanceof Error ? error.message : "Codex process failed before start.",
    timedOut: false,
  };
}

function turnFailedEvent(
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

function processFailureDetails(result: CodexProcessResult): Record<string, unknown> {
  return {
    ...(result.exitCode !== null ? { exit_code: result.exitCode } : {}),
    ...(result.signal !== null ? { signal: result.signal } : {}),
    ...(result.timedOut ? { timed_out: true } : {}),
  };
}

function processFailureMessage(
  result: CodexProcessResult,
  fallback: string,
  diagnosticPaths: string[],
): string {
  const rawMessage: string = firstNonEmpty(result.error ?? "", result.stderr, result.stdout, fallback);
  const redactedValue: unknown = redactValue(redactLocalPaths(rawMessage, diagnosticPaths));
  return typeof redactedValue === "string" ? redactedValue : fallback;
}

function codexDiagnosticPaths(provider: ProviderInstanceConfig, executable: string, ...paths: string[]): string[] {
  return [provider.executable_path, provider.home, executable, ...paths].filter(
    (path): path is string => path !== undefined && path.length > 0,
  );
}

function redactLocalPaths(value: string, paths: string[]): string {
  let redacted: string = value;
  const sortedPaths: string[] = [...new Set(paths)].sort((left: string, right: string): number => right.length - left.length);
  for (const path of sortedPaths) {
    redacted = redacted.split(path).join("<local-path>");
  }
  return redacted
    .replace(/\/(?:Users|home|private|tmp|var|opt|Applications|Volumes)\/[^\s'"]+/g, "<local-path>")
    .replace(/[A-Za-z]:\\[^\s'"]+/g, "<local-path>")
    .trim();
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
