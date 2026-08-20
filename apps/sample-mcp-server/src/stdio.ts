#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createSampleMcpServer } from "./index.js";

export async function startSampleStdioMcpServer(): Promise<void> {
  const server = createSampleMcpServer();
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startSampleStdioMcpServer();
}
