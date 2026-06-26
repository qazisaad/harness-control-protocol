import { createHash } from "node:crypto";

import {
  HCP_MESSAGE_MAX_ENCODED_BYTES,
  HCP_VERSION,
  createHcpEnvelope,
  parseHcpEnvelope,
  parseJsonHcpMessage,
  type HcpError,
  type HcpHarnessEventPayload,
  type HcpHostAcceptedMessage,
  type HcpHostCapabilitiesUpdatedPayload,
  type HcpHostHeartbeatPayload,
  type HcpHostHelloPayload,
  type HcpMessage,
  type HcpAckPayload,
  type HcpNackPayload,
  type HostResumeCursor,
  type ControlPlaneCommandMessageType,
} from "@hcp-runner/protocol";
import WebSocket from "ws";

import type { RunnerConfig } from "../config/index.js";
import { HarnessAdapterError } from "../harnesses/adapters.js";
import { HarnessSessionError, HarnessSessionManager } from "../harnesses/index.js";
import { ProviderInstanceRegistry } from "../host/provider-registry.js";

type CommandRecord =
  | {
      payloadHash: string;
      outcome: "pending";
      completion: Promise<SettledCommandRecord>;
    }
  | {
      payloadHash: string;
      outcome: "ack";
    }
  | {
      payloadHash: string;
      outcome: "nack";
      nackPayload: HcpNackPayload;
    };

type SettledCommandRecord = Exclude<CommandRecord, { outcome: "pending" }>;

export type RunnerReconnectOptions = {
  initialDelayMs?: number;
  maxDelayMs?: number;
};

export type RunnerConnectionOptions = {
  config: RunnerConfig;
  runnerVersion: string;
  lastEventSequence?: number;
  resumeCursor?: HostResumeCursor;
  connectionTokenProvider?: () => Promise<string | undefined>;
  onLog?: (message: string) => void;
  harnessSessions?: HarnessSessionManager;
  reconnect?: RunnerReconnectOptions;
};

export class RunnerConnection {
  readonly #config: RunnerConfig;
  readonly #runnerVersion: string;
  readonly #resumeCursor: HostResumeCursor | undefined;
  readonly #connectionTokenProvider: (() => Promise<string | undefined>) | undefined;
  readonly #onLog: (message: string) => void;
  readonly #harnessSessions: HarnessSessionManager;
  readonly #reconnectInitialDelayMs: number;
  readonly #reconnectMaxDelayMs: number;
  #socket: WebSocket | undefined;
  #heartbeatTimer: NodeJS.Timeout | undefined;
  #reconnectTimer: NodeJS.Timeout | undefined;
  #reconnectAttempt = 0;
  #closing = false;
  readonly #commandRecords = new Map<string, CommandRecord>();

  constructor(options: RunnerConnectionOptions) {
    this.#config = options.config;
    this.#runnerVersion = options.runnerVersion;
    this.#resumeCursor =
      options.resumeCursor ??
      (options.lastEventSequence === undefined
        ? undefined
        : {
            sessions: [{ session_id: "default", last_event_sequence: options.lastEventSequence }],
          });
    this.#connectionTokenProvider = options.connectionTokenProvider;
    this.#onLog = options.onLog ?? (() => undefined);
    this.#harnessSessions = options.harnessSessions ?? new HarnessSessionManager(options.config);
    this.#reconnectInitialDelayMs = options.reconnect?.initialDelayMs ?? 1_000;
    this.#reconnectMaxDelayMs = options.reconnect?.maxDelayMs ?? 30_000;
  }

  async connect(): Promise<void> {
    this.#closing = false;
    await this.#openSocket();
  }

