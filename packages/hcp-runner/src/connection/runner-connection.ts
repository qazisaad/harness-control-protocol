import {
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
} from "@hcp-runner/protocol";
import WebSocket from "ws";

import type { RunnerConfig } from "../config/index.js";
import { HarnessSessionError, HarnessSessionManager } from "../harnesses/index.js";
import { ProviderInstanceRegistry } from "../host/provider-registry.js";

export type RunnerConnectionOptions = {
  config: RunnerConfig;
  runnerVersion: string;
  lastEventSequence?: number;
  onLog?: (message: string) => void;
  harnessSessions?: HarnessSessionManager;
};

export class RunnerConnection {
  readonly #config: RunnerConfig;
  readonly #runnerVersion: string;
  readonly #lastEventSequence: number | undefined;
  readonly #onLog: (message: string) => void;
  readonly #harnessSessions: HarnessSessionManager;
  #socket: WebSocket | undefined;
  #heartbeatTimer: NodeJS.Timeout | undefined;
  #heartbeatSequence = 0;

  constructor(options: RunnerConnectionOptions) {
    this.#config = options.config;
    this.#runnerVersion = options.runnerVersion;
    this.#lastEventSequence = options.lastEventSequence;
    this.#onLog = options.onLog ?? (() => undefined);
    this.#harnessSessions = options.harnessSessions ?? new HarnessSessionManager(options.config);
  }

  async connect(): Promise<void> {
    const socket = new WebSocket(this.#config.control_plane_url);
    this.#socket = socket;

    socket.on("message", (data: WebSocket.RawData) => {
      this.#handleMessage(data.toString()).catch((error: unknown) => {
        this.#onLog(error instanceof Error ? error.message : "Failed to handle control plane message.");
      });
    });

    socket.on("close", () => {
      this.#stopHeartbeat();
      this.#onLog("Runner disconnected from control plane.");
    });

    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => {
        this.#sendHello();
        resolve();
      });
      socket.once("error", reject);
    });
  }

  async close(): Promise<void> {
    this.#stopHeartbeat();
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
      capabilities: ["providers", "workspaces", "mcp_attachments"],
      ...(this.#lastEventSequence === undefined ? {} : { last_event_sequence: this.#lastEventSequence }),
    };

    this.#send(createHcpEnvelope("host.hello", payload));
  }

  async #handleMessage(raw: string): Promise<void> {
    let envelope: HcpMessage;
    try {
      envelope = parseJsonHcpMessage(raw);
    } catch (error: unknown) {
      this.#sendParseNack(raw, error);
      return;
    }

    switch (envelope.type) {
      case "host.accepted":
        this.#handleAccepted(envelope);
        return;
      case "session.start":
        this.#handleSessionStart(envelope);
        return;
      case "turn.send":
        this.#handleTurnSend(envelope);
        return;
      case "ack":
      case "nack":
        return;
      default:
        this.#sendNack(envelope.id, {
          code: "unsupported_message_type",
          message: `${envelope.type} is not supported as an inbound runner command.`,
          retryable: false,
        });
    }
  }

  #handleAccepted(envelope: HcpHostAcceptedMessage): void {
    this.#onLog(`Control plane accepted ${envelope.payload.protocol_version}.`);
    this.#sendCapabilities();
    this.#startHeartbeat(envelope.payload.heartbeat_interval_seconds);
  }

  #handleSessionStart(envelope: Extract<HcpMessage, { type: "session.start" }>): void {
    try {
      const events: HcpHarnessEventPayload[] = this.#harnessSessions.startSession(envelope.payload);
      for (const event of events) {
        this.#send(createHcpEnvelope("harness.event", event));
      }
      this.#sendAck(envelope.id);
    } catch (error: unknown) {
      this.#sendNack(envelope.id, toHcpError(error));
    }
  }

  #handleTurnSend(envelope: Extract<HcpMessage, { type: "turn.send" }>): void {
    try {
      const events: HcpHarnessEventPayload[] = this.#harnessSessions.sendTurn(envelope.payload);
      for (const event of events) {
        this.#send(createHcpEnvelope("harness.event", event));
      }
      this.#sendAck(envelope.id);
    } catch (error: unknown) {
      this.#sendNack(envelope.id, toHcpError(error));
    }
  }

  #sendCapabilities(): void {
    const registry = new ProviderInstanceRegistry(this.#config);
    const payload: HcpHostCapabilitiesUpdatedPayload = registry.snapshot();
    this.#send(createHcpEnvelope("host.capabilities.updated", payload));
  }

  #startHeartbeat(intervalSeconds: number): void {
    this.#stopHeartbeat();
    const intervalMs: number = Math.max(1, intervalSeconds) * 1000;
    this.#heartbeatTimer = setInterval(() => {
      const payload: HcpHostHeartbeatPayload = {
        runner_id: this.#config.runner_id,
        sequence: this.#heartbeatSequence,
      };
      this.#heartbeatSequence += 1;
      this.#send(createHcpEnvelope("host.heartbeat", payload));
    }, intervalMs);
  }

  #stopHeartbeat(): void {
    if (this.#heartbeatTimer) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = undefined;
    }
  }

  #send(envelope: unknown): void {
    if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) {
      throw new Error("Runner is not connected to the control plane.");
    }

    this.#socket.send(JSON.stringify(envelope));
  }

  #sendNack(receivedMessageId: string, error: HcpError): void {
    const payload: HcpNackPayload = {
      received_message_id: receivedMessageId,
      status: "nack",
      error,
    };

    this.#send(createHcpEnvelope("nack", payload));
  }

  #sendAck(receivedMessageId: string): void {
    const payload: HcpAckPayload = {
      received_message_id: receivedMessageId,
      status: "ack",
    };

    this.#send(createHcpEnvelope("ack", payload));
  }

  #sendParseNack(raw: string, error: unknown): void {
    let receivedMessageId = "unknown";
    try {
      const envelope = parseHcpEnvelope(JSON.parse(raw));
      receivedMessageId = envelope.id;
    } catch {
      receivedMessageId = "unknown";
    }

    this.#sendNack(receivedMessageId, {
      code: "invalid_message",
      message: error instanceof Error ? error.message : "Control plane message failed validation.",
      retryable: false,
    });
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
