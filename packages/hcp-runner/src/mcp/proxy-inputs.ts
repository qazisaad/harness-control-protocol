import {createHash, randomUUID} from "node:crypto";
import {z} from "zod";
import {mcpInputExpiresAt, mcpInputReplySchema, parseMcpPendingInput, type McpPendingInput, type McpInputReply} from "./input-required.js";
import type {McpToolCallArguments} from "./McpAttachmentClient.js";

type Pending = {scope: string; action: string; pending: McpPendingInput; expires: number; bytes: number};
const actionHash = (name: string, args: McpToolCallArguments) => createHash("sha256").update(JSON.stringify([name, args])).digest("hex");

/** One-use opaque continuations belong to a selected proxy/caller and exact tool action. */
export class McpProxyInputs {
  readonly #pending = new Map<string, Pending>();
  #bytes = 0;
  constructor(readonly now: () => number = Date.now) {}
  #remove(key: string): void {
    const value = this.#pending.get(key);
    if (value) {this.#bytes -= value.bytes; this.#pending.delete(key);}
  }
  #expire(): void {
    for (const [key, value] of this.#pending) if (value.expires <= this.now()) this.#remove(key);
  }
  retain(scope: string, name: string, args: McpToolCallArguments, input: McpPendingInput): string {
    this.#expire();
    const pending = parseMcpPendingInput(input);
    const bytes = Buffer.byteLength(JSON.stringify(pending));
    if (this.#pending.size >= 128 || this.#bytes + bytes > 8 * 1024 * 1024)
      throw new Error("MCP proxy input ownership reached its bounded capacity.");
    const expires = Date.parse(mcpInputExpiresAt(pending, new Date(this.now() + 5 * 60_000).toISOString()));
    if (expires <= this.now()) throw new Error("The upstream MCP input deadline expired.");
    const key = randomUUID();
    this.#pending.set(key, {scope, action: actionHash(name, args), pending, expires, bytes}); this.#bytes += bytes;
    return key;
  }
  consume(scope: string, name: string, args: McpToolCallArguments, state: unknown, responses: unknown): McpInputReply | undefined {
    this.#expire();
    if (state === undefined && responses === undefined) return undefined;
    if (typeof state !== "string") throw new Error("MCP input responses have no verified proxy continuation.");
    const value = this.#pending.get(state);
    if (!value || value.scope !== scope || value.action !== actionHash(name, args))
      throw new Error("MCP proxy continuation is expired, consumed or belongs to another caller/action.");
    const reply = mcpInputReplySchema.parse({pending: value.pending, responses: z.record(z.string(), z.json()).parse(responses ?? {})});
    this.#remove(state); // Fence a retry before dispatch, including unknown native outcomes.
    return reply;
  }
  closeScope(scope: string): void {
    for (const [key, value] of this.#pending) if (value.scope === scope) this.#remove(key);
  }
  close(): void {this.#pending.clear(); this.#bytes = 0;}
}
