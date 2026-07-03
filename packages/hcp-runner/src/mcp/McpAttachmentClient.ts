import { createHash, createHmac, randomUUID } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { HcpEventType, McpServerAttachment } from "@harness-control/protocol";

import { redactHeaders, redactValue } from "./redaction.js";

export type McpAttachmentEvent = {
  event_type: HcpEventType;
  data: Record<string, unknown>;
};

export type McpAttachmentEventSink = (event: McpAttachmentEvent) => void | Promise<void>;

export type McpToolCallArguments = Record<string, unknown>;
type FetchLike = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => ReturnType<typeof fetch>;

export type McpToolDescriptor = {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
};

export type McpToolCallResult = {
  content?: unknown[];
  structured_content?: Record<string, unknown>;
  is_error: boolean;
};

export class McpToolPolicyError extends Error {
  constructor(
    readonly attachmentName: string,
    readonly toolName: string,
    message: string,
  ) {
    super(message);
    this.name = "McpToolPolicyError";
  }
}

export class McpAttachmentExpiredError extends Error {
  constructor(readonly attachmentName: string) {
    super(`MCP attachment "${attachmentName}" has expired.`);
    this.name = "McpAttachmentExpiredError";
  }
}

export class McpProofBindingError extends Error {
  constructor(readonly attachmentName: string, message: string) {
    super(message);
    this.name = "McpProofBindingError";
  }
}

export type McpProofContext = {
  session_id: string;
  host_id: string;
  provider_instance_id: string;
  workspace_id: string;
  server_id?: string;
  turn_id?: string;
};

export type McpProofSigningInput = {
  key_id: string;
  method: string;
  url: string;
  body_hash: string;
  lease_id: string;
  session_id: string;
  host_id: string;
  provider_instance_id: string;
  workspace_id: string;
  server_id: string;
  turn_id?: string;
  timestamp: string;
  nonce: string;
};

export type McpProofSigner = (input: McpProofSigningInput) => string;

type SdkToolClient = {
  connect(transport: unknown): Promise<void>;
  listTools(): Promise<{ tools: Tool[] }>;
  callTool(params: { name: string; arguments?: McpToolCallArguments }): Promise<SdkToolCallResult>;
  close(): Promise<void>;
};

type SdkToolCallResult = Awaited<ReturnType<Client["callTool"]>>;

type McpSdkFactory = {
  createClient(): SdkToolClient;
  createStreamableHttpTransport(attachment: McpServerAttachment, options: { fetch: FetchLike }): unknown;
};

export type McpAttachmentClientOptions = {
  eventSink?: McpAttachmentEventSink;
  sdkFactory?: McpSdkFactory;
  now?: () => Date;
  proofContext?: McpProofContext;
  proofSigner?: McpProofSigner;
};

export class McpAttachmentClient {
  private readonly allowedTools: ReadonlySet<string> | undefined;
  private readonly deniedTools: ReadonlySet<string>;
  private readonly eventSink: McpAttachmentEventSink | undefined;
  private readonly sdkFactory: McpSdkFactory;
  private readonly now: () => Date;
  private readonly proofContext: McpProofContext | undefined;
  private readonly proofSigner: McpProofSigner;
  private readonly hasProofSigner: boolean;
  private client: SdkToolClient | undefined;
  private connected = false;

  constructor(
    private readonly attachment: McpServerAttachment,
    options: McpAttachmentClientOptions = {},
  ) {
    this.allowedTools = attachment.allowed_tools ? new Set(attachment.allowed_tools) : undefined;
    this.deniedTools = new Set(attachment.denied_tools ?? []);
    this.eventSink = options.eventSink;
    this.sdkFactory = options.sdkFactory ?? defaultMcpSdkFactory;
    this.now = options.now ?? (() => new Date());
    this.proofContext = options.proofContext;
    this.proofSigner = options.proofSigner ?? missingProofSigner;
    this.hasProofSigner = options.proofSigner !== undefined;
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    this.assertNotExpired();
    this.assertProofBindingConfigured();

    if (this.attachment.transport !== "streamable_http") {
      throw new Error(`Unsupported MCP attachment transport: ${this.attachment.transport}`);
    }

    await this.emitEvent("runtime.warning", {
      event: "mcp.attachment.connecting",
      attachment: this.attachment.name,
      transport: this.attachment.transport,
      url: this.attachment.url,
      headers: redactHeaders(this.attachment.headers),
    });

    const client: SdkToolClient = this.sdkFactory.createClient();
    const transport: unknown = this.sdkFactory.createStreamableHttpTransport(this.attachment, {
      fetch: this.createProofFetch(),
    });
    await client.connect(transport);
    this.client = client;
    this.connected = true;

    await this.emitEvent("runtime.warning", {
      event: "mcp.attachment.connected",
      attachment: this.attachment.name,
    });
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    this.assertNotExpired();
    const client: SdkToolClient = this.requireConnectedClient();
    const result: { tools: Tool[] } = await client.listTools();
    const tools: Tool[] = result.tools.filter((tool: Tool): boolean => this.isToolAllowed(tool.name));

    await this.emitEvent("runtime.warning", {
      event: "mcp.tools.discovered",
      attachment: this.attachment.name,
      total_tools: result.tools.length,
      allowed_tools: tools.map((tool: Tool): string => tool.name),
    });

    return tools.map(toMcpToolDescriptor);
  }

