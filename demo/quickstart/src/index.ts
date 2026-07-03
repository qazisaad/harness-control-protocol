import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { realpath, readFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";

import {
  HCP_VERSION,
  createHcpEnvelope,
  parseHcpMessage,
  type CommandPolicy,
  type HarnessProviderSnapshot,
  type HcpAckPayload,
  type HcpError,
  type HcpHarnessEventPayload,
  type HcpHostAcceptedPayload,
  type HcpHostCapabilitiesUpdatedPayload,
  type HcpKnownMessageType,
  type HcpMessage,
  type HcpNackPayload,
  type HcpSessionStartPayload,
  type HcpTurnSendPayload,
  type LocalActionApprovalBinding,
  type LocalActionErrorPayload,
  type LocalDevServerStartInput,
  type LocalShellExecInput,
  type LocalActionRequestPayload,
  type LocalActionResponsePayload,
  type LocalCapabilityLease,
  type McpServerAttachment,
} from "@harness-control/protocol";
import { RunnerConnection } from "@harness-control/runner/connection";
import type { ProviderInstanceConfig, RunnerConfig } from "@harness-control/runner/config";
import { HarnessSessionManager } from "@harness-control/runner/harnesses";
import { createDevelopmentHmacProofSigner } from "@harness-control/runner/mcp";
import { startSampleMcpServer, type SampleMcpServer } from "@harness-control/sample-mcp-server";
import { WebSocket, WebSocketServer } from "ws";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8790;
const PORT_SEARCH_LIMIT = 10;
const HEARTBEAT_INTERVAL_SECONDS = 30;
const RUNNER_ID = "quickstart-runner";
const HOST_ID = "quickstart-host";
const WORKSPACE_ID = "repo";
const LOCAL_SESSION_ID = "quickstart-local-actions";
const LOCAL_TURN_ID = "quickstart-local-turn";
const LOCAL_PROVIDER_ID = "mock-provider";
const MCP_PROOF_SECRET = "quickstart-development-mcp-proof-secret";
const DEMO_RUN_ID = "quickstart-run";
const LOCAL_DEV_SERVER_ID = "quickstart-dev-server";
const LOCAL_ACTION_TIMEOUT_MS = 30_000;
const TURN_TIMEOUT_MS = 180_000;
const API_TOKEN_HEADER = "x-hcp-quickstart-token";

const staticRoot: string = join(dirname(fileURLToPath(import.meta.url)), "../public");
const repoRoot: string = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

type QuickstartDemoOptions = {
  host?: string;
  port?: number;
  workspaceRoot?: string;
};

export type QuickstartDemoServer = {
  host: string;
  port: number;
  url: string;
  close(): Promise<void>;
};

type UiEventChannel = "browser" | "control-plane" | "runner" | "local-action" | "provider" | "mcp";

type UiEvent = {
  id: string;
  created_at: string;
  channel: UiEventChannel;
  label: string;
  message: string;
  details?: unknown;
};

type RunnerStatus = "starting" | "connected" | "accepted" | "disconnected" | "error";

type SessionSummary = {
  session_id: string;
  provider_instance_id: string;
  driver_kind: string;
  status: "starting" | "active" | "exited";
};

type DemoSnapshot = {
  api_token: string;
  runner_status: RunnerStatus;
  control_plane_url: string;
  workspace_root: string;
  providers: HarnessProviderSnapshot[];
  local_capabilities: HcpHostCapabilitiesUpdatedPayload["local_capabilities"];
  sessions: SessionSummary[];
  dev_server_url?: string;
  event_log: UiEvent[];
  hcp_event_count: number;
  command_nacks: HcpNackPayload[];
};

type StateWaiter = {
  predicate: () => unknown | undefined;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

type CommandResult =
  | {
      type: "ack";
      payload: HcpAckPayload;
    }
  | {
      type: "nack";
      payload: HcpNackPayload;
    };

type LocalActionResult =
  | {
      type: "response";
      payload: LocalActionResponsePayload;
    }
  | {
      type: "error";
      payload: LocalActionErrorPayload;
    };

type LocalActionOrNackResult =
  | LocalActionResult
  | {
      type: "nack";
      payload: HcpNackPayload;
    };

type LocalActionRequestScaffold<TAction extends LocalActionRequestPayload["action"]> = Omit<
  Extract<LocalActionRequestPayload, { action: TAction }>,
  "input" | "output_limits"
>;

type ApiResult = {
  status: "ok";
  message: string;
  data?: unknown;
};

class DemoHttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "DemoHttpError";
  }
}

