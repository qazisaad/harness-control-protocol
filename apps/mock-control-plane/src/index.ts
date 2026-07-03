import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import {
  HCP_VERSION,
  parseHcpMessage,
  type HcpAckPayload,
  type HcpEnvelope,
  type HcpError,
  type HcpHostAcceptedPayload,
  type HcpHostCapabilitiesUpdatedPayload,
  type HcpHostHelloPayload,
  type HcpHarnessEventPayload,
  type HcpMessage,
  type HcpNackPayload,
  type HcpSessionStartPayload,
  type HcpSessionStopPayload,
  type HcpTurnCancelPayload,
  type HcpTurnSendPayload,
} from "@harness-control/protocol";

const DEFAULT_PORT = 8787;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 30;
const DEFAULT_PORT_SEARCH_LIMIT = 12;
const DEFAULT_PAIRING_CODE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_CONNECTION_TOKEN_TTL_MS = 60 * 1000;

type KnownIncomingType =
  | "host.hello"
  | "host.heartbeat"
  | "host.capabilities.updated"
  | "hcp.command.ack"
  | "hcp.command.nack"
  | "harness.event";
type MockControlPlaneCommandType =
  | "harness.session.start"
  | "harness.turn.send"
  | "harness.turn.cancel"
  | "harness.session.stop";
type KnownOutgoingType = "host.accepted" | "host.rejected" | "hcp.command.nack" | MockControlPlaneCommandType;

type IncomingEnvelope = Extract<HcpMessage, { type: KnownIncomingType }>;

type MockControlPlaneOptions = {
  host?: string;
  port?: number;
  heartbeatIntervalSeconds?: number;
  searchFallbackPorts?: boolean;
  pairingCodeTtlMs?: number;
  connectionTokenTtlMs?: number;
};

export type MockControlPlaneState = {
  acceptedRunnerId?: string;
  acceptedHostId?: string;
  lastHeartbeatAt?: string;
  latestCapabilities?: HcpHostCapabilitiesUpdatedPayload;
  pairingCodesIssued: number;
  credentialsIssued: number;
  rejectedConnections: string[];
  commandAcks: HcpAckPayload[];
  commandNacks: HcpNackPayload[];
  events: HcpHarnessEventPayload[];
  receivedMessageCount: number;
};

export type MockControlPlaneServer = {
  host: string;
  port: number;
  url: string;
  state: MockControlPlaneState;
  sendSessionStart: (payload: HcpSessionStartPayload) => string;
  sendTurn: (payload: HcpTurnSendPayload) => string;
  cancelTurn: (payload: HcpTurnCancelPayload) => string;
  stopSession: (payload: HcpSessionStopPayload) => string;
  revokeCredential: (credentialId: string, reason?: string) => void;
  close: () => Promise<void>;
};

type ParsedArgs = {
  host: string;
  port: number;
};

type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: HcpError };

type PairingCodeRecord = {
  code: string;
  runnerId: string;
  hostId: string;
  expiresAtMs: number;
  usedAt?: string;
};

type CredentialRecord = {
  credentialId: string;
  credentialSecret: string;
  runnerId: string;
  hostId: string;
  controlPlaneUrl: string;
  issuedAt: string;
  revokedAt?: string;
  revocationReason?: string;
  mcpProofSecret: string;
};

type ConnectionTokenRecord = {
  token: string;
  credentialId: string;
  expiresAtMs: number;
  usedAt?: string;
};

type AuthenticatedConnection = {
  credentialId: string;
  runnerId: string;
  hostId: string;
};