  async callTool(name: string, arguments_: McpToolCallArguments = {}): Promise<McpToolCallResult> {
    this.assertNotExpired();
    await this.assertToolAllowed(name);

    const client: SdkToolClient = this.requireConnectedClient();
    await this.emitEvent("mcp_tool.started", {
      attachment: this.attachment.name,
      tool_name: name,
      arguments: redactValue(arguments_),
    });

    try {
      const sdkResult: SdkToolCallResult = await client.callTool({ name, arguments: arguments_ });
      const result: McpToolCallResult = toMcpToolCallResult(sdkResult);
      await this.emitEvent("mcp_tool.completed", {
        attachment: this.attachment.name,
        tool_name: name,
        result: redactValue(result),
      });
      return result;
    } catch (error: unknown) {
      await this.emitEvent("runtime.error", {
        event: "mcp.tool.failed",
        attachment: this.attachment.name,
        tool_name: name,
        error: redactError(error),
      });
      throw error;
    }
  }

  async close(): Promise<void> {
    const client: SdkToolClient | undefined = this.client;
    this.client = undefined;
    this.connected = false;

    if (client) {
      await client.close();
      await this.emitEvent("runtime.warning", {
        event: "mcp.attachment.closed",
        attachment: this.attachment.name,
      });
    }
  }

  isToolAllowed(toolName: string): boolean {
    if (this.deniedTools.has(toolName)) {
      return false;
    }

    return this.allowedTools ? this.allowedTools.has(toolName) : true;
  }

  private async assertToolAllowed(toolName: string): Promise<void> {
    if (this.isToolAllowed(toolName)) {
      return;
    }

    await this.emitEvent("runtime.error", {
      event: "mcp.tool.denied",
      attachment: this.attachment.name,
      tool_name: toolName,
    });

    throw new McpToolPolicyError(
      this.attachment.name,
      toolName,
      `MCP tool "${toolName}" is not allowed for attachment "${this.attachment.name}".`,
    );
  }

  private requireConnectedClient(): SdkToolClient {
    if (!this.client) {
      throw new Error(`MCP attachment "${this.attachment.name}" is not connected.`);
    }

    return this.client;
  }

  private async emitEvent(event_type: HcpEventType, data: Record<string, unknown>): Promise<void> {
    if (!this.eventSink) {
      return;
    }

    await this.eventSink({ event_type, data });
  }

  private assertNotExpired(): void {
    if (!this.attachment.expires_at) {
      return;
    }

    const expiresAt: number = Date.parse(this.attachment.expires_at);
    if (Number.isNaN(expiresAt) || expiresAt > this.now().getTime()) {
      return;
    }

    void this.close();
    throw new McpAttachmentExpiredError(this.attachment.name);
  }

  private assertProofBindingConfigured(): void {
    if (this.attachment.proof_of_possession.scheme !== "runner_signed_request") {
      throw new McpProofBindingError(
        this.attachment.name,
        `Unsupported MCP proof scheme: ${this.attachment.proof_of_possession.scheme}`,
      );
    }

    if (!this.proofContext) {
      throw new McpProofBindingError(
        this.attachment.name,
        `MCP attachment "${this.attachment.name}" requires runner proof context.`,
      );
    }

    if (!this.hasProofSigner) {
      throw new McpProofBindingError(
        this.attachment.name,
        `MCP attachment "${this.attachment.name}" requires a runner proof signer.`,
      );
    }
  }