class QuickstartControlPlane {
  readonly #host: string;
  readonly #apiToken: string;
  #port: number;
  readonly #webSocketServer: WebSocketServer;
  readonly #sseClients = new Set<ServerResponse>();
  readonly #waiters = new Set<StateWaiter>();
  readonly #uiEvents: UiEvent[] = [];
  readonly #hcpEvents: HcpHarnessEventPayload[] = [];
  readonly #commandAcks: HcpAckPayload[] = [];
  readonly #commandNacks: HcpNackPayload[] = [];
  readonly #localActionResponses: LocalActionResponsePayload[] = [];
  readonly #localActionErrors: LocalActionErrorPayload[] = [];
  readonly #sessions = new Map<string, SessionSummary>();
  #runnerStatus: RunnerStatus = "starting";
  #capabilities: HcpHostCapabilitiesUpdatedPayload = {
    providers: [],
    local_capabilities: [],
    workspaces: [],
  };
  #runnerSocket: WebSocket | undefined;
  #devServerUrl: string | undefined;

  constructor(host: string, port: number, apiToken: string) {
    this.#host = host;
    this.#port = port;
    this.#apiToken = apiToken;
    this.#webSocketServer = new WebSocketServer({ noServer: true });
    this.#webSocketServer.on("connection", (socket: WebSocket) => this.#handleRunnerSocket(socket));
  }

  setPort(port: number): void {
    this.#port = port;
  }

  get controlPlaneUrl(): string {
    return `ws://${this.#host}:${this.#port}/hcp`;
  }

  get httpUrl(): string {
    return `http://${this.#host}:${this.#port}`;
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const requestUrl = new URL(request.url ?? "/", this.httpUrl);
    if (requestUrl.pathname !== "/hcp") {
      return false;
    }
    this.#webSocketServer.handleUpgrade(request, socket, head, (webSocket: WebSocket) => {
      this.#webSocketServer.emit("connection", webSocket, request);
    });
    return true;
  }

  addSseClient(response: ServerResponse): void {
    response.writeHead(200, {
      "cache-control": "no-cache",
      connection: "keep-alive",
      "content-type": "text/event-stream",
    });
    response.write(`event: snapshot\ndata: ${JSON.stringify(this.snapshot())}\n\n`);
    this.#sseClients.add(response);
    response.on("close", () => {
      this.#sseClients.delete(response);
    });
  }

  snapshot(): DemoSnapshot {
    return {
      api_token: this.#apiToken,
      runner_status: this.#runnerStatus,
      control_plane_url: this.controlPlaneUrl,
      workspace_root: this.#capabilities.workspaces[0]?.path ?? "",
      providers: this.#capabilities.providers,
      local_capabilities: this.#capabilities.local_capabilities,
      sessions: [...this.#sessions.values()],
      ...(this.#devServerUrl ? { dev_server_url: this.#devServerUrl } : {}),
      event_log: this.#uiEvents.slice(-120),
      hcp_event_count: this.#hcpEvents.length,
      command_nacks: this.#commandNacks.slice(-20),
    };
  }

  appendUiEvent(channel: UiEventChannel, label: string, message: string, details?: unknown): void {
    const event: UiEvent = {
      id: randomUUID(),
      created_at: new Date().toISOString(),
      channel,
      label,
      message,
      ...(details !== undefined ? { details } : {}),
    };
    this.#uiEvents.push(event);
    while (this.#uiEvents.length > 300) {
      this.#uiEvents.shift();
    }
    this.#emitSse("ui-event", event);
    this.#emitSse("snapshot", this.snapshot());
  }

  send<TType extends HcpKnownMessageType, TPayload>(type: TType, payload: TPayload): string {
    const socket: WebSocket = this.#requireRunnerSocket();
    const envelope = createHcpEnvelope(type, payload);
    socket.send(JSON.stringify(envelope));
    this.appendUiEvent("control-plane", type, `sent ${type}`, { id: envelope.id, payload });
    return envelope.id;
  }

  async waitForCapabilities(timeoutMs = 10_000): Promise<HcpHostCapabilitiesUpdatedPayload> {
    return await this.#waitFor(() => (this.#capabilities.providers.length > 0 ? this.#capabilities : undefined), timeoutMs);
  }

  async waitForCommand(commandId: string, timeoutMs = 10_000): Promise<CommandResult> {
    return await this.#waitFor(() => {
      const ack: HcpAckPayload | undefined = this.#commandAcks.find(
        (candidate: HcpAckPayload): boolean => candidate.command_id === commandId,
      );
      if (ack) {
        return { type: "ack" as const, payload: ack };
      }
      const nack: HcpNackPayload | undefined = this.#commandNacks.find(
        (candidate: HcpNackPayload): boolean => candidate.command_id === commandId,
      );
      if (nack) {
        return { type: "nack" as const, payload: nack };
      }
      return undefined;
    }, timeoutMs);
  }

  async waitForLocalAction(requestId: string, timeoutMs = LOCAL_ACTION_TIMEOUT_MS): Promise<LocalActionResult> {
    return await this.#waitFor(() => {
      const response: LocalActionResponsePayload | undefined = this.#localActionResponses.find(
        (candidate: LocalActionResponsePayload): boolean => candidate.request_id === requestId,
      );
      if (response) {
        return { type: "response" as const, payload: response };
      }
      const error: LocalActionErrorPayload | undefined = this.#localActionErrors.find(
        (candidate: LocalActionErrorPayload): boolean => candidate.request_id === requestId,
      );
      if (error) {
        return { type: "error" as const, payload: error };
      }
      return undefined;
    }, timeoutMs);
  }

  async waitForLocalActionOrNack(
    requestId: string,
    envelopeId: string,
    timeoutMs = LOCAL_ACTION_TIMEOUT_MS,
  ): Promise<LocalActionOrNackResult> {
    return await this.#waitFor(() => {
      const response: LocalActionResponsePayload | undefined = this.#localActionResponses.find(
        (candidate: LocalActionResponsePayload): boolean => candidate.request_id === requestId,
      );
      if (response) {
        return { type: "response" as const, payload: response };
      }
      const error: LocalActionErrorPayload | undefined = this.#localActionErrors.find(
        (candidate: LocalActionErrorPayload): boolean => candidate.request_id === requestId,
      );
      if (error) {
        return { type: "error" as const, payload: error };
      }
      const nack: HcpNackPayload | undefined = this.#commandNacks.find(
        (candidate: HcpNackPayload): boolean => candidate.command_id === envelopeId,
      );
      if (nack) {
        return { type: "nack" as const, payload: nack };
      }
      return undefined;
    }, timeoutMs);
  }

  async waitForEvent(
    eventType: HcpHarnessEventPayload["event_type"],
    sessionId: string,
    timeoutMs = 10_000,
  ): Promise<HcpHarnessEventPayload> {
    return await this.#waitFor(
      () =>
        this.#hcpEvents.find(
          (event: HcpHarnessEventPayload): boolean =>
            event.event_type === eventType && event.session_id === sessionId,
        ),
      timeoutMs,
    );
  }

  async waitForTurnTerminalEvent(turnId: string, timeoutMs = TURN_TIMEOUT_MS): Promise<HcpHarnessEventPayload> {
    return await this.#waitFor(
      () =>
        this.#hcpEvents.find(
          (event: HcpHarnessEventPayload): boolean =>
            event.turn_id === turnId &&
            (event.event_type === "turn.completed" ||
              event.event_type === "turn.failed" ||
              event.event_type === "turn.cancelled" ||
              event.event_type === "turn.aborted"),
        ),
      timeoutMs,
    );
  }

  async waitForMcpStatus(
    sessionId: string,
    status: string,
    timeoutMs = 10_000,
  ): Promise<HcpHarnessEventPayload> {
    return await this.#waitFor(
      () =>
        this.#hcpEvents.find(
          (event: HcpHarnessEventPayload): boolean => {
            const data: unknown = event.data;
            return (
              event.session_id === sessionId &&
              event.event_type === "mcp.status.updated" &&
              isRecord(data) &&
              data["status"] === status
            );
          },
        ),
      timeoutMs,
    );
  }

  setDevServerUrl(url: string | undefined): void {
    this.#devServerUrl = url;
    this.#emitSse("snapshot", this.snapshot());
  }

  async close(): Promise<void> {
    for (const client of this.#sseClients) {
      client.end();
    }
    this.#sseClients.clear();
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error("Quickstart control plane is closing."));
    }
    this.#waiters.clear();
    await new Promise<void>((resolve, reject) => {
      this.#webSocketServer.close((error?: Error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  #handleRunnerSocket(socket: WebSocket): void {
    if (this.#runnerSocket && this.#runnerSocket.readyState === WebSocket.OPEN) {
      socket.close(1008, "duplicate runner connection");
      return;
    }
    this.#runnerSocket = socket;
    this.#runnerStatus = "connected";
    this.appendUiEvent("runner", "connected", "runner WebSocket connected");
    this.#notifyStateChanged();

    socket.on("message", (data: WebSocket.RawData) => {
      this.#handleRunnerMessage(data).catch((error: unknown) => {
        this.#runnerStatus = "error";
        this.appendUiEvent(
          "runner",
          "message failed",
          error instanceof Error ? error.message : "runner message failed",
        );
        this.#notifyStateChanged();
      });
    });
    socket.on("close", () => {
      if (this.#runnerSocket === socket) {
        this.#runnerSocket = undefined;
      }
      this.#runnerStatus = "disconnected";
      this.appendUiEvent("runner", "disconnected", "runner WebSocket disconnected");
      this.#notifyStateChanged();
    });
  }

  async #handleRunnerMessage(data: WebSocket.RawData): Promise<void> {
    const parsed: unknown = JSON.parse(data.toString("utf8"));
    const message: HcpMessage = parseHcpMessage(parsed);
    switch (message.type) {
      case "host.hello":
        this.#runnerStatus = "connected";
        this.appendUiEvent("runner", "host.hello", "runner sent host.hello", message.payload);
        this.#sendAccepted();
        return;
      case "host.heartbeat":
        this.appendUiEvent("runner", "heartbeat", "runner heartbeat", message.payload);
        return;
      case "host.capabilities.updated":
        this.#runnerStatus = "accepted";
        this.#capabilities = message.payload;
        this.appendUiEvent("runner", "capabilities", "runner capabilities updated", message.payload);
        this.#notifyStateChanged();
        return;
      case "hcp.command.ack":
        this.#commandAcks.push(message.payload);
        this.appendUiEvent("runner", "ack", `command accepted: ${message.payload.command_id}`, message.payload);
        this.#notifyStateChanged();
        return;
      case "hcp.command.nack":
        this.#commandNacks.push(message.payload);
        this.appendUiEvent("runner", "nack", `command rejected: ${message.payload.error.message}`, message.payload);
        this.#notifyStateChanged();
        return;
      case "harness.event":
        this.#recordHarnessEvent(message.payload);
        return;
      case "local.action.response":
        this.#localActionResponses.push(message.payload);
        this.appendUiEvent(
          "local-action",
          message.payload.action,
          `local action completed: ${message.payload.request_id}`,
          message.payload.output,
        );
        this.#notifyStateChanged();
        return;
      case "local.action.error":
        this.#localActionErrors.push(message.payload);
        this.appendUiEvent(
          "local-action",
          message.payload.action,
          `local action failed: ${message.payload.error.message}`,
          message.payload,
        );
        this.#notifyStateChanged();
        return;
      default:
        this.appendUiEvent("runner", message.type, `runner sent ${message.type}`, message.payload);
    }
  }

  #sendAccepted(): void {
    const socket: WebSocket = this.#requireRunnerSocket();
    const payload: HcpHostAcceptedPayload = {
      protocol_version: HCP_VERSION,
      heartbeat_interval_seconds: HEARTBEAT_INTERVAL_SECONDS,
    };
    socket.send(JSON.stringify(createHcpEnvelope("host.accepted", payload)));
    this.appendUiEvent("control-plane", "host.accepted", "accepted runner connection", payload);
  }

  #recordHarnessEvent(event: HcpHarnessEventPayload): void {
    this.#hcpEvents.push(event);
    if (event.event_type === "session.started") {
      const data: Record<string, unknown> = isRecord(event.data) ? event.data : {};
      const driverKind: string = typeof data["driver_kind"] === "string" ? data["driver_kind"] : "unknown";
      const providerInstanceId: string =
        typeof data["provider_instance_id"] === "string" ? data["provider_instance_id"] : "unknown";
      this.#sessions.set(event.session_id, {
        session_id: event.session_id,
        provider_instance_id: providerInstanceId,
        driver_kind: driverKind,
        status: "active",
      });
    }
    if (event.event_type === "session.exited") {
      const existing: SessionSummary | undefined = this.#sessions.get(event.session_id);
      if (existing) {
        this.#sessions.set(event.session_id, { ...existing, status: "exited" });
      }
    }
    this.appendUiEvent("runner", event.event_type, `event ${event.event_type}`, event);
    this.#notifyStateChanged();
  }

  #requireRunnerSocket(): WebSocket {
    if (!this.#runnerSocket || this.#runnerSocket.readyState !== WebSocket.OPEN) {
      throw new DemoHttpError(409, "The HCP runner is not connected yet.");
    }
    return this.#runnerSocket;
  }

  async #waitFor<T>(predicate: () => T | undefined, timeoutMs: number): Promise<T> {
    const existing: T | undefined = predicate();
    if (existing !== undefined) {
      return existing;
    }

    return await new Promise<T>((resolve, reject) => {
      const waiter: StateWaiter = {
        predicate: () => predicate(),
        resolve: (value: unknown): void => resolve(value as T),
        reject,
        timeout: setTimeout(() => {
          this.#waiters.delete(waiter);
          reject(new Error("Timed out waiting for HCP state."));
        }, timeoutMs),
      };
      this.#waiters.add(waiter);
    });
  }

  #notifyStateChanged(): void {
    for (const waiter of [...this.#waiters]) {
      const value: unknown | undefined = waiter.predicate();
      if (value !== undefined) {
        clearTimeout(waiter.timeout);
        this.#waiters.delete(waiter);
        waiter.resolve(value);
      }
    }
    this.#emitSse("snapshot", this.snapshot());
  }

  #emitSse(eventName: string, payload: unknown): void {
    const serialized: string = JSON.stringify(payload);
    for (const client of this.#sseClients) {
      client.write(`event: ${eventName}\ndata: ${serialized}\n\n`);
    }
  }
}

