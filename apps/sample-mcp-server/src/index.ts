import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8791;
const DEFAULT_TIMESTAMP_SKEW_MS = 5 * 60 * 1000;

export type SampleMcpLease = {
  lease_id: string;
  key_id: string;
  secret: string;
  session_id: string;
  host_id: string;
  provider_instance_id: string;
  workspace_id: string;
  server_id: string;
  expires_at: string;
  allowed_tools?: string[];
  denied_tools?: string[];
  revoked?: boolean;
};

export type SampleMcpServerOptions = {
  host?: string;
  port?: number;
  lease: SampleMcpLease;
  now?: () => Date;
  timestampSkewMs?: number;
};

export type SampleMcpServer = {
  host: string;
  port: number;
  url: string;
  revokeLease(): void;
  close(): Promise<void>;
};

type ProofClaims = {
  keyId: string;
  leaseId: string;
  sessionId: string;
  hostId: string;
  providerInstanceId: string;
  workspaceId: string;
  serverId: string;
  turnId?: string;
  timestamp: string;
  nonce: string;
  bodyHash: string;
  signature: string;
};

type JsonRpcRequest = {
  method?: string;
  params?: {
    name?: string;
  };
};

type ProofVerificationResult =
  | { ok: true }
  | {
      ok: false;
      statusCode: number;
      code: string;
      message: string;
    };

export async function startSampleMcpServer(options: SampleMcpServerOptions): Promise<SampleMcpServer> {
  const host: string = options.host ?? DEFAULT_HOST;
  const port: number = options.port ?? DEFAULT_PORT;
  const now: () => Date = options.now ?? (() => new Date());
  const timestampSkewMs: number = options.timestampSkewMs ?? DEFAULT_TIMESTAMP_SKEW_MS;
  const usedNonces = new Set<string>();
  const lease: SampleMcpLease = { ...options.lease };
  const httpServer: HttpServer = createServer((request: IncomingMessage, response: ServerResponse) => {
    handleRequest(request, response, lease, usedNonces, now, timestampSkewMs).catch((error: unknown) => {
      writeJsonRpcError(
        response,
        500,
        "internal_error",
        error instanceof Error ? error.message : "Sample MCP server request failed.",
      );
    });
  });
  const boundPort: number = await listen(httpServer, host, port);

  return {
    host,
    port: boundPort,
    url: `http://${host}:${boundPort}/mcp`,
    revokeLease(): void {
      lease.revoked = true;
    },
    close: async (): Promise<void> => {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error?: Error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  lease: SampleMcpLease,
  usedNonces: Set<string>,
  now: () => Date,
  timestampSkewMs: number,
): Promise<void> {
  if (request.method !== "POST" || request.url !== "/mcp") {
    writeJsonRpcError(response, 405, "method_not_allowed", "Sample MCP server only accepts POST /mcp.");
    return;
  }

  const rawBody: string = await readRequestBody(request);
  const parsedBody: unknown = rawBody.length === 0 ? undefined : JSON.parse(rawBody);
  const proofResult: ProofVerificationResult = verifyProof({
    request,
    rawBody,
    parsedBody,
    lease,
    usedNonces,
    now,
    timestampSkewMs,
  });
  if (!proofResult.ok) {
    writeJsonRpcError(response, proofResult.statusCode, proofResult.code, proofResult.message);
    return;
  }

  const mcp = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  } as unknown as ConstructorParameters<typeof StreamableHTTPServerTransport>[0]);
  await mcp.connect(transport as Parameters<McpServer["connect"]>[0]);
  response.on("close", () => {
    transport.close().catch(() => undefined);
    mcp.close().catch(() => undefined);
  });
  await transport.handleRequest(request, response, parsedBody);
}

function createMcpServer(): McpServer {
  const server = new McpServer({ name: "hcp-sample-mcp", version: "0.0.0" });
  server.registerTool(
    "echo",
    {
      title: "Echo",
      description: "Echoes a text value.",
      inputSchema: {
        text: z.string(),
      },
    },
    ({ text }) => ({
      content: [{ type: "text", text }],
      structuredContent: { text },
    }),
  );
  server.registerTool(
    "server_status",
    {
      title: "Server Status",
      description: "Returns a stable sample status payload.",
      inputSchema: {},
    },
    () => ({
      content: [{ type: "text", text: "ok" }],
      structuredContent: { status: "ok" },
    }),
  );
  server.registerTool(
    "secret_admin",
    {
      title: "Secret Admin",
      description: "A tool used to prove lease tool-scope denial.",
      inputSchema: {},
    },
    () => ({
      content: [{ type: "text", text: "secret" }],
      structuredContent: { secret: true },
    }),
  );
  return server;
}

