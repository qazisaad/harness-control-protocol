import {convexRunnerDemandSource, type RunnerDemandSource} from "./runner-demand.js";
import type {RunnerCredential} from "../pairing/index.js";
import { AccountUsageReader } from "../accounts/index.js";
import { WorkspaceManager } from "../workspaces/index.js";
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
  type HcpSessionSnapshotPayload,
  type HcpConversationResultPayload,
  type HcpAckPayload,
  type HcpNackPayload,
  type ControlPlaneCommandMessageType,
  type LocalActionErrorPayload,
  type LocalActionResponsePayload,
} from "@harness-control/protocol";
import WebSocket from "ws";

import type { RunnerConfig } from "../config/index.js";
import { HarnessAdapterError } from "../harnesses/adapters.js";
import { HarnessSessionError, HarnessSessionManager, type HarnessReplayResult } from "../harnesses/index.js";
import { ProviderInstanceRegistry } from "../host/provider-registry.js";
import { withWorkspaceGit } from "../workspaces/git.js";
import { LocalActionDispatcher, type LocalActionDispatchOutcome } from "../local-actions/dispatcher.js";
import { LocalCapabilityExecutor } from "../local-actions/executors.js";
import type {
  PersistedCommandReceipt,
  PersistedLocalActionReceipt,
  RunnerStateStore,
} from "../state/index.js";

type CommandRecord =
  | {
      payloadHash: string;
      outcome: "pending";
      completion: Promise<SettledCommandRecord>;
    }
  | {
      payloadHash: string;
      outcome: "ack";
      snapshotPayload?: HcpSessionSnapshotPayload;
      conversationPayload?: HcpConversationResultPayload;
    }
  | {
      payloadHash: string;
      outcome: "nack";
      nackPayload: HcpNackPayload;
    };

type SettledCommandRecord = Exclude<CommandRecord, { outcome: "pending" }>;

type CommandExecutionResult = {
  events: HcpHarnessEventPayload[];
  snapshotPayload?: HcpSessionSnapshotPayload;
  conversationPayload?: HcpConversationResultPayload;
};

type LocalActionRecord =
  | {
      payloadHash: string;
      requestPayload: Extract<HcpMessage, { type: "local.action.request" }>["payload"];
      outcome: "pending";
      completion: Promise<SettledLocalActionRecord>;
    }
  | {
      payloadHash: string;
      requestPayload: Extract<HcpMessage, { type: "local.action.request" }>["payload"];
      outcome: "response";
      payload: LocalActionResponsePayload;
    }
  | {
      payloadHash: string;
      requestPayload: Extract<HcpMessage, { type: "local.action.request" }>["payload"];
      outcome: "error";
      payload: LocalActionErrorPayload;
    };

type SettledLocalActionRecord = Exclude<LocalActionRecord, { outcome: "pending" }>;

export type RunnerReconnectOptions = {
  initialDelayMs?: number;
  maxDelayMs?: number;
};

type RunnerAuthorization = {connection_token: string; demand?: {convex_url: string; query_name: "hcp:runnerDemand"; idle_seconds: number} | undefined};

export type RunnerConnectionOptions = {
  demandCredential?: RunnerCredential;
  demandSource?: RunnerDemandSource;
  idleMs?: number;
  config: RunnerConfig;
  configPath?: string;
  runnerVersion: string;
  connectionTokenProvider?: () => Promise<string | RunnerAuthorization | undefined>;
  onLog?: (message: string) => void;
  harnessSessions?: HarnessSessionManager;
  reconnect?: RunnerReconnectOptions;
  accountUsage?: AccountUsageReader;
};