  async #openSocket(): Promise<void> {
    const connectionToken: string | undefined = this.#connectionTokenProvider
      ? await this.#connectionTokenProvider()
      : undefined;
    const socket = new WebSocket(this.#config.control_plane_url, {
      ...(connectionToken ? { headers: { authorization: `Bearer ${connectionToken}` } } : {}),
    });
    this.#socket = socket;

    socket.on("message", (data: WebSocket.RawData) => {
      this.#handleMessage(data.toString()).catch((error: unknown) => {
        this.#onLog(error instanceof Error ? error.message : "Failed to handle control plane message.");
      });
    });

    socket.on("close", () => {
      if (this.#socket === socket) {
        this.#socket = undefined;
      }
      this.#stopHeartbeat();
      this.#onLog("Runner disconnected from control plane.");
      if (!this.#closing) {
        this.#scheduleReconnect();
      }
    });

    socket.on("error", (error: Error) => {
      if (this.#socket === socket) {
        this.#onLog(`Runner connection error: ${error.message}`);
      }
    });

    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => {
        this.#reconnectAttempt = 0;
        this.#sendHello();
        resolve();
      });
      socket.once("error", reject);
    });
  }

  async close(): Promise<void> {
    this.#closing = true;
    this.#stopHeartbeat();
    this.#stopReconnect();
    await new Promise<void>((resolve) => {
      if (!this.#socket || this.#socket.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }

      this.#socket.once("close", () => {
        resolve();
      });
      this.#socket.close();
    });
  }

  #sendHello(): void {
    const payload: HcpHostHelloPayload = {
      runner_id: this.#config.runner_id,
      host_id: this.#config.host_id ?? this.#config.runner_id,
      runner_version: this.#runnerVersion,
      supported_protocol_versions: [HCP_VERSION],
      capabilities: [
        "providers",
        "workspaces",
        "mcp_streamable_http",
        "local_filesystem",
        "local_git",
        "local_shell",
        "local_dev_server",
      ],
      ...(this.#resumeCursor ? { resume: this.#resumeCursor } : {}),
    };

    this.#send(createHcpEnvelope("host.hello", payload));
  }

  async #handleMessage(raw: string): Promise<void> {
    if (Buffer.byteLength(raw, "utf8") > HCP_MESSAGE_MAX_ENCODED_BYTES) {
      this.#sendNack("unknown", {
        code: "message_too_large",
        message: `Control plane message exceeds ${HCP_MESSAGE_MAX_ENCODED_BYTES} encoded bytes.`,
        retryable: false,
      });
      return;
    }

    let envelope: HcpMessage;
    try {
      envelope = parseJsonHcpMessage(raw);
    } catch (error: unknown) {
      this.#sendParseNack(raw, error);
      return;
    }

    switch (envelope.type) {
      case "host.accepted":
        await this.#handleAccepted(envelope);
        return;
      case "host.rejected":
        this.#onLog(`Control plane rejected runner: ${envelope.payload.reason}`);
        await this.close();
        return;
      case "harness.session.start":
        await this.#handleCommand(envelope, (message) => this.#handleSessionStart(message));
        return;
      case "harness.turn.send":
        await this.#handleCommand(envelope, (message) => this.#handleTurnSend(message));
        return;
      case "harness.turn.cancel":
        await this.#handleCommand(envelope, (message) => this.#handleTurnCancel(message));
        return;
      case "harness.session.stop":
        await this.#handleCommand(envelope, (message) => this.#handleSessionStop(message));
        return;
      case "harness.approval.respond":
      case "harness.input.respond":
      case "tool_servers.detach":
        await this.#handleCommand(envelope, () => []);
        return;
      case "hcp.command.ack":
      case "hcp.command.nack":
      case "host.hello":
      case "host.heartbeat":
      case "host.capabilities.updated":
      case "harness.event":
        this.#onLog(`Ignoring inbound ${envelope.type}; it is not a runner command.`);
        return;
      default:
        const unsupportedEnvelope = envelope as { id: string; type: string; payload: unknown };
        this.#sendNack(commandIdFor(unsupportedEnvelope), {
          code: "unsupported_message_type",
          message: `${unsupportedEnvelope.type} is not supported as an inbound runner command.`,
          retryable: false,
        });
    }
  }

  async #handleAccepted(envelope: HcpHostAcceptedMessage): Promise<void> {
    this.#onLog(`Control plane accepted ${envelope.payload.protocol_version}.`);
    await this.#sendCapabilities();
    this.#replayRequestedEvents();
    this.#startHeartbeat(envelope.payload.heartbeat_interval_seconds);
  }

  #replayRequestedEvents(): void {
    if (!this.#resumeCursor) {
      return;
    }
    const events: HcpHarnessEventPayload[] = this.#harnessSessions.replayEventsAfter(this.#resumeCursor);
    for (const event of events) {
      this.#send(createHcpEnvelope("harness.event", event));
    }
  }

  async #handleCommand<TMessage extends Extract<HcpMessage, { type: ControlPlaneCommandMessageType }>>(
    envelope: TMessage,
    handler: (message: TMessage) => HcpHarnessEventPayload[] | Promise<HcpHarnessEventPayload[]>,
  ): Promise<void> {
    const commandId: string = commandIdFor(envelope);
    const commandHash: string = hashCommandPayload(envelope);
    const existingRecord: CommandRecord | undefined = this.#commandRecords.get(commandId);

    if (existingRecord !== undefined) {
      if (existingRecord.payloadHash === commandHash) {
        if (existingRecord.outcome === "pending") {
          const settledRecord: SettledCommandRecord = await existingRecord.completion;
          if (settledRecord.outcome === "ack") {
            this.#sendAck(commandId, true);
          } else {
            this.#sendNackPayload(settledRecord.nackPayload);
          }
          return;
        }
        if (existingRecord.outcome === "ack") {
          this.#sendAck(commandId, true);
        } else {
          this.#sendNackPayload(existingRecord.nackPayload);
        }
        return;
      }

      this.#sendNack(commandId, {
        code: "duplicate_command_payload_mismatch",
        message: `Command '${commandId}' was already seen with a different payload.`,
        retryable: false,
      });
      return;
    }

    let settleCommand: (record: SettledCommandRecord) => void;
    const completion: Promise<SettledCommandRecord> = new Promise<SettledCommandRecord>((resolve) => {
      settleCommand = resolve;
    });
    this.#commandRecords.set(commandId, {
      payloadHash: commandHash,
      outcome: "pending",
      completion,
    });

    try {
      const events: HcpHarnessEventPayload[] = await handler(envelope);
      const record: SettledCommandRecord = {
        payloadHash: commandHash,
        outcome: "ack",
      };
      this.#commandRecords.set(commandId, record);
      settleCommand!(record);
      this.#sendAck(commandId, false);
      for (const event of events) {
        this.#send(createHcpEnvelope("harness.event", event));
      }
    } catch (error: unknown) {
      const nackPayload: HcpNackPayload = createNackPayload(commandId, toHcpError(error));
      const record: SettledCommandRecord = {
        payloadHash: commandHash,
        outcome: "nack",
        nackPayload,
      };
      this.#commandRecords.set(commandId, record);
      settleCommand!(record);
      this.#sendNackPayload(nackPayload);
    }
  }

  #handleSessionStart(envelope: Extract<HcpMessage, { type: "harness.session.start" }>): Promise<HcpHarnessEventPayload[]> {
    return this.#harnessSessions.startSession(envelope.payload);
  }

  #handleTurnSend(envelope: Extract<HcpMessage, { type: "harness.turn.send" }>): Promise<HcpHarnessEventPayload[]> {
    return this.#harnessSessions.sendTurn(envelope.payload);
  }

  #handleTurnCancel(envelope: Extract<HcpMessage, { type: "harness.turn.cancel" }>): Promise<HcpHarnessEventPayload[]> {
    return this.#harnessSessions.cancelTurn(envelope.payload.session_id, envelope.payload.turn_id);
  }

  #handleSessionStop(envelope: Extract<HcpMessage, { type: "harness.session.stop" }>): Promise<HcpHarnessEventPayload[]> {
    return this.#harnessSessions.stopSession(envelope.payload.session_id, envelope.payload.reason);
  }

  async #sendCapabilities(): Promise<void> {
    const registry = new ProviderInstanceRegistry(this.#config, await this.#harnessSessions.providerDriverStatuses());
    const payload: HcpHostCapabilitiesUpdatedPayload = registry.snapshot();
    this.#send(createHcpEnvelope("host.capabilities.updated", payload));
  }

  #startHeartbeat(intervalSeconds: number): void {
    this.#stopHeartbeat();
    const intervalMs: number = Math.max(1, intervalSeconds) * 1000;
    this.#heartbeatTimer = setInterval(() => {
      const payload: HcpHostHeartbeatPayload = {
        host_id: this.#config.host_id ?? this.#config.runner_id,
        status: "online",
        active_sessions: this.#harnessSessions.activeSessionCount(),
      };
      this.#send(createHcpEnvelope("host.heartbeat", payload));
    }, intervalMs);
  }

  #stopHeartbeat(): void {
    if (this.#heartbeatTimer) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = undefined;
    }
  }

  #scheduleReconnect(): void {
    if (this.#reconnectTimer) {
      return;
    }

    const delayMs: number = Math.min(
      this.#reconnectMaxDelayMs,
      this.#reconnectInitialDelayMs * 2 ** this.#reconnectAttempt,
    );
    this.#reconnectAttempt += 1;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      if (this.#closing) {
        return;
      }
      this.#openSocket().catch((error: unknown) => {
        this.#onLog(error instanceof Error ? error.message : "Runner reconnect failed.");
        if (!this.#closing) {
          this.#scheduleReconnect();
        }
      });
    }, delayMs);
  }

  #stopReconnect(): void {
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }
  }

  #send(envelope: unknown): void {
    if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) {
      throw new Error("Runner is not connected to the control plane.");
    }

    this.#socket.send(JSON.stringify(envelope));
  }

  #sendNack(commandId: string, error: HcpError): void {
    this.#sendNackPayload(createNackPayload(commandId, error));
  }

  #sendNackPayload(payload: HcpNackPayload): void {
    this.#send(createHcpEnvelope("hcp.command.nack", payload));
  }

  #sendAck(commandId: string, duplicate: boolean): void {
    const payload: HcpAckPayload = {
      command_id: commandId,
      accepted_at: new Date().toISOString(),
      duplicate,
    };

    this.#send(createHcpEnvelope("hcp.command.ack", payload));
  }

  #sendParseNack(raw: string, error: unknown): void {
    let receivedMessageId = "unknown";
    let payloadHash: string | undefined;
    try {
      const envelope = parseHcpEnvelope(JSON.parse(raw));
      receivedMessageId = envelope.id;
      payloadHash = createHash("sha256").update(stableStringify(envelope.payload)).digest("hex");
    } catch (parseError: unknown) {
      if (!(parseError instanceof Error)) {
        throw parseError;
      }
      receivedMessageId = "unknown";
    }

    const nackPayload: HcpNackPayload = createNackPayload(receivedMessageId, {
      code: "invalid_message",
      message: error instanceof Error ? error.message : "Control plane message failed validation.",
      retryable: false,
    });
    if (payloadHash !== undefined) {
      this.#commandRecords.set(receivedMessageId, {
        payloadHash,
        outcome: "nack",
        nackPayload,
      });
    }
    this.#sendNackPayload(nackPayload);
  }
}