class QuickstartDemoApp {
  readonly #host: string;
  readonly #requestedPort: number;
  readonly #workspaceRoot: string;
  readonly #apiToken = randomUUID();
  readonly #httpServer: HttpServer;
  readonly #controlPlane: QuickstartControlPlane;
  #runnerConnection: RunnerConnection | undefined;
  #localSessionStarted = false;

  constructor(options: Required<QuickstartDemoOptions>) {
    this.#host = options.host;
    this.#requestedPort = options.port;
    this.#workspaceRoot = options.workspaceRoot;
    this.#controlPlane = new QuickstartControlPlane(this.#host, this.#requestedPort, this.#apiToken);
    this.#httpServer = createServer((request: IncomingMessage, response: ServerResponse) => {
      this.#handleHttp(request, response).catch((error: unknown) => {
        writeErrorResponse(response, error);
      });
    });
    this.#httpServer.on("upgrade", (request, socket, head) => {
      if (!this.#controlPlane.handleUpgrade(request, socket, head)) {
        socket.destroy();
      }
    });
  }

  async start(): Promise<QuickstartDemoServer> {
    const boundPort: number = await listenWithFallback(this.#httpServer, this.#host, this.#requestedPort);
    this.#controlPlane.setPort(boundPort);
    const config: RunnerConfig = createRunnerConfig(this.#workspaceRoot, this.#controlPlane.controlPlaneUrl);
    const harnessSessions = new HarnessSessionManager(config, {
      mcpProofSigner: createDevelopmentHmacProofSigner(MCP_PROOF_SECRET),
    });
    const connection = new RunnerConnection({
      config,
      runnerVersion: "0.0.0-quickstart",
      harnessSessions,
      onLog: (message: string) => this.#controlPlane.appendUiEvent("runner", "log", message),
      reconnect: { initialDelayMs: 250, maxDelayMs: 1_000 },
    });
    this.#runnerConnection = connection;
    await connection.connect();
    await this.#controlPlane.waitForCapabilities();
    this.#controlPlane.appendUiEvent("browser", "ready", `quickstart demo listening at ${this.#controlPlane.httpUrl}`);
    return {
      host: this.#host,
      port: boundPort,
      url: this.#controlPlane.httpUrl,
      close: async (): Promise<void> => {
        await this.close();
      },
    };
  }

  async close(): Promise<void> {
    const errors: string[] = [];
    if (this.#localSessionStarted) {
      try {
        await this.#stopSession(LOCAL_SESSION_ID, "quickstart-shutdown");
      } catch (error: unknown) {
        errors.push(error instanceof Error ? error.message : "Failed to stop local quickstart session.");
      }
    }
    try {
      await this.#runnerConnection?.close();
    } catch (error: unknown) {
      errors.push(error instanceof Error ? error.message : "Failed to close runner connection.");
    }
    try {
      await this.#controlPlane.close();
    } catch (error: unknown) {
      errors.push(error instanceof Error ? error.message : "Failed to close control plane.");
    }
    try {
      await closeHttpServer(this.#httpServer);
    } catch (error: unknown) {
      errors.push(error instanceof Error ? error.message : "Failed to close quickstart HTTP server.");
    }
    if (errors.length > 0) {
      throw new Error(errors.join("; "));
    }
  }

  async #handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestUrl = new URL(request.url ?? "/", this.#controlPlane.httpUrl);
    if (request.method === "GET" && requestUrl.pathname === "/api/events") {
      this.#controlPlane.addSseClient(response);
      return;
    }
    if (requestUrl.pathname.startsWith("/api/")) {
      await this.#handleApi(request, response, requestUrl);
      return;
    }
    await serveStatic(requestUrl.pathname, response);
  }

  async #handleApi(request: IncomingMessage, response: ServerResponse, requestUrl: URL): Promise<void> {
    if (request.method === "GET" && requestUrl.pathname === "/api/snapshot") {
      writeJson(response, 200, this.#controlPlane.snapshot());
      return;
    }
    if (request.method !== "POST") {
      throw new DemoHttpError(405, "API route requires POST.");
    }
    this.#assertMutatingRequestAllowed(request);

    const body: Record<string, unknown> = await readJsonBody(request);
    let result: ApiResult;
    switch (requestUrl.pathname) {
      case "/api/session/start-local":
        result = await this.#startLocalSession();
        break;
      case "/api/local/read-file":
        result = await this.#readFileAction();
        break;
      case "/api/local/git-status":
        result = await this.#gitStatusAction();
        break;
      case "/api/local/safe-shell":
        result = await this.#safeShellAction();
        break;
      case "/api/local/dev-server/start":
        result = await this.#startDevServerAction();
        break;
      case "/api/local/dev-server/stop":
        result = await this.#stopDevServerAction();
        break;
      case "/api/prompt/send":
        result = await this.#sendProviderPrompt(body);
        break;
      case "/api/mcp/start":
        result = await this.#runMcpAttachment(body);
        break;
      default:
        throw new DemoHttpError(404, "API route was not found.");
    }
    writeJson(response, 200, result);
  }

  #assertMutatingRequestAllowed(request: IncomingMessage): void {
    const contentType: string | undefined = singleHeader(request.headers["content-type"]);
    if (contentType?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      throw new DemoHttpError(415, "Mutating quickstart API requests require Content-Type: application/json.");
    }

    const origin: string | undefined = singleHeader(request.headers.origin);
    if (origin !== undefined && origin !== this.#controlPlane.httpUrl) {
      throw new DemoHttpError(403, "Mutating quickstart API requests must come from the demo origin.");
    }

    const token: string | undefined = singleHeader(request.headers[API_TOKEN_HEADER]);
    if (token !== this.#apiToken) {
      throw new DemoHttpError(403, "Mutating quickstart API requests require the quickstart API token.");
    }
  }

  async #startLocalSession(): Promise<ApiResult> {
    await this.#ensureLocalSession();
    return {
      status: "ok",
      message: "Local action session is active.",
      data: { session_id: LOCAL_SESSION_ID },
    };
  }

  async #ensureLocalSession(): Promise<void> {
    if (this.#localSessionStarted) {
      return;
    }
    const payload: HcpSessionStartPayload = {
      session_id: LOCAL_SESSION_ID,
      workspace_id: WORKSPACE_ID,
      provider_instance_id: LOCAL_PROVIDER_ID,
      driver_kind: "mock",
      cwd: this.#workspaceRoot,
      sandbox_mode: "workspace_write",
      approval_policy: "ask",
      continue_session: false,
      model_selection: { model: "mock-model" },
      local_capability_lease: createLocalCapabilityLease({
        sessionId: LOCAL_SESSION_ID,
        providerInstanceId: LOCAL_PROVIDER_ID,
      }),
      mcp_servers: [],
    };
    const commandId: string = this.#controlPlane.send("harness.session.start", payload);
    await assertCommandAccepted(await this.#controlPlane.waitForCommand(commandId));
    this.#localSessionStarted = true;
    await this.#controlPlane.waitForEvent("session.configured", LOCAL_SESSION_ID);
  }

  async #readFileAction(): Promise<ApiResult> {
    await this.#ensureLocalSession();
    const payload: LocalActionRequestPayload = {
      ...this.#localActionBase("local.filesystem.read", "filesystem", "workspace_read"),
      output_limits: { content_bytes: 8_192 },
      input: { path: "README.md", encoding: "utf8" },
    };
    const response: Extract<LocalActionResponsePayload, { action: "local.filesystem.read" }> =
      await this.#runLocalAction(payload, "local.filesystem.read");
    return {
      status: "ok",
      message: "README.md read through HCP local.action.request.",
      data: response.output,
    };
  }

  async #gitStatusAction(): Promise<ApiResult> {
    await this.#ensureLocalSession();
    const payload: LocalActionRequestPayload = {
      ...this.#localActionBase("local.git.status", "git", "workspace_read"),
      output_limits: { status_bytes: 16_384 },
      input: { porcelain_version: "v1", include_branch: true },
    };
    const response: Extract<LocalActionResponsePayload, { action: "local.git.status" }> =
      await this.#runLocalAction(payload, "local.git.status");
    return {
      status: "ok",
      message: "Git status returned through HCP local.action.response.",
      data: response.output,
    };
  }

  async #safeShellAction(): Promise<ApiResult> {
    await this.#ensureLocalSession();
    const input: LocalShellExecInput = {
      executable: "node",
      argv: ["-e", "console.log('HCP safe shell OK')"],
      cwd: this.#workspaceRoot,
      use_shell: false,
    };
    const payload: LocalActionRequestPayload = {
      ...this.#localActionBase("local.shell.exec", "shell", "workspace"),
      approval: approvedLocalActionBinding("local.shell.exec", input),
      output_limits: { stdout_bytes: 4_096, stderr_bytes: 4_096 },
      cancellation: { cancellable: true, timeout_ms: 5_000 },
      input,
    };
    const response: Extract<LocalActionResponsePayload, { action: "local.shell.exec" }> =
      await this.#runLocalAction(payload, "local.shell.exec");
    return {
      status: "ok",
      message: "Safe Node shell command completed through HCP.",
      data: response.output,
    };
  }

  async #startDevServerAction(): Promise<ApiResult> {
    await this.#ensureLocalSession();
    const port: number = await reservePort(this.#host);
    const input: LocalDevServerStartInput = {
      server_id: LOCAL_DEV_SERVER_ID,
      executable: "node",
      argv: ["-e", demoDevServerSource(), this.#host, String(port)],
      cwd: this.#workspaceRoot,
      host: "127.0.0.1",
      port,
      use_shell: false,
      readiness: {
        url: `http://${this.#host}:${port}`,
        timeout_ms: 5_000,
      },
    };
    const payload: LocalActionRequestPayload = {
      ...this.#localActionBase("local.dev_server.start", "dev_server", "workspace"),
      approval: approvedLocalActionBinding("local.dev_server.start", input),
      output_limits: { stdout_bytes: 4_096, stderr_bytes: 4_096 },
      cancellation: { cancellable: true, timeout_ms: 10_000 },
      input,
    };
    const response: Extract<LocalActionResponsePayload, { action: "local.dev_server.start" }> =
      await this.#runLocalAction(payload, "local.dev_server.start");
    this.#controlPlane.setDevServerUrl(response.output.url);
    return {
      status: "ok",
      message: "Dev server started through HCP.",
      data: response.output,
    };
  }

  async #stopDevServerAction(): Promise<ApiResult> {
    await this.#ensureLocalSession();
    const payload: LocalActionRequestPayload = {
      ...this.#localActionBase("local.dev_server.stop", "dev_server", "workspace"),
      output_limits: {},
      cancellation: { cancellable: true, timeout_ms: 5_000 },
      input: {
        server_id: LOCAL_DEV_SERVER_ID,
        signal: "SIGTERM",
        timeout_ms: 5_000,
      },
    };
    const response: Extract<LocalActionResponsePayload, { action: "local.dev_server.stop" }> =
      await this.#runLocalAction(payload, "local.dev_server.stop");
    this.#controlPlane.setDevServerUrl(undefined);
    return {
      status: "ok",
      message: "Dev server stopped through HCP.",
      data: response.output,
    };
  }

  async #sendProviderPrompt(body: Record<string, unknown>): Promise<ApiResult> {
    const providerId: string = optionalString(body["provider_instance_id"]) ?? "codex-local";
    const prompt: string = requiredString(body["input"], "input");
    const provider: HarnessProviderSnapshot = this.#requireProvider(providerId);
    if (provider.driver_kind !== "codex" && provider.driver_kind !== "claude") {
      throw new DemoHttpError(400, "Prompt turns are only enabled for Codex or Claude Code providers.");
    }
    if (provider.availability !== "available") {
      throw new DemoHttpError(
        409,
        provider.message ?? `${provider.display_name ?? provider.provider_instance_id} is not available.`,
        provider,
      );
    }

    const sessionId = `quickstart-${provider.driver_kind}-${shortId()}`;
    const turnId = `turn-${shortId()}`;
    let started = false;
    try {
      const sessionStart: HcpSessionStartPayload = createProviderSessionStart({
        sessionId,
        provider,
        workspaceRoot: this.#workspaceRoot,
        mcpServers: [],
      });
      const commandId: string = this.#controlPlane.send("harness.session.start", sessionStart);
      await assertCommandAccepted(await this.#controlPlane.waitForCommand(commandId));
      started = true;
      await this.#controlPlane.waitForEvent("session.configured", sessionId);

      const turnPayload: HcpTurnSendPayload = {
        session_id: sessionId,
        turn_id: turnId,
        input: prompt,
        model_selection: { model: defaultModelFor(provider) },
      };
      const turnCommandId: string = this.#controlPlane.send("harness.turn.send", turnPayload);
      await assertCommandAccepted(await this.#controlPlane.waitForCommand(turnCommandId));
      const terminalEvent: HcpHarnessEventPayload = await this.#controlPlane.waitForTurnTerminalEvent(turnId);
      return {
        status: "ok",
        message: `Provider turn ended with ${terminalEvent.event_type}.`,
        data: terminalEvent,
      };
    } finally {
      if (started) {
        await this.#stopSession(sessionId, "quickstart-prompt-complete");
      }
    }
  }

  async #runMcpAttachment(body: Record<string, unknown>): Promise<ApiResult> {
    const requestedProviderId: string | undefined = optionalString(body["provider_instance_id"]);
    const sendTurn: boolean = body["send_turn"] === true;
    const provider: HarnessProviderSnapshot = this.#selectMcpProvider(requestedProviderId, sendTurn);
    const sessionId = `quickstart-mcp-${provider.driver_kind}-${shortId()}`;
    const sampleMcp: SampleMcpServer = await startSampleMcpServer({
      port: 0,
      lease: {
        lease_id: "mcp_lease_quickstart",
        key_id: "proof_key_quickstart",
        secret: MCP_PROOF_SECRET,
        session_id: sessionId,
        host_id: HOST_ID,
        provider_instance_id: provider.provider_instance_id,
        workspace_id: WORKSPACE_ID,
        server_id: "sample",
        expires_at: futureTimestamp(20 * 60 * 1000),
        allowed_tools: ["echo", "server_status"],
      },
    });
    let started = false;
    try {
      const attachment: McpServerAttachment = {
        name: "sample",
        transport: "streamable_http",
        url: sampleMcp.url,
        headers: { Authorization: "Bearer quickstart-sample-token" },
        lease_id: "mcp_lease_quickstart",
        proof_of_possession: {
          scheme: "runner_signed_request",
          key_id: "proof_key_quickstart",
          required_headers: ["x-hcp-proof-signature", "x-hcp-proof-nonce"],
        },
        allowed_tools: ["echo", "server_status"],
      };
      const sessionStart: HcpSessionStartPayload = createProviderSessionStart({
        sessionId,
        provider,
        workspaceRoot: this.#workspaceRoot,
        mcpServers: [attachment],
      });
      const commandId: string = this.#controlPlane.send("harness.session.start", sessionStart);
      await assertCommandAccepted(await this.#controlPlane.waitForCommand(commandId));
      started = true;
      await this.#controlPlane.waitForMcpStatus(sessionId, "connected");
      await this.#controlPlane.waitForMcpStatus(sessionId, "tools_discovered");

      let terminalEvent: HcpHarnessEventPayload | undefined;
      if (sendTurn) {
        if (provider.availability !== "available") {
          throw new DemoHttpError(409, "Provider must be available before sending an MCP-backed prompt.", provider);
        }
        const turnId = `turn-${shortId()}`;
        const turnPayload: HcpTurnSendPayload = {
          session_id: sessionId,
          turn_id: turnId,
          input: "Use the attached sample MCP server if available and reply with the server_status result.",
          model_selection: { model: defaultModelFor(provider) },
        };
        const turnCommandId: string = this.#controlPlane.send("harness.turn.send", turnPayload);
        await assertCommandAccepted(await this.#controlPlane.waitForCommand(turnCommandId));
        terminalEvent = await this.#controlPlane.waitForTurnTerminalEvent(turnId);
      }

      return {
        status: "ok",
        message:
          provider.driver_kind === "codex" || provider.driver_kind === "claude"
            ? "Streamable HTTP MCP attachment connected through the runner-owned loopback proxy."
            : "Streamable HTTP MCP attachment connected through the proof-bound runner client.",
        data: {
          provider: provider.provider_instance_id,
          driver_kind: provider.driver_kind,
          sample_mcp_url: sampleMcp.url,
          ...(terminalEvent ? { terminal_event: terminalEvent } : {}),
        },
      };
    } finally {
      try {
        if (started) {
          await this.#stopSession(sessionId, "quickstart-mcp-complete");
        }
      } finally {
        await sampleMcp.close();
      }
    }
  }

  #selectMcpProvider(requestedProviderId: string | undefined, sendTurn: boolean): HarnessProviderSnapshot {
    if (requestedProviderId) {
      const provider: HarnessProviderSnapshot = this.#requireProvider(requestedProviderId);
      if ((sendTurn || provider.driver_kind === "codex" || provider.driver_kind === "claude") && provider.availability !== "available") {
        throw new DemoHttpError(
          409,
          provider.message ?? `${provider.display_name ?? provider.provider_instance_id} is not available.`,
          provider,
        );
      }
      return provider;
    }
    const providers: HarnessProviderSnapshot[] = this.#controlPlane.snapshot().providers;
    const readyCliProvider: HarnessProviderSnapshot | undefined = providers.find(
      (provider: HarnessProviderSnapshot): boolean =>
        (provider.driver_kind === "codex" || provider.driver_kind === "claude") && provider.availability === "available",
    );
    if (readyCliProvider) {
      return readyCliProvider;
    }
    const mockProvider: HarnessProviderSnapshot | undefined = providers.find(
      (provider: HarnessProviderSnapshot): boolean => provider.provider_instance_id === LOCAL_PROVIDER_ID,
    );
    if (!mockProvider) {
      throw new DemoHttpError(409, "Mock provider was not advertised by the runner.");
    }
    return mockProvider;
  }

  #requireProvider(providerId: string): HarnessProviderSnapshot {
    const provider: HarnessProviderSnapshot | undefined = this.#controlPlane
      .snapshot()
      .providers.find((candidate: HarnessProviderSnapshot): boolean => candidate.provider_instance_id === providerId);
    if (!provider) {
      throw new DemoHttpError(404, `Provider '${providerId}' is not advertised by the runner.`);
    }
    return provider;
  }

  async #runLocalAction<TAction extends LocalActionResponsePayload["action"]>(
    payload: LocalActionRequestPayload,
    expectedAction: TAction,
  ): Promise<Extract<LocalActionResponsePayload, { action: TAction }>> {
    const envelopeId: string = this.#controlPlane.send("local.action.request", payload);
    const result: LocalActionOrNackResult = await this.#controlPlane.waitForLocalActionOrNack(
      payload.request_id,
      envelopeId,
    );
    if (result.type === "nack") {
      throw new DemoHttpError(409, result.payload.error.message, result.payload);
    }
    if (result.type === "error") {
      throw new DemoHttpError(409, result.payload.error.message, result.payload);
    }
    if (result.payload.action !== expectedAction) {
      throw new DemoHttpError(500, `Unexpected local action response '${result.payload.action}'.`, result.payload);
    }
    return result.payload as Extract<LocalActionResponsePayload, { action: TAction }>;
  }

  #localActionBase<TAction extends LocalActionRequestPayload["action"]>(
    action: TAction,
    capabilityId: LocalActionRequestPayload["lease"]["capability_id"],
    scope: string,
  ): LocalActionRequestScaffold<TAction> {
    const requestId = `${action.replaceAll(".", "-")}-${shortId()}`;
    const scaffold = {
      request_id: requestId,
      action,
      issued_at: new Date().toISOString(),
      attribution: {
        session_id: LOCAL_SESSION_ID,
        turn_id: LOCAL_TURN_ID,
        workspace_id: WORKSPACE_ID,
        provider_instance_id: LOCAL_PROVIDER_ID,
        run_id: DEMO_RUN_ID,
      },
      lease: {
        lease_id: "local_lease_quickstart",
        capability_id: capabilityId,
        scope,
        run_id: DEMO_RUN_ID,
        hcp_session_id: LOCAL_SESSION_ID,
        execution_host_id: HOST_ID,
        provider_instance_id: LOCAL_PROVIDER_ID,
        workspace_id: WORKSPACE_ID,
        expires_at: futureTimestamp(60 * 60 * 1000),
      },
      sandbox: {
        mode: "workspace_write",
        workspace_root: this.#workspaceRoot,
        cwd: this.#workspaceRoot,
        requires_workspace_containment: true,
      },
      approval: { status: "not_required" },
      cancellation: { cancellable: false },
      audit: {
        started_event_type: "local_capability.action.started",
        completed_event_type: "local_capability.action.completed",
        failed_event_type: "local_capability.action.failed",
      },
    } as LocalActionRequestScaffold<TAction>;
    return scaffold;
  }

  async #stopSession(sessionId: string, reason: string): Promise<void> {
    const commandId: string = this.#controlPlane.send("harness.session.stop", { session_id: sessionId, reason });
    await assertCommandAccepted(await this.#controlPlane.waitForCommand(commandId));
    await this.#controlPlane.waitForEvent("session.exited", sessionId);
  }
}