function verifyProof(input: {
  request: IncomingMessage;
  rawBody: string;
  parsedBody: unknown;
  lease: SampleMcpLease;
  usedNonces: Set<string>;
  now: () => Date;
  timestampSkewMs: number;
}): ProofVerificationResult {
  if (input.lease.revoked) {
    return denied("lease_revoked", "MCP lease has been revoked.");
  }
  if (Date.parse(input.lease.expires_at) <= input.now().getTime()) {
    return denied("lease_expired", "MCP lease has expired.");
  }

  const claimsResult: ProofClaims | undefined = readProofClaims(input.request);
  if (!claimsResult) {
    return denied("proof_missing", "Required HCP proof headers are missing.");
  }
  const claims: ProofClaims = claimsResult;
  if (claims.keyId !== input.lease.key_id || claims.leaseId !== input.lease.lease_id) {
    return denied("proof_lease_mismatch", "Proof key or lease id does not match the lease.");
  }
  if (
    claims.sessionId !== input.lease.session_id ||
    claims.hostId !== input.lease.host_id ||
    claims.providerInstanceId !== input.lease.provider_instance_id ||
    claims.workspaceId !== input.lease.workspace_id ||
    claims.serverId !== input.lease.server_id
  ) {
    return denied("proof_binding_mismatch", "Proof binding does not match the lease.");
  }
  const timestampMs: number = Date.parse(claims.timestamp);
  if (Number.isNaN(timestampMs) || Math.abs(input.now().getTime() - timestampMs) > input.timestampSkewMs) {
    return denied("proof_timestamp_stale", "Proof timestamp is outside the allowed window.");
  }
  if (input.usedNonces.has(claims.nonce)) {
    return denied("proof_nonce_reused", "Proof nonce has already been used.");
  }
  const expectedBodyHash: string = hashBody(input.rawBody);
  if (claims.bodyHash !== expectedBodyHash) {
    return denied("proof_body_hash_mismatch", "Proof body hash does not match the request body.");
  }
  const expectedSignature: string = signProof({
    secret: input.lease.secret,
    method: input.request.method ?? "POST",
    url: requestUrl(input.request),
    claims,
  });
  if (!safeEqual(claims.signature, expectedSignature)) {
    return denied("proof_signature_invalid", "Proof signature is invalid.");
  }

  const toolName: string | undefined = toolNameFromJsonRpc(input.parsedBody);
  if (toolName && !toolAllowed(input.lease, toolName)) {
    return denied("tool_not_allowed", `Tool '${toolName}' is not allowed by this lease.`);
  }

  input.usedNonces.add(claims.nonce);
  return { ok: true };
}

function readProofClaims(request: IncomingMessage): ProofClaims | undefined {
  const keyId: string | undefined = header(request, "x-hcp-proof-key-id");
  const leaseId: string | undefined = header(request, "x-hcp-lease-id");
  const sessionId: string | undefined = header(request, "x-hcp-session-id");
  const hostId: string | undefined = header(request, "x-hcp-host-id");
  const providerInstanceId: string | undefined = header(request, "x-hcp-provider-instance-id");
  const workspaceId: string | undefined = header(request, "x-hcp-workspace-id");
  const serverId: string | undefined = header(request, "x-hcp-mcp-server-id");
  const timestamp: string | undefined = header(request, "x-hcp-proof-timestamp");
  const nonce: string | undefined = header(request, "x-hcp-proof-nonce");
  const bodyHash: string | undefined = header(request, "x-hcp-proof-body-sha256");
  const signature: string | undefined = header(request, "x-hcp-proof-signature");
  if (
    !keyId ||
    !leaseId ||
    !sessionId ||
    !hostId ||
    !providerInstanceId ||
    !workspaceId ||
    !serverId ||
    !timestamp ||
    !nonce ||
    !bodyHash ||
    !signature
  ) {
    return undefined;
  }

  const turnId: string | undefined = header(request, "x-hcp-turn-id");
  return {
    keyId,
    leaseId,
    sessionId,
    hostId,
    providerInstanceId,
    workspaceId,
    serverId,
    timestamp,
    nonce,
    bodyHash,
    signature,
    ...(turnId ? { turnId } : {}),
  };
}

function signProof(input: { secret: string; method: string; url: string; claims: ProofClaims }): string {
  return `hmac-sha256:${createHmac("sha256", input.secret).update(canonicalProofString(input.method, input.url, input.claims)).digest("base64url")}`;
}

function canonicalProofString(method: string, url: string, claims: ProofClaims): string {
  return [
    method.toUpperCase(),
    url,
    claims.bodyHash,
    claims.leaseId,
    claims.sessionId,
    claims.hostId,
    claims.providerInstanceId,
    claims.workspaceId,
    claims.serverId,
    claims.turnId ?? "",
    claims.timestamp,
    claims.nonce,
  ].join("\n");
}

function hashBody(rawBody: string): string {
  return `sha256:${createHash("sha256").update(rawBody).digest("base64url")}`;
}

function requestUrl(request: IncomingMessage): string {
  const host: string = request.headers.host ?? `${DEFAULT_HOST}:${DEFAULT_PORT}`;
  return `http://${host}${request.url ?? "/mcp"}`;
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return undefined;
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.byteLength === rightBuffer.byteLength && timingSafeEqual(leftBuffer, rightBuffer);
}

function toolNameFromJsonRpc(value: unknown): string | undefined {
  const request: JsonRpcRequest | undefined = asJsonRpcRequest(value);
  if (!request || request.method !== "tools/call") {
    return undefined;
  }
  return request.params?.name;
}

function asJsonRpcRequest(value: unknown): JsonRpcRequest | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as JsonRpcRequest;
}

function toolAllowed(lease: SampleMcpLease, toolName: string): boolean {
  if (lease.denied_tools?.includes(toolName)) {
    return false;
  }
  return lease.allowed_tools ? lease.allowed_tools.includes(toolName) : true;
}

function denied(code: string, message: string): ProofVerificationResult {
  return {
    ok: false,
    statusCode: 403,
    code,
    message,
  };
}

function writeJsonRpcError(response: ServerResponse, statusCode: number, code: string, message: string): void {
  if (response.headersSent) {
    return;
  }
  response.writeHead(statusCode, {
    "content-type": "application/json",
  });
  response.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code,
        message,
      },
      id: null,
    }),
  );
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
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
