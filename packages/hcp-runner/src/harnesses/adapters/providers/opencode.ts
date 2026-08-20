import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { z } from "zod";

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
  type CliProcessResult,
  firstLine,
  processFailureMessage,
  spawnProviderCliProcess,
} from "./cli-process.js";
import {
  adapterMcpServers,
  assertCliMcpAttachmentProxied,
  cliMcpServerConfigName,
  normalizeProviderModels,
  turnFailedEvent,
} from "./shared.js";

const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_SERVER_START_TIMEOUT_MS = 10_000;
const DEFAULT_EVENT_SETTLE_TIMEOUT_MS = 5_000;

const sessionSchema = z.object({ id: z.string().min(1) }).passthrough();
const promptResponseSchema = z
  .object({
    parts: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()).default([]),
  })
  .passthrough();
const eventSchema = z
  .object({
    type: z.string(),
    properties: z.record(z.string(), z.unknown()),
  })
  .passthrough();

type OpenCodeRuntimeStartInput = {
  executable: string;
  launchArgs: string[];
  cwd: string;
  env: Record<string, string>;
  mcpServers: Record<string, { type: "remote"; url: string; enabled: true }>;
};

export type OpenCodeRuntimeTurnInput = {
  turnId: string;
  input: string;
  model: string;
  emitEvent: (event: HarnessAdapterEvent) => void;
};

export type OpenCodeRuntime = {
  readonly sessionId: string;
  sendTurn(input: OpenCodeRuntimeTurnInput): Promise<string>;
  cancelTurn(): Promise<void>;
  close(): Promise<void>;
};

export type OpenCodeRuntimeFactory = (input: OpenCodeRuntimeStartInput) => Promise<OpenCodeRuntime>;

export type OpenCodeHarnessAdapterOptions = {
  runtimeFactory?: OpenCodeRuntimeFactory;
  probeTimeoutMs?: number;
};

export class OpenCodeHarnessAdapter implements HarnessAdapter {
  readonly driverKind = "opencode";

  readonly #runtimeFactory: OpenCodeRuntimeFactory;
  readonly #probeTimeoutMs: number;
  readonly #runtimes = new Map<string, OpenCodeRuntime>();
  readonly #activeTurns = new Map<string, string>();
  readonly #stopReasons = new Map<string, "cancel_requested" | "session_stopped">();

  constructor(options: OpenCodeHarnessAdapterOptions = {}) {
    this.#runtimeFactory = options.runtimeFactory ?? startOpenCodeRuntime;
    this.#probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  }

  async probe(provider: ProviderInstanceConfig): Promise<ProviderDriverStatus> {
    const executable: string = provider.executable_path ?? "opencode";
    const result: CliProcessResult = await runProbe(executable, [...provider.launch_args, "--version"], provider, this.#probeTimeoutMs);
    const version: string | undefined = firstLine(result.stdout);
    if (result.timedOut || result.error || result.exitCode !== 0) {
      return {
        provider_instance_id: provider.id,
        driver_kind: this.driverKind,
        installed: false,
        available: false,
        status: "unavailable",
        message: result.timedOut
          ? "OpenCode version probe timed out."
          : processFailureMessage(
              result,
              "OpenCode executable is not available.",
              provider.home ? [executable, provider.home] : [executable],
            ),
        models: normalizeProviderModels(provider.models),
      };
    }
    return {
      provider_instance_id: provider.id,
      driver_kind: this.driverKind,
      installed: true,
      available: true,
      status: "ready",
      ...(version ? { version } : {}),
      models: normalizeProviderModels(provider.models),
    };
  }

  async validateStart(): Promise<void> {
    return;
  }

  async startSession(input: HarnessAdapterStartInput): Promise<HarnessAdapterSession> {
    if (this.#runtimes.has(input.payload.session_id)) {
      throw new HarnessAdapterError("opencode_session_exists", `OpenCode session '${input.payload.session_id}' already exists.`);
    }
    const mcpServers: Record<string, { type: "remote"; url: string; enabled: true }> = {};
    for (const attachment of adapterMcpServers(input.mcpServers, input.payload)) {
      assertCliMcpAttachmentProxied(attachment, "OpenCode", "opencode");
      const name: string = cliMcpServerConfigName(attachment.name, "opencode");
      mcpServers[name] = { type: "remote", url: attachment.url, enabled: true };
    }
    const runtime: OpenCodeRuntime = await this.#runtimeFactory({
      executable: input.provider.executable_path ?? "opencode",
      launchArgs: input.provider.launch_args,
      cwd: input.payload.cwd,
      env: providerEnvironment(input.provider),
      mcpServers,
    });
    this.#runtimes.set(input.payload.session_id, runtime);
    return { adapter_session_id: runtime.sessionId };
  }