export async function startQuickstartDemo(options: QuickstartDemoOptions = {}): Promise<QuickstartDemoServer> {
  const workspaceRoot: string = await realpath(options.workspaceRoot ?? process.env.HCP_QUICKSTART_WORKSPACE ?? repoRoot);
  const app = new QuickstartDemoApp({
    host: options.host ?? process.env.HCP_QUICKSTART_HOST ?? DEFAULT_HOST,
    port: options.port ?? parsePort(process.env.HCP_QUICKSTART_PORT) ?? DEFAULT_PORT,
    workspaceRoot,
  });
  return await app.start();
}

function createRunnerConfig(workspaceRoot: string, controlPlaneUrl: string): RunnerConfig {
  return {
    runner_id: RUNNER_ID,
    host_id: HOST_ID,
    control_plane_url: controlPlaneUrl,
    workspaces: [{ id: WORKSPACE_ID, path: workspaceRoot }],
    local_capabilities: [
      { id: "filesystem", status: "available", scopes: ["workspace_read", "workspace_write"], approval_required: false },
      { id: "git", status: "available", scopes: ["workspace_read"], approval_required: false },
      { id: "shell", status: "available", scopes: ["workspace"], approval_required: true },
      { id: "dev_server", status: "available", scopes: ["workspace"], approval_required: true },
    ],
    provider_instances: [
      providerConfig({
        id: LOCAL_PROVIDER_ID,
        driverKind: "mock",
        displayName: "Mock Harness",
        modelId: "mock-model",
        modelLabel: "Mock Model",
      }),
      providerConfig({
        id: "codex-local",
        driverKind: "codex",
        displayName: "Codex Local",
        modelId: "gpt-5.5",
        modelLabel: "GPT-5.5",
        launchArgs: ["-c", "service_tier=fast"],
      }),
      providerConfig({
        id: "claude-local",
        driverKind: "claude",
        displayName: "Claude Code Local",
        modelId: "sonnet",
        modelLabel: "Claude Sonnet",
      }),
    ],
  };
}

