import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpServerAttachment } from "@hcp-runner/protocol";

import type { McpAttachmentClient, McpToolCallResult, McpToolDescriptor } from "./McpAttachmentClient.js";

export type McpProxyUpstream = Pick<McpAttachmentClient, "connect" | "listTools" | "callTool" | "close">;

export type McpProxyServerOptions = {
  attachment: McpServerAttachment;
  upstream: McpProxyUpstream;
  host?: "127.0.0.1" | "localhost";
  port?: number;
};

export class McpProxyServer {
  readonly #attachment: McpServerAttachment;
  readonly #upstream: McpProxyUpstream;
  readonly #host: "127.0.0.1" | "localhost";
  readonly #port: number;
  #httpServer: HttpServer | undefined;
  #adapterAttachment: McpServerAttachment | undefined;

  constructor(options: McpProxyServerOptions) {
    this.#attachment = options.attachment;
    this.#upstream = options.upstream;
    this.#host = options.host ?? "127.0.0.1";
    this.#port = options.port ?? 0;
  }

  get adapterAttachment(): McpServerAttachment | undefined {
    return this.#adapterAttachment;
  }

  async connect(): Promise<void> {
    if (this.#httpServer) {
      return;
    }

    await this.#upstream.connect();
    const httpServer: HttpServer = createServer((request: IncomingMessage, response: ServerResponse) => {
      this.#handleRequest(request, response).catch((error: unknown) => {
        writeJsonRpcError(
          response,
          500,
          "mcp_proxy_error",
          error instanceof Error ? error.message : "MCP proxy request failed.",
        );
      });
    });
    let boundPort: number;
    try {
      boundPort = await listen(httpServer, this.#host, this.#port);
    } catch (error: unknown) {
      try {
        await this.#upstream.close();
      } catch (cleanupError: unknown) {
        throw new Error(
          `${errorMessage(error, "MCP proxy listen failed.")}; upstream cleanup failed: ${errorMessage(
            cleanupError,
            "MCP proxy upstream close failed.",
          )}`,
        );
      }
      throw error;
    }
    this.#httpServer = httpServer;
    this.#adapterAttachment = {
      ...this.#attachment,
      url: `http://${this.#host}:${boundPort}/mcp`,
      headers: {},
    };
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    return await this.#upstream.listTools();
  }

  async close(): Promise<void> {
    const httpServer: HttpServer | undefined = this.#httpServer;
    this.#httpServer = undefined;
    this.#adapterAttachment = undefined;

    const errors: string[] = [];
    if (httpServer) {
      try {
        await closeHttpServer(httpServer);
      } catch (error: unknown) {
        errors.push(errorMessage(error, "MCP proxy HTTP close failed."));
      }
    }
    try {
      await this.#upstream.close();
    } catch (error: unknown) {
      errors.push(errorMessage(error, "MCP proxy upstream close failed."));
    }
    if (errors.length > 0) {
      throw new Error(errors.join("; "));
    }
  }

  async #handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.url !== "/mcp") {
      writeJsonRpcError(response, 404, "mcp_proxy_not_found", "MCP proxy only serves /mcp.");
      return;
    }

    const parsedBody: unknown = request.method === "POST" ? await readJsonBody(request) : undefined;
    const server: Server = createProxySdkServer(this.#attachment.name, this.#upstream);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    } as unknown as ConstructorParameters<typeof StreamableHTTPServerTransport>[0]);

    await server.connect(transport as Parameters<Server["connect"]>[0]);
    response.on("close", () => {
      transport.close().catch(() => undefined);
      server.close().catch(() => undefined);
    });
    await transport.handleRequest(request, response, parsedBody);
  }
}

function createProxySdkServer(attachmentName: string, upstream: McpProxyUpstream): Server {
  const server = new Server(
    { name: `hcp-mcp-proxy-${attachmentName}`, version: "0.0.0" },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools: McpToolDescriptor[] = await upstream.listTools();
    return {
      tools: tools.map(toSdkTool),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const result: McpToolCallResult = await upstream.callTool(
      request.params.name,
      request.params.arguments ?? {},
    );
    return toSdkToolCallResult(result);
  });

  return server;
}

function toSdkTool(tool: McpToolDescriptor): Tool {
  return {
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    inputSchema: tool.input_schema as Tool["inputSchema"],
    ...(tool.output_schema ? { outputSchema: tool.output_schema as Tool["outputSchema"] } : {}),
  };
}

function toSdkToolCallResult(result: McpToolCallResult): CallToolResult {
  return {
    content: (result.content ?? []) as CallToolResult["content"],
    ...(result.structured_content ? { structuredContent: result.structured_content } : {}),
    ...(result.is_error ? { isError: true } : {}),
  };
}

async function listen(server: HttpServer, host: string, port: number): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      const address = server.address();
      if (typeof address === "object" && address !== null) {
        resolve(address.port);
        return;
      }
      reject(new Error("MCP proxy server did not expose a TCP port."));
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

async function closeHttpServer(server: HttpServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error?: Error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const rawBody: string = Buffer.concat(chunks).toString("utf8");
  return rawBody.length === 0 ? undefined : (JSON.parse(rawBody) as unknown);
}

function writeJsonRpcError(response: ServerResponse, statusCode: number, code: string, message: string): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  response.writeHead(statusCode, { "content-type": "application/json" });
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

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