  async sendTurn(input: HarnessAdapterTurnInput): Promise<HarnessAdapterEvent[]> {
    const runtime: OpenCodeRuntime = this.#requireRuntime(input.payload.session_id);
    if (this.#activeTurns.has(input.payload.session_id)) {
      throw new HarnessAdapterError(
        "opencode_turn_in_progress",
        `OpenCode session '${input.payload.session_id}' already has an active turn.`,
      );
    }
    this.#activeTurns.set(input.payload.session_id, input.payload.turn_id);
    try {
      const finalText: string = await runtime.sendTurn({
        turnId: input.payload.turn_id,
        input: input.payload.input,
        model: input.payload.model_selection?.model ?? input.startPayload.model_selection.model,
        emitEvent: input.emitEvent ?? (() => {}),
      });
      return [
        {
          event_type: "turn.completed",
          turn_id: input.payload.turn_id,
          data: { status: "completed", final_output: { final_text: finalText } },
        },
      ];
    } catch (error: unknown) {
      if (this.#stopReasons.has(input.payload.session_id)) return [];
      return [
        turnFailedEvent(
          input.payload.turn_id,
          "provider_error",
          "opencode_turn_failed",
          error instanceof Error ? error.message : "OpenCode turn failed.",
          false,
        ),
      ];
    } finally {
      this.#activeTurns.delete(input.payload.session_id);
      this.#stopReasons.delete(input.payload.session_id);
    }
  }

  async cancelTurn(input: HarnessAdapterCancelInput): Promise<HarnessAdapterEvent[]> {
    if (this.#activeTurns.get(input.sessionId) !== input.turnId) {
      return [];
    }
    this.#stopReasons.set(input.sessionId, "cancel_requested");
    await this.#requireRuntime(input.sessionId).cancelTurn();
    return [
      {
        event_type: "turn.cancelled",
        turn_id: input.turnId,
        data: { status: "cancelled", final_output: { exit_reason: "cancel_requested" } },
      },
    ];
  }

  async stopSession(input: HarnessAdapterStopInput): Promise<HarnessAdapterEvent[]> {
    const runtime: OpenCodeRuntime | undefined = this.#runtimes.get(input.sessionId);
    if (!runtime) {
      return [];
    }
    const activeTurnId: string | undefined = this.#activeTurns.get(input.sessionId);
    if (activeTurnId) this.#stopReasons.set(input.sessionId, "session_stopped");
    this.#runtimes.delete(input.sessionId);
    await runtime.close();
    return activeTurnId
      ? [
          {
            event_type: "turn.cancelled",
            turn_id: activeTurnId,
            data: { status: "cancelled", final_output: { exit_reason: "session_stopped" } },
          },
        ]
      : [];
  }

  #requireRuntime(sessionId: string): OpenCodeRuntime {
    const runtime: OpenCodeRuntime | undefined = this.#runtimes.get(sessionId);
    if (!runtime) {
      throw new HarnessAdapterError("opencode_session_not_found", `OpenCode session '${sessionId}' is not active.`);
    }
    return runtime;
  }
}

async function runProbe(
  executable: string,
  args: string[],
  provider: ProviderInstanceConfig,
  timeoutMs: number,
): Promise<CliProcessResult> {
  const handle = spawnProviderCliProcess(executable, args, { cwd: process.cwd(), env: providerEnvironment(provider) });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut: Promise<CliProcessResult> = new Promise<CliProcessResult>((resolve) => {
    timeout = setTimeout((): void => {
      handle.kill("SIGKILL");
      resolve({ exitCode: null, signal: "SIGKILL", stdout: "", stderr: "", error: undefined, timedOut: true });
    }, timeoutMs);
  });
  const result: CliProcessResult = await Promise.race([handle.result, timedOut]);
  if (timeout) clearTimeout(timeout);
  return result;
}