function providerConfig(input: {
  id: string;
  driverKind: string;
  displayName: string;
  modelId: string;
  modelLabel: string;
  launchArgs?: string[];
}): ProviderInstanceConfig {
  return {
    id: input.id,
    driver_kind: input.driverKind,
    display_name: input.displayName,
    enabled: true,
    launch_args: input.launchArgs ?? [],
    env: {},
    models: [
      {
        id: input.modelId,
        label: input.modelLabel,
        is_default: true,
        capabilities: { option_descriptors: [] },
      },
    ],
    hidden_models: [],
    model_order: [],
    favorite_models: [],
    local_capabilities: ["filesystem", "git", "shell", "dev_server"],
  };
}

function createLocalCapabilityLease(input: {
  sessionId: string;
  providerInstanceId: string;
}): LocalCapabilityLease {
  const executablePolicy: CommandPolicy = {
    allowed_executables: ["node"],
    denied_executables: ["rm"],
    cwd_policy: "selected_workspace_only",
    env_policy: "minimal",
    allow_shell: false,
    timeout_seconds: 30,
    network_policy: "inherit",
  };
  return {
    lease_id: "local_lease_quickstart",
    org_id: "quickstart-org",
    actor_id: "quickstart-user",
    workflow_id: "quickstart-workflow",
    run_id: DEMO_RUN_ID,
    node_id: "quickstart-node",
    hcp_session_id: input.sessionId,
    execution_host_id: HOST_ID,
    provider_instance_id: input.providerInstanceId,
    workspace_id: WORKSPACE_ID,
    issued_at: new Date().toISOString(),
    expires_at: futureTimestamp(60 * 60 * 1000),
    policy_version: "quickstart-2026-06-29",
    capabilities: [
      { id: "filesystem", scopes: ["workspace_read", "workspace_write"] },
      { id: "git", scopes: ["workspace_read"] },
      {
        id: "shell",
        scopes: ["workspace"],
        approval_policy: "full_access",
        command_policy: executablePolicy,
      },
      {
        id: "dev_server",
        scopes: ["workspace"],
        approval_policy: "full_access",
        command_policy: executablePolicy,
      },
    ],
  };
}

