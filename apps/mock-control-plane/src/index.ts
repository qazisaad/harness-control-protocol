import { createServer, type Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
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
  type HcpMessage,
} from "@hcp-runner/protocol";

const DEFAULT_PORT = 8787;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 30;
const DEFAULT_PORT_SEARCH_LIMIT = 12;

type KnownIncomingType = "host.hello" | "host.heartbeat" | "host.capabilities.updated";
type KnownOutgoingType = "host.accepted" | "ack" | "nack";

type IncomingEnvelope = Extract<HcpMessage, { type: KnownIncomingType }>;

type MockControlPlaneOptions = {
  host?: string;
  port?: number;
  heartbeatIntervalSeconds?: number;
  searchFallbackPorts?: boolean;
};

export type MockControlPlaneState = {
  acceptedRunnerId?: string;
  acceptedHostId?: string;
  lastHeartbeatAt?: string;
  latestCapabilities?: HcpHostCapabilitiesUpdatedPayload;
  receivedMessageCount: number;
};

export type MockControlPlaneServer = {
  host: string;
  port: number;
  url: string;
  state: MockControlPlaneState;
  close: () => Promise<void>;
};

type ParsedArgs = {
  host: string;
  port: number;
};

type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: HcpError };

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

  if (envelope.type !== "host.hello" && envelope.type !== "host.heartbeat" && envelope.type !== "host.capabilities.updated") {
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
): void {
  socket.send(JSON.stringify(makeEnvelope(type, payload)));
}

function sendAck(socket: WebSocket, receivedMessageId: string): void {
  const payload: HcpAckPayload = {
    received_message_id: receivedMessageId,
    status: "ack",
  };

  sendEnvelope(socket, "ack", payload);
}

function sendNack(socket: WebSocket, receivedMessageId: string, error: HcpError): void {
  sendEnvelope(socket, "nack", {
    received_message_id: receivedMessageId,
    status: "nack",
    error,
  });
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
    sendAck(socket, envelope.id);
    return;
  }

  const capabilitiesPayload: HcpHostCapabilitiesUpdatedPayload = envelope.payload;
  state.latestCapabilities = capabilitiesPayload;
  sendAck(socket, envelope.id);
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
  const state: MockControlPlaneState = {
    receivedMessageCount: 0,
  };
  const httpServer = createServer();
  const webSocketServer = new WebSocketServer({ server: httpServer });

  webSocketServer.on("connection", (socket: WebSocket) => {
    socket.on("message", (data: WebSocket.RawData) => handleMessage(socket, state, heartbeatIntervalSeconds, data));
  });

  const boundPort: number = await listenWithFallback(httpServer, host, port, searchFallbackPorts);

  return {
    host,
    port: boundPort,
    url: `ws://${host}:${boundPort}`,
    state,
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