async function startOpenCodeRuntime(input: OpenCodeRuntimeStartInput): Promise<OpenCodeRuntime> {
  const config: Record<string, unknown> = Object.keys(input.mcpServers).length > 0 ? { mcp: input.mcpServers } : {};
  const child: ChildProcessWithoutNullStreams = spawn(
    input.executable,
    [...input.launchArgs, "serve", "--hostname=127.0.0.1", "--port=0"],
    {
      cwd: input.cwd,
      env: { ...process.env, ...input.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) },
      stdio: "pipe",
      detached: process.platform !== "win32",
    },
  );
  child.stdin.end();
  const baseUrl: string = await waitForServerUrl(child, DEFAULT_SERVER_START_TIMEOUT_MS);
  try {
    const session: z.infer<typeof sessionSchema> = sessionSchema.parse(
      await fetchJson(new URL(`/session?directory=${encodeURIComponent(input.cwd)}`, baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "HCP session" }),
      }),
    );
    return new HttpOpenCodeRuntime(child, baseUrl, input.cwd, session.id);
  } catch (error: unknown) {
    terminateProcess(child);
    throw error;
  }
}

class HttpOpenCodeRuntime implements OpenCodeRuntime {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #baseUrl: string;
  readonly #cwd: string;
  readonly sessionId: string;
  #activeRequest: AbortController | undefined;

  constructor(
    child: ChildProcessWithoutNullStreams,
    baseUrl: string,
    cwd: string,
    sessionId: string,
  ) {
    this.#child = child;
    this.#baseUrl = baseUrl;
    this.#cwd = cwd;
    this.sessionId = sessionId;
  }

  async sendTurn(input: OpenCodeRuntimeTurnInput): Promise<string> {
    if (this.#activeRequest) {
      throw new Error(`OpenCode session '${this.sessionId}' already has an active HTTP request.`);
    }
    const abortController = new AbortController();
    this.#activeRequest = abortController;
    const streamReady = createEventStream(
      new URL(`/event?directory=${encodeURIComponent(this.#cwd)}`, this.#baseUrl),
      this.sessionId,
      input,
      abortController.signal,
    );
    try {
      await streamReady.ready;
      const model = parseModel(input.model);
      const response: z.infer<typeof promptResponseSchema> = promptResponseSchema.parse(
        await fetchJson(
          new URL(`/session/${encodeURIComponent(this.sessionId)}/message?directory=${encodeURIComponent(this.#cwd)}`, this.#baseUrl),
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              parts: [{ type: "text", text: input.input }],
              ...(model ? { model } : {}),
            }),
            signal: abortController.signal,
          },
        ),
      );
      await waitWithTimeout(streamReady.settled, DEFAULT_EVENT_SETTLE_TIMEOUT_MS, "OpenCode did not emit session.idle.");
      return response.parts
        .filter((part): boolean => part.type === "text" && part.text !== undefined)
        .map((part): string => part.text ?? "")
        .join("");
    } finally {
      abortController.abort();
      await streamReady.completed;
      this.#activeRequest = undefined;
    }
  }

  async cancelTurn(): Promise<void> {
    this.#activeRequest?.abort();
    await fetchJson(new URL(`/session/${encodeURIComponent(this.sessionId)}/abort?directory=${encodeURIComponent(this.#cwd)}`, this.#baseUrl), {
      method: "POST",
    });
  }

  async close(): Promise<void> {
    this.#activeRequest?.abort();
    terminateProcess(this.#child);
  }
}

type OpenCodeEventStream = { ready: Promise<void>; settled: Promise<void>; completed: Promise<void> };

function createEventStream(
  url: URL,
  sessionId: string,
  input: OpenCodeRuntimeTurnInput,
  signal: AbortSignal,
): OpenCodeEventStream {
  let markReady: () => void = () => {};
  let rejectReady: (error: Error) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    markReady = resolve;
    rejectReady = reject;
  });
  let markSettled: () => void = () => {};
  let rejectSettled: (error: Error) => void = () => {};
  const settled = new Promise<void>((resolve, reject) => {
    markSettled = resolve;
    rejectSettled = reject;
  });
  const completed: Promise<void> = (async (): Promise<void> => {
    try {
      const response: Response = await fetch(url, { headers: { accept: "text/event-stream" }, signal });
      if (!response.ok || !response.body) {
        throw new Error(`OpenCode event stream failed with HTTP ${response.status}.`);
      }
      markReady();
      await consumeSse(response.body, (value: unknown): void => {
        const outcome: OpenCodeEventOutcome = emitOpenCodeEvent(value, sessionId, input);
        if (outcome === "settled") markSettled();
        if (outcome instanceof Error) rejectSettled(outcome);
      });
    } catch (error: unknown) {
      if (!signal.aborted) {
        const normalized: Error = error instanceof Error ? error : new Error("OpenCode event stream failed.");
        rejectReady(normalized);
        throw normalized;
      }
      markReady();
    }
  })();
  return { ready, settled, completed };
}

