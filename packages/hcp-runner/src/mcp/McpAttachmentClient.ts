import { Client } from "@modelcontextprotocol/sdk/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { HcpEventType, McpServerAttachment } from "@hcp-runner/protocol";

import { redactHeaders, redactValue } from "./redaction.js";

export type McpAttachmentEvent = {
  event_type: HcpEventType;
  data: Record<string, unknown>;
};

export type McpAttachmentEventSink = (event: McpAttachmentEvent) => void | Promise<void>;

export type McpToolCallArguments = Record<string, unknown>;

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

type SdkToolClient = {
  connect(transport: unknown): Promise<void>;
  listTools(): Promise<{ tools: Tool[] }>;
  callTool(params: { name: string; arguments?: McpToolCallArguments }): Promise<SdkToolCallResult>;
  close(): Promise<void>;
};

type SdkToolCallResult = Awaited<ReturnType<Client["callTool"]>>;

type McpSdkFactory = {
  createClient(): SdkToolClient;
  createStreamableHttpTransport(attachment: McpServerAttachment): unknown;
};

export type McpAttachmentClientOptions = {
  eventSink?: McpAttachmentEventSink;
  sdkFactory?: McpSdkFactory;
  now?: () => Date;
};

export class McpAttachmentClient {
  private readonly allowedTools: ReadonlySet<string> | undefined;
  private readonly deniedTools: ReadonlySet<string>;
  private readonly eventSink: McpAttachmentEventSink | undefined;
  private readonly sdkFactory: McpSdkFactory;
  private readonly now: () => Date;
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
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    this.assertNotExpired();

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
    const transport: unknown = this.sdkFactory.createStreamableHttpTransport(this.attachment);
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
}

const defaultMcpSdkFactory: McpSdkFactory = {
  createClient(): SdkToolClient {
    return new Client({ name: "hcp-runner", version: "0.0.0" });
  },
  createStreamableHttpTransport(attachment: McpServerAttachment): unknown {
    if (!attachment.headers) {
      return new StreamableHTTPClientTransport(new URL(attachment.url));
    }

    return new StreamableHTTPClientTransport(new URL(attachment.url), { requestInit: { headers: attachment.headers } });
  },
};

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