function createProviderSessionStart(input: {
  sessionId: string;
  provider: HarnessProviderSnapshot;
  workspaceRoot: string;
  mcpServers: McpServerAttachment[];
}): HcpSessionStartPayload {
  return {
    session_id: input.sessionId,
    workspace_id: WORKSPACE_ID,
    provider_instance_id: input.provider.provider_instance_id,
    driver_kind: input.provider.driver_kind,
    cwd: input.workspaceRoot,
    sandbox_mode: "workspace_write",
    approval_policy: "full_access",
    continue_session: false,
    model_selection: { model: defaultModelFor(input.provider) },
    mcp_servers: input.mcpServers,
  };
}

function approvedLocalActionBinding(
  action: "local.shell.exec" | "local.dev_server.start",
  input: unknown,
): LocalActionApprovalBinding {
  return {
    status: "approved",
    request_id: `approval-${shortId()}`,
    action_hash: `sha256:${createHash("sha256").update(stableStringify({ action, input })).digest("hex")}`,
    decision: "accept_for_session",
    actor_id: "quickstart-user",
    approved_at: new Date().toISOString(),
  };
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

function defaultModelFor(provider: HarnessProviderSnapshot): string {
  return provider.models.find((model) => model.is_default)?.id ?? provider.models[0]?.id ?? "default";
}

function assertCommandAccepted(result: CommandResult): void {
  if (result.type === "nack") {
    throw new DemoHttpError(409, result.payload.error.message, result.payload);
  }
}

async function serveStatic(pathname: string, response: ServerResponse): Promise<void> {
  const normalizedPath = pathname === "/" ? "/index.html" : pathname;
  const filePath: string = resolve(staticRoot, `.${normalizedPath}`);
  if (!filePath.startsWith(staticRoot)) {
    throw new DemoHttpError(403, "Static path is outside the quickstart public directory.");
  }
  try {
    const content: Buffer = await readFile(filePath);
    response.writeHead(200, { "content-type": contentTypeFor(filePath) });
    response.end(content);
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      throw new DemoHttpError(404, "Static file was not found.");
    }
    throw error;
  }
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!isRecord(parsed)) {
    throw new DemoHttpError(400, "JSON request body must be an object.");
  }
  return parsed;
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(payload, null, 2));
}