export class RunnerConnection {
  readonly #config: RunnerConfig;
  readonly #workspaces: WorkspaceManager;
  readonly #runnerVersion: string;
  readonly #connectionTokenProvider: (() => Promise<string | RunnerAuthorization | undefined>) | undefined;
  readonly #onLog: (message: string) => void;
  readonly #harnessSessions: HarnessSessionManager;
  readonly #stateStore: RunnerStateStore;
  readonly #localActionDispatcher: LocalActionDispatcher;
  readonly #reconnectInitialDelayMs: number;
  readonly #reconnectMaxDelayMs: number;
  readonly #accountUsage: AccountUsageReader;
  readonly #demandCredential: RunnerCredential | undefined;
  #demandSource: RunnerDemandSource | undefined;
  #stopDemand: (() => void) | undefined;
  #demandReady = false;
  #demandPending = false;
  #demandGeneration: number | undefined;
  #idle = false;
  #idleTimer: NodeJS.Timeout | undefined;
  #idleMs: number;
  #lastActivity = Date.now();
  #opening: Promise<void> | undefined;
  #messageTasks = 0;
  #accepted = false;
  #socket: WebSocket | undefined;
  #heartbeatTimer: NodeJS.Timeout | undefined;
  #reconnectTimer: NodeJS.Timeout | undefined;
  #reconnectAttempt = 0;
  #closing = false;
  readonly #commandRecords = new Map<string, CommandRecord>();
  readonly #localActionRecords = new Map<string, LocalActionRecord>();
  readonly #localActionMismatchRecords = new Map<string, SettledLocalActionRecord>();
  readonly #lastSentEvent = new Map<string, number>();
  #unsubscribeEvents: (() => void) | undefined;

