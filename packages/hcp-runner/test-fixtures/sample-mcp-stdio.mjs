import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "hcp-test-stdio", version: "0.0.0" });
server.registerTool(
  "echo",
  { description: "Echo test input.", inputSchema: { text: z.string() } },
  ({ text }) => ({ content: [{ type: "text", text }], structuredContent: { text } }),
);
server.registerTool(
  "secret_admin",
  { description: "Denied test tool.", inputSchema: {} },
  () => ({ content: [{ type: "text", text: "secret" }] }),
);
await server.connect(new StdioServerTransport());