type ReferenceCredentialStore = {
  pairingCodes: Map<string, PairingCodeRecord>;
  credentials: Map<string, CredentialRecord>;
  connectionTokens: Map<string, ConnectionTokenRecord>;
  activeCredentialId?: string;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function validationError(code: string, message: string, details?: Record<string, unknown>): HcpError {
  return {
    code,
    message,
    retryable: false,
    ...(details === undefined ? {} : { details }),
  };
}

function validateEnvelope(raw: unknown): ValidationResult<IncomingEnvelope> {
  let envelope: HcpMessage;
  try {
    envelope = parseHcpMessage(raw);
  } catch (error: unknown) {
    return {
      ok: false,
      error: validationError(
        "invalid_message",
        error instanceof Error ? error.message : "Message failed protocol validation.",
      ),
    };
  }

  if (
    envelope.type !== "host.hello" &&
    envelope.type !== "host.heartbeat" &&
    envelope.type !== "host.capabilities.updated" &&
    envelope.type !== "hcp.command.ack" &&
    envelope.type !== "hcp.command.nack" &&
    envelope.type !== "harness.event"
  ) {
    return {
      ok: false,
      error: validationError("unsupported_message_type", "Message type is not supported by the mock control plane.", {
        received: envelope.type,
      }),
    };
  }

  return { ok: true, value: envelope };
}

function makeEnvelope<TType extends KnownOutgoingType, TPayload>(
  type: TType,
  payload: TPayload,
): HcpEnvelope<TType, TPayload> {
  return {
    id: randomUUID(),
    type,
    version: HCP_VERSION,
    sent_at: new Date().toISOString(),
    payload,
  };
}

function sendEnvelope<TType extends KnownOutgoingType, TPayload>(
  socket: WebSocket,
  type: TType,
  payload: TPayload,
): string {
  const envelope: HcpEnvelope<TType, TPayload> = makeEnvelope(type, payload);
  socket.send(JSON.stringify(envelope));
  return envelope.id;
}

function sendNack(socket: WebSocket, commandId: string, error: HcpError): void {
  sendEnvelope(socket, "hcp.command.nack", {
    command_id: commandId,
    rejected_at: new Date().toISOString(),
    error,
  });
}

function jsonResponse(response: ServerResponse, statusCode: number, body: Record<string, unknown>): void {
  response.writeHead(statusCode, {
    "content-type": "application/json",
  });
  response.end(JSON.stringify(body));
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function requireStringField(body: unknown, field: string): string {
  const record: Record<string, unknown> | undefined = asRecord(body);
  const value: unknown = record?.[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required field '${field}'.`);
  }
  return value;
}

function createSecret(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString("base64url")}`;
}

function normalizeControlPlaneHttpUrl(request: IncomingMessage, host: string, port: number): string {
  const forwardedProto = request.headers["x-forwarded-proto"];
  const protocol = typeof forwardedProto === "string" ? forwardedProto : "http";
  return `${protocol}://${host}:${port}`;
}

function controlPlaneWsUrl(host: string, port: number): string {
  return `ws://${host}:${port}`;
}

async function handlePairingHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  store: ReferenceCredentialStore,
  state: MockControlPlaneState,
  host: string,
  port: number,
  pairingCodeTtlMs: number,
  connectionTokenTtlMs: number,
): Promise<boolean> {
  if (request.method !== "POST") {
    return false;
  }

  const requestUrl = new URL(request.url ?? "/", normalizeControlPlaneHttpUrl(request, host, port));
  try {
    if (requestUrl.pathname === "/pairing-codes") {
      const body: unknown = await readJsonBody(request);
      const runnerId: string = requireStringField(body, "runner_id");
      const hostId: string = requireStringField(body, "host_id");
      const code: string = createSecret("pair");
      const expiresAtMs: number = Date.now() + pairingCodeTtlMs;
      store.pairingCodes.set(code, {
        code,
        runnerId,
        hostId,
        expiresAtMs,
      });
      state.pairingCodesIssued += 1;
      jsonResponse(response, 200, {
        pairing_code: code,
        pairing_url: `${normalizeControlPlaneHttpUrl(request, host, port)}/pair/${code}`,
        expires_at: new Date(expiresAtMs).toISOString(),
      });
      return true;
    }

    if (requestUrl.pathname === "/pairing-exchange") {
      const body: unknown = await readJsonBody(request);
      const pairingCode: string = requireStringField(body, "pairing_code");
      const runnerId: string = requireStringField(body, "runner_id");
      const hostId: string = requireStringField(body, "host_id");
      const pairingRecord: PairingCodeRecord | undefined = store.pairingCodes.get(pairingCode);
      if (!pairingRecord) {
        jsonResponse(response, 404, { error: "Pairing code was not found." });
        return true;
      }
      if (pairingRecord.usedAt) {
        jsonResponse(response, 409, { error: "Pairing code has already been used." });
        return true;
      }
      if (pairingRecord.expiresAtMs <= Date.now()) {
        jsonResponse(response, 410, { error: "Pairing code has expired." });
        return true;
      }
      if (pairingRecord.runnerId !== runnerId || pairingRecord.hostId !== hostId) {
        jsonResponse(response, 403, { error: "Pairing code is bound to a different runner or host." });
        return true;
      }

      pairingRecord.usedAt = new Date().toISOString();
      const credential: CredentialRecord = {
        credentialId: createSecret("cred"),
        credentialSecret: createSecret("secret"),
        runnerId,
        hostId,
        controlPlaneUrl: controlPlaneWsUrl(host, port),
        issuedAt: new Date().toISOString(),
        mcpProofSecret: createSecret("mcp_proof"),
      };
      store.credentials.set(credential.credentialId, credential);
      state.credentialsIssued += 1;
      jsonResponse(response, 200, {
        control_plane_url: credential.controlPlaneUrl,
        credential: {
          credential_id: credential.credentialId,
          credential_secret: credential.credentialSecret,
          runner_id: credential.runnerId,
          host_id: credential.hostId,
          control_plane_url: credential.controlPlaneUrl,
          issued_at: credential.issuedAt,
          mcp_proof_secret: credential.mcpProofSecret,
        },
      });
      return true;
    }

    if (requestUrl.pathname === "/runner-connection-token") {
      const body: unknown = await readJsonBody(request);
      const credentialId: string = requireStringField(body, "credential_id");
      const credentialSecret: string = requireStringField(body, "credential_secret");
      const runnerId: string = requireStringField(body, "runner_id");
      const hostId: string = requireStringField(body, "host_id");
      const credential: CredentialRecord | undefined = store.credentials.get(credentialId);
      if (!credential || credential.credentialSecret !== credentialSecret) {
        jsonResponse(response, 401, { error: "Runner credential is invalid." });
        return true;
      }
      if (credential.revokedAt) {
        jsonResponse(response, 403, { error: "Runner credential has been revoked." });
        return true;
      }
      if (credential.runnerId !== runnerId || credential.hostId !== hostId) {
        jsonResponse(response, 403, { error: "Runner credential is bound to a different runner or host." });
        return true;
      }
      const token: string = createSecret("connection");
      const expiresAtMs: number = Date.now() + connectionTokenTtlMs;
      store.connectionTokens.set(token, {
        token,
        credentialId: credential.credentialId,
        expiresAtMs,
      });
      jsonResponse(response, 200, {
        connection_token: token,
        expires_at: new Date(expiresAtMs).toISOString(),
      });
      return true;
    }

    if (requestUrl.pathname === "/credentials/revoke") {
      const body: unknown = await readJsonBody(request);
      const credentialId: string = requireStringField(body, "credential_id");
      const credential: CredentialRecord | undefined = store.credentials.get(credentialId);
      if (!credential) {
        jsonResponse(response, 404, { error: "Runner credential was not found." });
        return true;
      }
      credential.revokedAt = new Date().toISOString();
      credential.revocationReason = "reference_control_plane_request";
      jsonResponse(response, 200, { revoked: true });
      return true;
    }
  } catch (error: unknown) {
    jsonResponse(response, 400, { error: error instanceof Error ? error.message : "Invalid request." });
    return true;
  }

  return false;
}

function authenticateWebSocketRequest(
  request: IncomingMessage,
  store: ReferenceCredentialStore,
): ValidationResult<AuthenticatedConnection | undefined> {
  const authorization = request.headers.authorization;
  if (authorization === undefined) {
    return { ok: true, value: undefined };
  }
  if (!authorization.startsWith("Bearer ")) {
    return {
      ok: false,
      error: validationError("invalid_connection_token", "WebSocket authorization must use a bearer connection token."),
    };
  }

  const token: string = authorization.slice("Bearer ".length);
  const tokenRecord: ConnectionTokenRecord | undefined = store.connectionTokens.get(token);
  if (!tokenRecord) {
    return {
      ok: false,
      error: validationError("invalid_connection_token", "Connection token was not issued by this control plane."),
    };
  }
  if (tokenRecord.usedAt) {
    return {
      ok: false,
      error: validationError("connection_token_replayed", "Connection token was already used."),
    };
  }
  if (tokenRecord.expiresAtMs <= Date.now()) {
    return {
      ok: false,
      error: validationError("connection_token_expired", "Connection token has expired."),
    };
  }

  const credential: CredentialRecord | undefined = store.credentials.get(tokenRecord.credentialId);
  if (!credential || credential.revokedAt) {
    return {
      ok: false,
      error: validationError("runner_credential_revoked", "Runner credential is missing or revoked."),
    };
  }

  tokenRecord.usedAt = new Date().toISOString();
  return {
    ok: true,
    value: {
      credentialId: credential.credentialId,
      runnerId: credential.runnerId,
      hostId: credential.hostId,
    },
  };
}

function parseJsonMessage(data: WebSocket.RawData): ValidationResult<unknown> {
  try {
    return { ok: true, value: JSON.parse(data.toString("utf8")) };
  } catch (error: unknown) {
    return {
      ok: false,
      error: validationError("invalid_json", error instanceof Error ? error.message : "Message must be valid JSON."),
    };
  }
}

function handleMessage(
  socket: WebSocket,
  state: MockControlPlaneState,
  heartbeatIntervalSeconds: number,
  authenticatedConnection: AuthenticatedConnection | undefined,
  data: WebSocket.RawData,
): void {
  const parsed = parseJsonMessage(data);
  if (!parsed.ok) {
    sendNack(socket, "unknown", parsed.error);
    return;
  }

  const envelopeResult = validateEnvelope(parsed.value);
  if (!envelopeResult.ok) {
    const partial = asRecord(parsed.value);
    sendNack(socket, typeof partial?.id === "string" ? partial.id : "unknown", envelopeResult.error);
    return;
  }

  const envelope: IncomingEnvelope = envelopeResult.value;
  state.receivedMessageCount += 1;

  if (envelope.type === "host.hello") {
    const helloPayload: HcpHostHelloPayload = envelope.payload;
    if (
      authenticatedConnection !== undefined &&
      (helloPayload.runner_id !== authenticatedConnection.runnerId || helloPayload.host_id !== authenticatedConnection.hostId)
    ) {
      sendEnvelope(socket, "host.rejected", {
        reason: "Runner credential binding does not match host.hello.",
        supported_protocol_versions: [HCP_VERSION],
      });
      socket.close(1008, "credential binding mismatch");
      return;
    }
    state.acceptedRunnerId = helloPayload.runner_id;
    state.acceptedHostId = helloPayload.host_id;

    const accepted: HcpHostAcceptedPayload = {
      protocol_version: HCP_VERSION,
      heartbeat_interval_seconds: heartbeatIntervalSeconds,
    };

    sendEnvelope(socket, "host.accepted", accepted);
    return;
  }

  if (envelope.type === "host.heartbeat") {
    state.lastHeartbeatAt = new Date().toISOString();
    return;
  }

  if (envelope.type === "hcp.command.ack") {
    state.commandAcks.push(envelope.payload);
    return;
  }

  if (envelope.type === "hcp.command.nack") {
    state.commandNacks.push(envelope.payload);
    return;
  }

  if (envelope.type === "harness.event") {
    state.events.push(envelope.payload);
    return;
  }

  const capabilitiesPayload: HcpHostCapabilitiesUpdatedPayload = envelope.payload;
  state.latestCapabilities = capabilitiesPayload;
}

function listen(server: HttpServer, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : port);
    });
  });
}