  private createProofFetch(): FetchLike {
    const attachment: McpServerAttachment = this.attachment;
    const proofContext: McpProofContext | undefined = this.proofContext;
    if (!proofContext) {
      throw new McpProofBindingError(attachment.name, `MCP attachment "${attachment.name}" requires runner proof context.`);
    }

    return async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): ReturnType<typeof fetch> => {
      const method: string = init?.method ?? (input instanceof Request ? input.method : "GET");
      const url: string = requestUrl(input);
      const bodyHash: string = hashRequestBody(init?.body);
      const timestamp: string = this.now().toISOString();
      const nonce: string = randomUUID();
      const signingInput: McpProofSigningInput = {
        key_id: attachment.proof_of_possession.key_id,
        method: method.toUpperCase(),
        url,
        body_hash: bodyHash,
        lease_id: attachment.lease_id,
        session_id: proofContext.session_id,
        host_id: proofContext.host_id,
        provider_instance_id: proofContext.provider_instance_id,
        workspace_id: proofContext.workspace_id,
        server_id: proofContext.server_id ?? attachment.name,
        ...(proofContext.turn_id ? { turn_id: proofContext.turn_id } : {}),
        timestamp,
        nonce,
      };
      const signature: string = this.proofSigner(signingInput);
      const headers: Headers = new Headers(init?.headers);

      headers.set("x-hcp-proof-key-id", signingInput.key_id);
      headers.set("x-hcp-lease-id", signingInput.lease_id);
      headers.set("x-hcp-session-id", signingInput.session_id);
      headers.set("x-hcp-host-id", signingInput.host_id);
      headers.set("x-hcp-provider-instance-id", signingInput.provider_instance_id);
      headers.set("x-hcp-workspace-id", signingInput.workspace_id);
      headers.set("x-hcp-mcp-server-id", signingInput.server_id);
      headers.set("x-hcp-proof-timestamp", signingInput.timestamp);
      headers.set("x-hcp-proof-nonce", signingInput.nonce);
      headers.set("x-hcp-proof-body-sha256", signingInput.body_hash);
      headers.set("x-hcp-proof-signature", signature);
      if (signingInput.turn_id) {
        headers.set("x-hcp-turn-id", signingInput.turn_id);
      }

      for (const requiredHeader of attachment.proof_of_possession.required_headers) {
        if (!headers.has(requiredHeader)) {
          throw new McpProofBindingError(
            attachment.name,
            `Required MCP proof header '${requiredHeader}' was not produced.`,
          );
        }
      }

      return fetch(input, {
        ...init,
        headers,
      });
    };
  }
}

const defaultMcpSdkFactory: McpSdkFactory = {
  createClient(): SdkToolClient {
    return new Client({ name: "hcp-runner", version: "0.0.0" });
  },
  createStreamableHttpTransport(attachment: McpServerAttachment, options: { fetch: FetchLike }): unknown {
    return new StreamableHTTPClientTransport(new URL(attachment.url), {
      requestInit: { headers: attachment.headers },
      fetch: options.fetch,
    });
  },
};

function missingProofSigner(): string {
  throw new Error("MCP proof signer is not configured.");
}

export function createDevelopmentHmacProofSigner(secret: string): McpProofSigner {
  return (input: McpProofSigningInput): string => defaultProofSigner(input, secret);
}

function defaultProofSigner(input: McpProofSigningInput, secret: string): string {
  return `hmac-sha256:${createHmac("sha256", secret).update(canonicalProofString(input)).digest("base64url")}`;
}

function canonicalProofString(input: McpProofSigningInput): string {
  return [
    input.method,
    input.url,
    input.body_hash,
    input.lease_id,
    input.session_id,
    input.host_id,
    input.provider_instance_id,
    input.workspace_id,
    input.server_id,
    input.turn_id ?? "",
    input.timestamp,
    input.nonce,
  ].join("\n");
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

function hashRequestBody(body: BodyInit | null | undefined): string {
  if (body === undefined || body === null) {
    return sha256("");
  }
  if (typeof body === "string") {
    return sha256(body);
  }
  if (body instanceof URLSearchParams) {
    return sha256(body.toString());
  }
  if (body instanceof ArrayBuffer) {
    return sha256(Buffer.from(body));
  }
  if (ArrayBuffer.isView(body)) {
    return sha256(Buffer.from(body.buffer, body.byteOffset, body.byteLength));
  }

  return sha256("[streaming-body]");
}

function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("base64url")}`;
}

function toMcpToolDescriptor(tool: Tool): McpToolDescriptor {
  return {
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    input_schema: tool.inputSchema,
    ...(tool.outputSchema ? { output_schema: tool.outputSchema } : {}),
  };
}

function toMcpToolCallResult(result: SdkToolCallResult): McpToolCallResult {
  const converted: McpToolCallResult = {
    is_error: Boolean(result.isError),
  };

  if ("content" in result && Array.isArray(result.content)) {
    converted.content = result.content;
  } else if ("toolResult" in result) {
    converted.content = [result.toolResult];
  }

  if ("structuredContent" in result && isRecord(result.structuredContent)) {
    converted.structured_content = result.structuredContent;
  }

  return converted;
}

function redactError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: redactValue(error.message),
    };
  }

  return {
    message: redactValue(String(error)),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
