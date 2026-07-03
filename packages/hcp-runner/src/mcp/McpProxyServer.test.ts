import assert from "node:assert/strict";
import { createServer, type Server as HttpServer } from "node:http";
import { describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerAttachment } from "@harness-control/protocol";

import { McpProxyServer, type McpProxyUpstream } from "./McpProxyServer.js";
import type { McpToolCallArguments, McpToolCallResult, McpToolDescriptor } from "./McpAttachmentClient.js";

describe("McpProxyServer", () => {
  it("serves an MCP endpoint that forwards tool listing and calls to the upstream attachment client", async () => {
    const calls: Array<{ name: string; arguments_: McpToolCallArguments }> = [];
    let connected = false;
    let closed = false;
    const upstream: McpProxyUpstream = {
      async connect(): Promise<void> {
        connected = true;
      },
      async listTools(): Promise<McpToolDescriptor[]> {
        return [
          {
            name: "echo",
            description: "Echoes text.",
            input_schema: {
              type: "object",
              properties: {
                text: { type: "string" },
              },
              required: ["text"],
            },
          },
        ];
      },
      async callTool(name: string, arguments_: McpToolCallArguments): Promise<McpToolCallResult> {
        calls.push({ name, arguments_ });
        return {
          content: [{ type: "text", text: String(arguments_["text"]) }],
          structured_content: { text: arguments_["text"] },
          is_error: false,
        };
      },
      async close(): Promise<void> {
        closed = true;
      },
    };
    const proxy = new McpProxyServer({ attachment: attachment(), upstream });

    await proxy.connect();
    assert.equal(connected, true);
    assert.match(proxy.adapterAttachment?.url ?? "", /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    assert.deepEqual(proxy.adapterAttachment?.headers, {});

    const client = new Client({ name: "proxy-test", version: "0.0.0" });
    try {
      const transport = new StreamableHTTPClientTransport(new URL(requireAdapterUrl(proxy)));
      await client.connect(transport as Parameters<Client["connect"]>[0]);

      const listedTools: ListToolsResult = await client.listTools();
      assert.deepEqual(
        listedTools.tools.map((tool) => tool.name),
        ["echo"],
      );

      const result = (await client.callTool({ name: "echo", arguments: { text: "hello" } })) as {
        content: unknown;
        structuredContent?: unknown;
      };
      assert.deepEqual(result.content, [{ type: "text", text: "hello" }]);
      assert.deepEqual(result.structuredContent, { text: "hello" });
      assert.deepEqual(calls, [{ name: "echo", arguments_: { text: "hello" } }]);
    } finally {
      await client.close();
      await proxy.close();
    }

    assert.equal(closed, true);
  });

  it("closes the upstream client when the proxy listener fails to start", async () => {
    const occupiedServer: HttpServer = createServer();
    const occupiedPort: number = await listenTestServer(occupiedServer);
    let closed = false;
    const upstream: McpProxyUpstream = {
      async connect(): Promise<void> {
        return;
      },
      async listTools(): Promise<McpToolDescriptor[]> {
        return [];
      },
      async callTool(): Promise<McpToolCallResult> {
        return { content: [], is_error: false };
      },
      async close(): Promise<void> {
        closed = true;
      },
    };
    const proxy = new McpProxyServer({ attachment: attachment(), upstream, port: occupiedPort });

    try {
      await assert.rejects(() => proxy.connect(), /EADDRINUSE/);
      assert.equal(closed, true);
    } finally {
      await closeTestServer(occupiedServer);
    }
  });
});

function requireAdapterUrl(proxy: McpProxyServer): string {
  const adapterAttachment: McpServerAttachment | undefined = proxy.adapterAttachment;
  if (!adapterAttachment) {
    throw new Error("MCP proxy did not expose an adapter attachment.");
  }
  return adapterAttachment.url;
}

function attachment(): McpServerAttachment {
  return {
    name: "tools",
    transport: "streamable_http",
    url: "https://example.com/mcp",
    headers: { Authorization: "Bearer platform-token" },
    lease_id: "mcp_lease_test",
    proof_of_possession: {
      scheme: "runner_signed_request",
      key_id: "proof_key_test",
      required_headers: ["x-hcp-proof-signature", "x-hcp-proof-nonce"],
    },
  };
}

async function listenTestServer(server: HttpServer): Promise<number> {
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
      reject(new Error("Test server did not expose a TCP port."));
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
}

async function closeTestServer(server: HttpServer): Promise<void> {
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