function writeErrorResponse(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  if (error instanceof DemoHttpError) {
    writeJson(response, error.statusCode, {
      status: "error",
      error: {
        message: error.message,
        ...(error.details !== undefined ? { details: error.details } : {}),
      },
    });
    return;
  }
  if (error instanceof Error) {
    writeJson(response, 500, { status: "error", error: { message: error.message } });
    return;
  }
  writeJson(response, 500, { status: "error", error: { message: "Unexpected quickstart demo failure." } });
}

function contentTypeFor(filePath: string): string {
  switch (extname(filePath)) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    default:
      return "text/html; charset=utf-8";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return isRecord(error) && error["code"] === code;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DemoHttpError(400, `Missing required field '${field}'.`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function shortId(): string {
  return randomUUID().slice(0, 8);
}

function futureTimestamp(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined || value.length === 0) {
    return undefined;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

async function reservePort(host: string): Promise<number> {
  const server: HttpServer = createServer();
  const port: number = await listen(server, host, 0);
  await closeHttpServer(server);
  return port;
}

function listen(server: HttpServer, host: string, port: number): Promise<number> {
  return new Promise<number>((resolveListen, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      const address = server.address();
      if (typeof address === "object" && address !== null) {
        resolveListen(address.port);
        return;
      }
      reject(new Error("Server did not expose a TCP port."));
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

async function listenWithFallback(server: HttpServer, host: string, port: number): Promise<number> {
  for (let attempt = 0; attempt < PORT_SEARCH_LIMIT; attempt += 1) {
    const candidatePort: number = port === 0 ? 0 : port + attempt;
    try {
      return await listen(server, host, candidatePort);
    } catch (error: unknown) {
      if (!isNodeError(error, "EADDRINUSE") || attempt === PORT_SEARCH_LIMIT - 1 || port === 0) {
        throw error;
      }
    }
  }
  throw new Error(`No available quickstart port found starting at ${port}.`);
}

async function closeHttpServer(server: HttpServer): Promise<void> {
  await new Promise<void>((resolveClose, reject) => {
    if (!server.listening) {
      resolveClose();
      return;
    }
    server.close((error?: Error) => {
      if (error) {
        reject(error);
        return;
      }
      resolveClose();
    });
  });
}

function demoDevServerSource(): string {
  return [
    "const http = require('node:http');",
    "const host = process.argv[1];",
    "const port = Number(process.argv[2]);",
    "const server = http.createServer((request, response) => {",
    "response.writeHead(200, { 'content-type': 'text/plain' });",
    "response.end('HCP quickstart dev server OK\\n');",
    "});",
    "server.listen(port, host);",
    "process.on('SIGTERM', () => server.close(() => process.exit(0)));",
    "process.on('SIGINT', () => server.close(() => process.exit(0)));",
  ].join("");
}

async function main(): Promise<void> {
  const server: QuickstartDemoServer = await startQuickstartDemo();
  console.log(`HCP quickstart demo listening at ${server.url}`);
  const close = async (): Promise<void> => {
    await server.close();
  };
  process.once("SIGINT", () => {
    close().then(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    close().then(() => process.exit(0));
  });
}

const isDirectExecution = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isDirectExecution) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Failed to start HCP quickstart demo.");
    process.exitCode = 1;
  });
}