function isAddressInUse(error: unknown): boolean {
  return asRecord(error)?.code === "EADDRINUSE";
}

async function listenWithFallback(server: HttpServer, host: string, port: number, searchFallbackPorts: boolean): Promise<number> {
  const maxAttempts = searchFallbackPorts ? DEFAULT_PORT_SEARCH_LIMIT : 1;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidatePort = port === 0 ? 0 : port + attempt;
    try {
      return await listen(server, host, candidatePort);
    } catch (error: unknown) {
      if (!isAddressInUse(error) || attempt === maxAttempts - 1 || port === 0) {
        throw error;
      }
    }
  }

  throw new Error(`No available port found starting at ${port}.`);
}

export async function startMockControlPlane(options: MockControlPlaneOptions = {}): Promise<MockControlPlaneServer> {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const searchFallbackPorts = options.searchFallbackPorts ?? options.port === undefined;
  const heartbeatIntervalSeconds = options.heartbeatIntervalSeconds ?? DEFAULT_HEARTBEAT_INTERVAL_SECONDS;
  const pairingCodeTtlMs = options.pairingCodeTtlMs ?? DEFAULT_PAIRING_CODE_TTL_MS;
  const connectionTokenTtlMs = options.connectionTokenTtlMs ?? DEFAULT_CONNECTION_TOKEN_TTL_MS;
  const state: MockControlPlaneState = {
    pairingCodesIssued: 0,
    credentialsIssued: 0,
    rejectedConnections: [],
    commandAcks: [],
    commandNacks: [],
    events: [],
    receivedMessageCount: 0,
  };
  const store: ReferenceCredentialStore = {
    pairingCodes: new Map(),
    credentials: new Map(),
    connectionTokens: new Map(),
  };
  let boundPort = port;
  const httpServer = createServer((request: IncomingMessage, response: ServerResponse) => {
    handlePairingHttpRequest(
      request,
      response,
      store,
      state,
      host,
      boundPort,
      pairingCodeTtlMs,
      connectionTokenTtlMs,
    )
      .then((handled: boolean) => {
        if (!handled) {
          jsonResponse(response, 404, { error: "Not found." });
        }
      })
      .catch((error: unknown) => {
        jsonResponse(response, 500, { error: error instanceof Error ? error.message : "Request failed." });
      });
  });
  const webSocketServer = new WebSocketServer({ server: httpServer });
  let activeSocket: WebSocket | undefined;

  webSocketServer.on("connection", (socket: WebSocket, request: IncomingMessage) => {
    const authResult: ValidationResult<AuthenticatedConnection | undefined> = authenticateWebSocketRequest(request, store);
    if (!authResult.ok) {
      state.rejectedConnections.push(authResult.error.code);
      sendEnvelope(socket, "host.rejected", {
        reason: authResult.error.message,
        supported_protocol_versions: [HCP_VERSION],
      });
      socket.close(1008, authResult.error.code);
      return;
    }

    const authenticatedConnection: AuthenticatedConnection | undefined = authResult.value;
    if (authenticatedConnection === undefined && store.credentials.size > 0) {
      state.rejectedConnections.push("missing_connection_token");
      sendEnvelope(socket, "host.rejected", {
        reason: "A paired runner must connect with a short-lived connection token.",
        supported_protocol_versions: [HCP_VERSION],
      });
      socket.close(1008, "missing connection token");
      return;
    }

    if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
      state.rejectedConnections.push("duplicate_runner_connection");
      sendEnvelope(socket, "host.rejected", {
        reason: "A runner is already connected to this mock control plane.",
        supported_protocol_versions: [HCP_VERSION],
      });
      socket.close(1008, "duplicate runner connection");
      return;
    }

    activeSocket = socket;
    if (authenticatedConnection) {
      store.activeCredentialId = authenticatedConnection.credentialId;
    } else {
      delete store.activeCredentialId;
    }
    socket.on("close", () => {
      if (activeSocket === socket) {
        activeSocket = undefined;
        if (store.activeCredentialId === authenticatedConnection?.credentialId) {
          delete store.activeCredentialId;
        }
      }
    });
    socket.on("message", (data: WebSocket.RawData) =>
      handleMessage(socket, state, heartbeatIntervalSeconds, authenticatedConnection, data),
    );
  });

  boundPort = await listenWithFallback(httpServer, host, port, searchFallbackPorts);
  const sendCommand = <TType extends MockControlPlaneCommandType, TPayload>(type: TType, payload: TPayload): string => {
    const socket: WebSocket = requireActiveSocket(activeSocket);
    return sendEnvelope(socket, type, payload);
  };

  return {
    host,
    port: boundPort,
    url: `ws://${host}:${boundPort}`,
    state,
    sendSessionStart: (payload: HcpSessionStartPayload): string => sendCommand("harness.session.start", payload),
    sendTurn: (payload: HcpTurnSendPayload): string => sendCommand("harness.turn.send", payload),
    cancelTurn: (payload: HcpTurnCancelPayload): string => sendCommand("harness.turn.cancel", payload),
    stopSession: (payload: HcpSessionStopPayload): string => sendCommand("harness.session.stop", payload),
    revokeCredential: (credentialId: string, reason = "reference_control_plane_request"): void => {
      const credential: CredentialRecord | undefined = store.credentials.get(credentialId);
      if (!credential) {
        return;
      }
      credential.revokedAt = new Date().toISOString();
      credential.revocationReason = reason;
      if (store.activeCredentialId === credentialId && activeSocket?.readyState === WebSocket.OPEN) {
        activeSocket.close(1008, "credential revoked");
      }
    },
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        webSocketServer.close((socketError?: Error) => {
          if (socketError !== undefined) {
            reject(socketError);
            return;
          }

          httpServer.close((serverError?: Error) => {
            if (serverError !== undefined) {
              reject(serverError);
              return;
            }

            resolve();
          });
        });
      });
    },
  };
}

function requireActiveSocket(socket: WebSocket | undefined): WebSocket {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    throw new Error("No runner is connected to the mock control plane.");
  }

  return socket;
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined || value.length === 0) {
    return undefined;
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }

  return port;
}

function parseArgs(argv: string[], env: NodeJS.ProcessEnv): ParsedArgs {
  let host = env.HCP_MOCK_CONTROL_PLANE_HOST ?? DEFAULT_HOST;
  let port = parsePort(env.HCP_MOCK_CONTROL_PLANE_PORT) ?? DEFAULT_PORT;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--host") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("--host requires a value.");
      }

      host = value;
      index += 1;
      continue;
    }

    if (arg === "--port") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("--port requires a value.");
      }

      port = parsePort(value) ?? DEFAULT_PORT;
      index += 1;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      console.log("Usage: hcp-mock-control-plane [--host 127.0.0.1] [--port 8787]");
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { host, port };
}

async function main(): Promise<void> {
  const args: ParsedArgs = parseArgs(process.argv.slice(2), process.env);
  const server: MockControlPlaneServer = await startMockControlPlane(args);
  console.log(`HCP mock control plane listening at ${server.url}`);
}

const isDirectExecution = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectExecution) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