async function consumeSse(stream: ReadableStream<Uint8Array>, onData: (value: unknown) => void): Promise<void> {
  const reader: ReadableStreamDefaultReader<Uint8Array> = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  while (true) {
    const result: ReadableStreamReadResult<Uint8Array> = await reader.read();
    if (result.done) break;
    buffered += decoder.decode(result.value, { stream: true }).replaceAll("\r\n", "\n");
    let boundary: number;
    while ((boundary = buffered.indexOf("\n\n")) >= 0) {
      const block: string = buffered.slice(0, boundary);
      buffered = buffered.slice(boundary + 2);
      const data: string = block
        .split("\n")
        .filter((line): boolean => line.startsWith("data:"))
        .map((line): string => line.slice(5).trimStart())
        .join("\n");
      if (data.length > 0) onData(JSON.parse(data) as unknown);
    }
  }
}

type OpenCodeEventOutcome = "continue" | "settled" | Error;

function emitOpenCodeEvent(value: unknown, sessionId: string, input: OpenCodeRuntimeTurnInput): OpenCodeEventOutcome {
  const event: z.infer<typeof eventSchema> = eventSchema.parse(value);
  if (event.type === "session.idle") {
    return event.properties.sessionID === sessionId ? "settled" : "continue";
  }
  if (event.type === "session.error" && (event.properties.sessionID === undefined || event.properties.sessionID === sessionId)) {
    return new Error("OpenCode reported a session error.");
  }
  if (event.type !== "message.part.updated") return "continue";
  const part: unknown = event.properties.part;
  const partSchema = z.object({ sessionID: z.string(), type: z.string() }).passthrough();
  const parsedPart: z.infer<typeof partSchema> = partSchema.parse(part);
  if (parsedPart.sessionID !== sessionId) return "continue";
  const delta: unknown = event.properties.delta;
  if (typeof delta !== "string" || delta.length === 0) return "continue";
  if (parsedPart.type !== "text" && parsedPart.type !== "reasoning") return "continue";
  input.emitEvent({
    event_type: parsedPart.type === "reasoning" ? "reasoning.delta" : "content.delta",
    turn_id: input.turnId,
    data: { delta },
  });
  return "continue";
}

async function fetchJson(url: URL, init: RequestInit): Promise<unknown> {
  const response: Response = await fetch(url, init);
  if (!response.ok) {
    const body: string = await response.text();
    throw new Error(`OpenCode request failed with HTTP ${response.status}${body ? `: ${body}` : "."}`);
  }
  return (await response.json()) as unknown;
}

function waitForServerUrl(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let output = "";
    let settled = false;
    const timeout: ReturnType<typeof setTimeout> = setTimeout((): void => {
      settleError(new Error(`Timed out waiting ${timeoutMs}ms for OpenCode server startup.`));
    }, timeoutMs);
    const settleError = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      terminateProcess(child);
      reject(error);
    };
    const inspect = (chunk: Buffer): void => {
      if (settled) return;
      output += chunk.toString("utf8");
      const match: RegExpMatchArray | null = output.match(/opencode server listening[^\n]*on\s+(https?:\/\/[^\s]+)/i);
      if (!match?.[1]) return;
      settled = true;
      clearTimeout(timeout);
      resolve(match[1]);
    };
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("error", settleError);
    child.once("exit", (code: number | null): void => {
      settleError(new Error(`OpenCode server exited before startup with code ${code ?? "unknown"}.`));
    });
  });
}

function terminateProcess(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
      return;
    } catch (error: unknown) {
      if (!(error instanceof Error)) throw error;
    }
  }
  child.kill("SIGTERM");
}

function parseModel(model: string): { providerID: string; modelID: string } | undefined {
  const separator: number = model.indexOf("/");
  if (separator <= 0 || separator === model.length - 1) return undefined;
  return { providerID: model.slice(0, separator), modelID: model.slice(separator + 1) };
}

function providerEnvironment(provider: ProviderInstanceConfig): Record<string, string> {
  return { ...(provider.home ? { HOME: provider.home } : {}), ...provider.env };
}

async function waitWithTimeout(completion: Promise<void>, timeoutMs: number, message: string): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<void>((_resolve, reject) => {
    timeout = setTimeout((): void => reject(new Error(message)), timeoutMs);
  });
  try {
    await Promise.race([completion, expired]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
