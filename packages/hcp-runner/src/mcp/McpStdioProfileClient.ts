import { Client, type Tool } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Readable } from "node:stream";

import { toMcpToolDescriptor, toMcpToolCallResult, McpToolPolicyError, type McpToolCallArguments, type McpToolCallResult, type McpToolDescriptor } from "./McpAttachmentClient.js";
import { redactValue } from "./redaction.js";

export type McpStdioProfileClientOptions = {
  name: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  allowedTools?: string[];
  deniedTools?: string[];
};

type SdkToolCallResult = Awaited<ReturnType<Client["callTool"]>>;

export class McpStdioProfileClient {
  readonly #options: McpStdioProfileClientOptions;
  readonly #allowedTools: ReadonlySet<string> | undefined;
  readonly #deniedTools: ReadonlySet<string>;
  #client: Client | undefined;

  constructor(options: McpStdioProfileClientOptions) {
    this.#options = options;
    this.#allowedTools = options.allowedTools ? new Set(options.allowedTools) : undefined;
    this.#deniedTools = new Set(options.deniedTools ?? []);
  }

  async connect(): Promise<void> {
    if (this.#client) return;
    const client = new Client({ name: "hcp-runner", version: "0.0.0" }, {inputRequired: {autoFulfill: false}});
    const transport = new StdioClientTransport({
      command: this.#options.command,
      args: this.#options.args,
      cwd: this.#options.cwd,
      env: { ...getDefaultEnvironment(), ...this.#options.env },
      stderr: "pipe",
    });
    let stderr = "";
    if (transport.stderr instanceof Readable) {
      transport.stderr.on("data", (chunk: Buffer): void => {
        stderr = `${stderr}${chunk.toString("utf8")}`.slice(-16_384);
      });
    }
    try {
      await client.connect(transport);
    } catch (error: unknown) {
      const message: string = error instanceof Error ? error.message : "MCP stdio connection failed.";
      const redacted: unknown = redactValue(stderr.trim());
      throw new Error(`${message}${typeof redacted === "string" && redacted ? `: ${redacted}` : ""}`);
    }
    this.#client = client;
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    const client: Client = this.#requireClient();
    const result: Awaited<ReturnType<Client["listTools"]>> = await client.listTools();
    return result.tools.filter((tool: Tool): boolean => this.#isAllowed(tool.name)).map(toMcpToolDescriptor);
  }

  async callTool(name: string, arguments_: McpToolCallArguments = {}): Promise<McpToolCallResult> {
    if (!this.#isAllowed(name)) {
      throw new McpToolPolicyError(
        this.#options.name,
        name,
        `MCP tool "${name}" is not allowed for runner profile attachment "${this.#options.name}".`,
      );
    }
    const result: SdkToolCallResult = await this.#requireClient().callTool({ name, arguments: arguments_ });
    return toMcpToolCallResult(result);
  }

  async close(): Promise<void> {
    const client: Client | undefined = this.#client;
    this.#client = undefined;
    if (client) await client.close();
  }

  #isAllowed(toolName: string): boolean {
    if (this.#deniedTools.has(toolName)) return false;
    return this.#allowedTools ? this.#allowedTools.has(toolName) : true;
  }

  #requireClient(): Client {
    if (!this.#client) throw new Error(`Runner MCP profile '${this.#options.name}' is not connected.`);
    return this.#client;
  }
}