function toHcpError(error: unknown): HcpError {
  if (error instanceof HarnessSessionError) {
    return {
      code: error.code,
      message: error.message,
      retryable: false,
    };
  }

  if (error instanceof HarnessAdapterError) {
    return {
      code: error.code,
      message: error.message,
      retryable: false,
    };
  }

  if (error instanceof Error) {
    return {
      code: "runner_error",
      message: error.message,
      retryable: false,
    };
  }

  return {
    code: "runner_error",
    message: "Runner command failed.",
    retryable: false,
  };
}

function createNackPayload(commandId: string, error: HcpError): HcpNackPayload {
  return {
    command_id: commandId,
    rejected_at: new Date().toISOString(),
    error,
  };
}

function commandIdFor(envelope: HcpMessage | { id: string; payload: unknown }): string {
  if (typeof envelope.payload === "object" && envelope.payload !== null && "command_id" in envelope.payload) {
    const commandId: unknown = envelope.payload.command_id;
    if (typeof commandId === "string" && commandId.length > 0) {
      return commandId;
    }
  }

  return envelope.id;
}

function hashCommandPayload(envelope: HcpMessage): string {
  return createHash("sha256").update(stableStringify(envelope.payload)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item: unknown): string => stableStringify(item)).join(",")}]`;
  }

  const entries: Array<[string, unknown]> = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entryValue]): string => `${JSON.stringify(key)}:${stableStringify(entryValue)}`).join(",")}}`;
}