  constructor(options: RunnerConnectionOptions) {
    this.#config = options.config;
    this.#demandCredential = options.demandCredential;
    this.#demandSource = options.demandSource;
    this.#idleMs = options.idleMs ?? 300_000;
    this.#accountUsage = options.accountUsage ?? new AccountUsageReader(options.config);
    this.#runnerVersion = options.runnerVersion;
    this.#connectionTokenProvider = options.connectionTokenProvider;
    this.#onLog = options.onLog ?? (() => undefined);
    this.#harnessSessions = options.harnessSessions ?? new HarnessSessionManager(options.config);
    this.#stateStore = this.#harnessSessions.stateStore();
    this.#workspaces = new WorkspaceManager(options.config, options.configPath, this.#harnessSessions);
    this.#localActionDispatcher = new LocalActionDispatcher({
      executor: new LocalCapabilityExecutor(this.#harnessSessions.localCapabilityEngine()),
      resolveContext: (payload) => this.#harnessSessions.resolveLocalActionContext(payload),
      emitEvents: (sessionId, turnId, events) =>
        this.#harnessSessions.recordLocalActionEvents(sessionId, turnId, events),
    });
    this.#reconnectInitialDelayMs = options.reconnect?.initialDelayMs ?? 1_000;
    this.#reconnectMaxDelayMs = options.reconnect?.maxDelayMs ?? 30_000;
  }

  async connect(): Promise<void> {
    this.#closing = false;
    this.#unsubscribeEvents ??= this.#harnessSessions.subscribeEvents(event => {if (this.#accepted) this.#sendEventIfConnected(event);},
      error => this.#onLog(error instanceof Error ? error.message : "Session event publication failed."));
    this.#subscribeDemand();
    await this.#openSocket();
  }

  async #openSocket(): Promise<void> {
    this.#stopReconnect();
    const authorization = this.#connectionTokenProvider
      ? await this.#connectionTokenProvider()
      : undefined;
    if (this.#closing || this.#idle) return;
    const connectionToken = typeof authorization === "string" ? authorization : authorization?.connection_token;
    if (typeof authorization === "object" && authorization.demand && this.#demandCredential && !this.#demandSource) {
      this.#idleMs = authorization.demand.idle_seconds * 1000;
      this.#demandSource = convexRunnerDemandSource(authorization.demand.convex_url, this.#demandCredential);
      this.#subscribeDemand();
    }
    const socket = new WebSocket(this.#config.control_plane_url, {
      ...(connectionToken ? { headers: { authorization: `Bearer ${connectionToken}` } } : {}),
    });
    this.#socket = socket;
    this.#accepted = false;
    this.#lastSentEvent.clear();

    socket.on("message", (data: WebSocket.RawData) => {
      if (this.#socket !== socket) return;
      this.#messageTasks++;
      this.#handleMessage(data.toString()).catch((error: unknown) => {
        this.#onLog(error instanceof Error ? error.message : "Failed to handle control plane message.");
      }).finally(() => {this.#messageTasks--; this.#lastActivity = Date.now();});
    });

    socket.on("close", () => {
      if (this.#socket !== socket) return;
      if (this.#socket === socket) {
        this.#socket = undefined;
        this.#accepted = false;
      }
      this.#stopHeartbeat();
      this.#onLog("Runner disconnected from control plane.");
      if (!this.#closing && !this.#idle) {
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
    this.#stopDemand?.(); this.#stopDemand = undefined;
    if (this.#idleTimer) clearInterval(this.#idleTimer); this.#idleTimer = undefined;
    this.#accepted = false;
    this.#unsubscribeEvents?.(); this.#unsubscribeEvents = undefined;
    try {
      await this.#accountUsage.close();
      await this.#harnessSessions.close();
    } finally {
      // Transport disposal cannot be held open by an honest unknown native closure.
      // The shutdown error and durable execution fence remain intact.
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
  }

  #sendHello(): void {
    const retainedEvents = this.#harnessSessions.retainedEventRanges();
    const payload: HcpHostHelloPayload = {
      runner_id: this.#config.runner_id,
      host_id: this.#config.host_id ?? this.#config.runner_id,
      runner_version: this.#runnerVersion,
      supported_protocol_versions: [HCP_VERSION],
      capabilities: [
        "providers",
        "account_usage",
        "workspaces",
        "mcp_streamable_http",
        "local_filesystem",
        "local_git",
        "local_shell",
        "local_dev_server",
        "durable_at_least_once",
        "session_snapshots",
      ],
      ...(retainedEvents ? { retained_events: retainedEvents } : {}),
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

    if (envelope.type !== "host.accepted") this.#lastActivity = Date.now();
    switch (envelope.type) {
      case "host.accepted":
        await this.#handleAccepted(envelope);
        return;
      case "host.rejected":
        this.#onLog(`Control plane rejected runner: ${envelope.payload.reason}`);
        await this.close();
        return;
      case "host.accounts.read": {
        const socket = this.#socket;
        if (!this.#accepted) {
          this.#sendNack(envelope.id, { code: "host_not_accepted", message: "Accept the host before reading account usage.", retryable: false });
          return;
        }
        try {
          const payload = await this.#accountUsage.read(envelope.id, envelope.payload);
          if (socket === this.#socket && this.#accepted) this.#send(createHcpEnvelope("host.accounts.snapshot", payload));
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          if (socket === this.#socket && this.#accepted) this.#sendNack(envelope.id, { code: "account_read_failed", message: "Cannot read the requested provider accounts.", retryable: false });
        }
        return;
      }
      case "host.accounts.snapshot":
        return;
      case "host.workspaces.request": {
        const socket = this.#socket;
        if (!this.#accepted) return;
        const started = performance.now();
        const result = await this.#workspaces.execute(envelope.id, envelope.payload);
        // Directory reads must not probe every provider or republish the catalog.
        if (envelope.metadata?.interactive_refresh === true) await this.#sendCapabilities();
        if (socket === this.#socket && this.#accepted) this.#send(createHcpEnvelope("host.workspaces.result", result, {duration_ms: performance.now() - started}));
        if (envelope.payload.operation.kind !== "browse" && envelope.metadata?.interactive_refresh !== true) await this.#sendCapabilities();
        return;
      }
      case "host.workspaces.result":
        return;
      case "harness.session.start":
        await this.#handleCommand(envelope, (message) => this.#handleSessionStart(message));
        return;
      case "harness.conversation.request":
        await this.#handleCommand(envelope, async message => ({events: [],
          conversationPayload: await this.#harnessSessions.conversationOperation(message.id, message.payload)}));
        return;
      case "harness.session.snapshot.request":
        await this.#handleCommand(envelope, (message) => ({
          events: [],
          snapshotPayload: this.#harnessSessions.sessionSnapshot(message.id, message.payload.session_id),
        }));
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
        await this.#handleCommand(envelope, async message => {
          const resolution = await this.#harnessSessions.respondToMcpReview(message.payload, event => this.#sendEventIfConnected(event));
          if (resolution.kind === "resumed") this.#watchTurn(resolution.completion, message.payload.session_id, message.payload.turn_id);
          return [];
        });
        return;
      case "harness.input.respond":
        await this.#handleCommand(envelope, async message => {
          const resolution = await this.#harnessSessions.respondToMcpInput(message.payload, event => this.#sendEventIfConnected(event));
          if (resolution.kind === "resumed" && message.payload.request_scope !== "session") this.#watchTurn(resolution.completion, message.payload.session_id, message.payload.turn_id);
          return [];
        });
        return;
      case "tool_servers.detach":
        await this.#handleCommand(envelope, message => this.#harnessSessions.detachToolServers(message.payload));
        return;
      case "local.action.request":
        await this.#handleLocalAction(envelope);
        return;
      case "hcp.command.ack":
      case "hcp.command.nack":
      case "host.hello":
      case "host.heartbeat":
      case "host.capabilities.updated":
      case "host.replay.unavailable":
      case "harness.session.snapshot":
      case "harness.conversation.result":
      case "local.action.response":
      case "local.action.error":
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
    this.#accepted = true;
    this.#lastActivity = Date.now();
    this.#onLog(`Control plane accepted ${envelope.payload.protocol_version}.`);
    const socket = this.#socket;
    await this.#sendCapabilities();
    // Capability observation can outlast the connection; never start its timers after close or reconnect.
    if (this.#closing || !this.#accepted || socket !== this.#socket) return;
    this.#replayRequestedEvents(envelope.payload.resume);
    this.#startHeartbeat(envelope.payload.heartbeat_interval_seconds);
    if (this.#demandSource && !this.#idleTimer) this.#idleTimer = setInterval(() => this.#checkIdle(), Math.min(5000, this.#idleMs));
    await this.#harnessSessions.recoverMcpReviews(event => this.#sendEventIfConnected(event),
      (completion, sessionId, turnId) => this.#watchTurn(completion, sessionId, turnId));
  }

  #replayRequestedEvents(cursor: HcpHostAcceptedMessage["payload"]["resume"]): void {
    if (!cursor) {
      return;
    }
    const replay: HarnessReplayResult = this.#harnessSessions.replayEventsAfter(cursor);
    for (const unavailable of replay.unavailable) {
      this.#send(createHcpEnvelope("host.replay.unavailable", unavailable));
    }
    for (const event of replay.events) {
      this.#sendEventIfConnected(event);
    }
  }

  async #handleCommand<TMessage extends Extract<HcpMessage, { type: ControlPlaneCommandMessageType }>>(
    envelope: TMessage,
    handler: (
      message: TMessage,
    ) => HcpHarnessEventPayload[] | CommandExecutionResult | Promise<HcpHarnessEventPayload[] | CommandExecutionResult>,
  ): Promise<void> {
    const commandId: string = commandIdFor(envelope);
    const commandHash: string = hashCommandPayload(envelope);
    const persistedReceipt: PersistedCommandReceipt | undefined = this.#stateStore.getCommandReceipt(commandId);
    const existingRecord: CommandRecord | undefined =
      this.#commandRecords.get(commandId) ?? (persistedReceipt ? commandRecordFromReceipt(persistedReceipt) : undefined);

    if (existingRecord !== undefined) {
      if (existingRecord.payloadHash === commandHash) {
        if (existingRecord.outcome === "pending") {
          const settledRecord: SettledCommandRecord = await existingRecord.completion;
          if (settledRecord.outcome === "ack") {
            this.#sendAck(commandId, true);
            if (settledRecord.snapshotPayload) {
              this.#send(createHcpEnvelope("harness.session.snapshot", settledRecord.snapshotPayload));
            }
            if (settledRecord.conversationPayload) this.#send(createHcpEnvelope("harness.conversation.result", settledRecord.conversationPayload));
          } else {
            this.#sendNackPayload(settledRecord.nackPayload);
          }
          return;
        }
        if (existingRecord.outcome === "ack") {
          this.#sendAck(commandId, true);
          if (existingRecord.snapshotPayload) {
            this.#send(createHcpEnvelope("harness.session.snapshot", existingRecord.snapshotPayload));
          }
          if (existingRecord.conversationPayload) this.#send(createHcpEnvelope("harness.conversation.result", existingRecord.conversationPayload));
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
      const execution: HcpHarnessEventPayload[] | CommandExecutionResult = await handler(envelope);
      const result: CommandExecutionResult = Array.isArray(execution) ? { events: execution } : execution;
      const settledAt: string = new Date().toISOString();
      const record: SettledCommandRecord = {
        payloadHash: commandHash,
        outcome: "ack",
        ...(result.snapshotPayload ? { snapshotPayload: result.snapshotPayload } : {}),
        ...(result.conversationPayload ? {conversationPayload: result.conversationPayload} : {}),
      };
      this.#commandRecords.set(commandId, record);
      this.#stateStore.setCommandReceipt(commandId, {
        payloadHash: commandHash,
        outcome: "ack",
        settledAt,
        ...(result.snapshotPayload ? { snapshotPayload: result.snapshotPayload } : {}),
        ...(result.conversationPayload ? {conversationPayload: result.conversationPayload} : {}),
      });
      settleCommand!(record);
      this.#sendAck(commandId, false);
      if (result.snapshotPayload) {
        this.#send(createHcpEnvelope("harness.session.snapshot", result.snapshotPayload));
      }
      if (result.conversationPayload) this.#send(createHcpEnvelope("harness.conversation.result", result.conversationPayload));
      for (const event of result.events) {
        this.#sendEventIfConnected(event);
      }
    } catch (error: unknown) {
      const nackPayload: HcpNackPayload = createNackPayload(commandId, toHcpError(error));
      const record: SettledCommandRecord = {
        payloadHash: commandHash,
        outcome: "nack",
        nackPayload,
      };
      this.#commandRecords.set(commandId, record);
      this.#stateStore.setCommandReceipt(commandId, {
        payloadHash: commandHash,
        outcome: "nack",
        settledAt: new Date().toISOString(),
        nackPayload,
      });
      settleCommand!(record);
      this.#sendNackPayload(nackPayload);
    }
  }

  async #handleSessionStart(envelope: Extract<HcpMessage, { type: "harness.session.start" }>): Promise<HcpHarnessEventPayload[]> {
    const admittedSocket = this.#socket;
    this.#localActionDispatcher.markSessionActive(envelope.payload.session_id);
    try {
      const events = await this.#harnessSessions.startSession(envelope.payload);
      if (envelope.payload.first_turn) {
        if (admittedSocket !== this.#socket || !this.#accepted || this.#socket?.readyState !== WebSocket.OPEN) {
          await this.#harnessSessions.cancelTurn(envelope.payload.session_id, envelope.payload.first_turn.turn_id);
        }
        for (const event of events) this.#sendEventIfConnected(event);
        this.#watchTurn(this.#harnessSessions.sendFirstTurn(envelope.payload, event => this.#sendEventIfConnected(event)),
          envelope.payload.session_id, envelope.payload.first_turn.turn_id);
        return [];
      }
      return events;
    } catch (error: unknown) {
      const replay = this.#harnessSessions.replayEventsAfter({sessions: [
        {session_id: envelope.payload.session_id, last_event_sequence: 0},
      ]});
      for (const event of replay.events) this.#sendEventIfConnected(event);
      throw error;
    }
  }

  #handleTurnSend(envelope: Extract<HcpMessage, { type: "harness.turn.send" }>): HcpHarnessEventPayload[] {
    const completion: Promise<HcpHarnessEventPayload[]> = this.#harnessSessions.sendTurn(
      envelope.payload,
      (event: HcpHarnessEventPayload): void => this.#sendEventIfConnected(event),
    );
    this.#watchTurn(completion, envelope.payload.session_id, envelope.payload.turn_id);
    return [];
  }

  #watchTurn(completion: Promise<HcpHarnessEventPayload[]>, sessionId: string, turnId: string): void {
    completion
      .then((events: HcpHarnessEventPayload[]): void => {
        for (const event of events) {
          this.#sendEventIfConnected(event);
        }
      })
      .catch((error: unknown): void => {
        const failedEvent: HcpHarnessEventPayload = this.#harnessSessions.recordTurnFailure(
          sessionId,
          turnId,
          error,
        );
        this.#sendEventIfConnected(failedEvent);
      });
  }

  #handleTurnCancel(envelope: Extract<HcpMessage, { type: "harness.turn.cancel" }>): Promise<HcpHarnessEventPayload[]> {
    return this.#harnessSessions.cancelTurn(envelope.payload.session_id, envelope.payload.turn_id);
  }

  async #handleSessionStop(envelope: Extract<HcpMessage, { type: "harness.session.stop" }>): Promise<HcpHarnessEventPayload[]> {
    const events: HcpHarnessEventPayload[] = await this.#harnessSessions.stopSession(
      envelope.payload.session_id,
      envelope.payload.reason,
    );
    await this.#localActionDispatcher.stopDevServersForSession(envelope.payload.session_id);
    return events;
  }

  async #handleLocalAction(envelope: Extract<HcpMessage, { type: "local.action.request" }>): Promise<void> {
    const requestId: string = envelope.payload.request_id;
    const payloadHash: string = hashCommandPayload(envelope);
    const persistedReceipt: PersistedLocalActionReceipt | undefined = this.#stateStore.getLocalActionReceipt(requestId);
    const existingRecord: LocalActionRecord | undefined =
      this.#localActionRecords.get(requestId) ??
      (persistedReceipt ? localActionRecordFromReceipt(persistedReceipt) : undefined);

    if (existingRecord !== undefined) {
      if (existingRecord.payloadHash === payloadHash) {
        if (existingRecord.outcome === "pending") {
          const settledRecord: SettledLocalActionRecord = await existingRecord.completion;
          this.#sendLocalActionRecord(settledRecord);
          return;
        }
        this.#sendLocalActionRecord(existingRecord);
        return;
      }

      const mismatchKey: string = `${requestId}:${payloadHash}`;
      const existingMismatchRecord: SettledLocalActionRecord | undefined = this.#localActionMismatchRecords.get(mismatchKey);
      if (existingMismatchRecord) {
        this.#sendLocalActionRecord(existingMismatchRecord);
        return;
      }

      const mismatchOutcome: LocalActionDispatchOutcome = this.#localActionDispatcher.duplicatePayloadMismatch(envelope.payload);
      const mismatchRecord: SettledLocalActionRecord =
        mismatchOutcome.type === "response"
          ? {
              payloadHash,
              requestPayload: envelope.payload,
              outcome: "response",
              payload: mismatchOutcome.payload,
            }
          : {
              payloadHash,
              requestPayload: envelope.payload,
              outcome: "error",
              payload: mismatchOutcome.payload,
            };
      this.#localActionMismatchRecords.set(mismatchKey, mismatchRecord);
      for (const event of mismatchOutcome.events) {
        this.#sendEventIfConnected(event);
      }
      this.#sendLocalActionRecord(mismatchRecord);
      return;
    }

    let settleLocalAction: (record: SettledLocalActionRecord) => void;
    const completion: Promise<SettledLocalActionRecord> = new Promise<SettledLocalActionRecord>((resolve) => {
      settleLocalAction = resolve;
    });
    this.#localActionRecords.set(requestId, {
      payloadHash,
      requestPayload: envelope.payload,
      outcome: "pending",
      completion,
    });

    const outcome: LocalActionDispatchOutcome = await this.#localActionDispatcher.dispatch(envelope.payload);
    const record: SettledLocalActionRecord =
      outcome.type === "response"
        ? {
            payloadHash,
            requestPayload: envelope.payload,
            outcome: "response",
            payload: outcome.payload,
          }
        : {
            payloadHash,
            requestPayload: envelope.payload,
            outcome: "error",
            payload: outcome.payload,
          };
    this.#localActionRecords.set(requestId, record);
    const persistedRecord: PersistedLocalActionReceipt =
      record.outcome === "response"
        ? {
            payloadHash,
            requestPayload: envelope.payload,
            outcome: "response",
            settledAt: new Date().toISOString(),
            payload: record.payload,
          }
        : {
            payloadHash,
            requestPayload: envelope.payload,
            outcome: "error",
            settledAt: new Date().toISOString(),
            payload: record.payload,
          };
    this.#stateStore.setLocalActionReceipt(requestId, persistedRecord);
    settleLocalAction!(record);
    for (const event of outcome.events) {
      this.#sendEventIfConnected(event);
    }
    this.#sendLocalActionRecord(record);
  }

  async #sendCapabilities(): Promise<void> {
    const socket = this.#socket;
    const registry = new ProviderInstanceRegistry(this.#config, await this.#harnessSessions.providerDriverStatuses());
    const snapshot = registry.snapshot();
    const payload: HcpHostCapabilitiesUpdatedPayload = { ...snapshot, workspaces: await withWorkspaceGit(snapshot.workspaces), workspace_management: this.#workspaces.snapshot() };
    if (socket === this.#socket && this.#accepted) this.#send(createHcpEnvelope("host.capabilities.updated", payload));
  }

  #subscribeDemand(): void {
    if (!this.#demandSource || this.#stopDemand) return;
    this.#stopDemand = this.#demandSource.subscribe(state => {
      const changed = this.#demandGeneration !== undefined && state.generation > this.#demandGeneration;
      this.#demandGeneration = state.generation;
      this.#demandReady = true;
      this.#demandPending = state.pending;
      if (changed || state.pending) {this.#lastActivity = Date.now(); this.#wakeFromIdle();}
    }, () => {
      // Never deliberately disconnect without a working wake path.
      this.#demandReady = false;
      this.#wakeFromIdle();
    });
  }

  #wakeFromIdle(): void {
    if (!this.#idle || this.#closing) return;
    this.#idle = false;
    this.#lastActivity = Date.now();
    // Wait for the old close before replacing it; stale close handlers must not
    // stop a new socket's heartbeat or schedule a duplicate reconnect.
    const old = this.#socket;
    const open = () => {
      if (this.#opening || this.#closing) return;
      this.#opening = this.#openSocket().catch(() => this.#scheduleReconnect()).finally(() => {this.#opening = undefined;});
    };
    if (old && old.readyState !== WebSocket.CLOSED) old.once("close", open); else open();
  }

  #checkIdle(): void {
    const pending = [...this.#commandRecords.values(), ...this.#localActionRecords.values()].some(record => record.outcome === "pending");
    if (!this.#accepted || !this.#demandReady || this.#demandPending || this.#messageTasks || pending || this.#harnessSessions.hasActiveWork()) {this.#lastActivity = Date.now(); return;}
    if (Date.now() - this.#lastActivity < this.#idleMs) return;
    this.#idle = true;
    this.#stopReconnect(); this.#stopHeartbeat();
    this.#socket?.close(4001, "hcp-idle");
    this.#onLog("Runner transport sleeping; workflow or settings activity will reconnect it.");
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
      if (this.#closing || this.#idle) {
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

  #sendEventIfConnected(event: HcpHarnessEventPayload): void {
    this.#lastActivity = Date.now();
    if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) {
      return;
    }
    if (event.sequence <= (this.#lastSentEvent.get(event.session_id) ?? 0)) return;
    this.#socket.send(JSON.stringify(createHcpEnvelope("harness.event", event)));
    this.#lastSentEvent.set(event.session_id, event.sequence);
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

  #sendLocalActionRecord(record: SettledLocalActionRecord): void {
    if (record.outcome === "response") {
      this.#send(createHcpEnvelope("local.action.response", record.payload));
      return;
    }
    this.#send(createHcpEnvelope("local.action.error", record.payload));
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
      const record: SettledCommandRecord = {
        payloadHash,
        outcome: "nack",
        nackPayload,
      };
      this.#commandRecords.set(receivedMessageId, record);
      this.#stateStore.setCommandReceipt(receivedMessageId, {
        payloadHash,
        outcome: "nack",
        settledAt: new Date().toISOString(),
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

function commandRecordFromReceipt(receipt: PersistedCommandReceipt): SettledCommandRecord {
  return receipt.outcome === "ack"
    ? {
        payloadHash: receipt.payloadHash,
        outcome: "ack",
        ...(receipt.snapshotPayload ? { snapshotPayload: receipt.snapshotPayload } : {}),
        ...(receipt.conversationPayload ? {conversationPayload: receipt.conversationPayload} : {}),
      }
    : {
        payloadHash: receipt.payloadHash,
        outcome: "nack",
        nackPayload: receipt.nackPayload,
      };
}

function localActionRecordFromReceipt(receipt: PersistedLocalActionReceipt): SettledLocalActionRecord {
  return receipt.outcome === "response"
    ? {
        payloadHash: receipt.payloadHash,
        requestPayload: receipt.requestPayload,
        outcome: "response",
        payload: receipt.payload,
      }
    : {
        payloadHash: receipt.payloadHash,
        requestPayload: receipt.requestPayload,
        outcome: "error",
        payload: receipt.payload,
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
