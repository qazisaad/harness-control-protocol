import {randomBytes, timingSafeEqual} from "node:crypto";
import {createServer, type IncomingMessage, type ServerResponse} from "node:http";
import {openCodeOwnedToolInvocationSchema, type OpenCodeOwnedToolInvocation} from "./opencode-owned-tools.js";
import {HarnessAdapterError} from "../types.js";

const MAX_BYTES = 8 * 1024 * 1024;
/** Private loopback transport. Proofs never appear in model arguments or errors. */
export async function openCodeOwnedToolServer(): Promise<{
  endpoint: string; proof: string;
  bind(handler: (input: OpenCodeOwnedToolInvocation, signal: AbortSignal) => Promise<unknown>): void;
  close(): Promise<void>;
}> {
  const proof = randomBytes(32).toString("base64url"), expected = Buffer.from(proof);
  const active = new Set<AbortController>();
  let closed = false, bound = false;
  let closing: Promise<void> | undefined;
  let handler: ((input: OpenCodeOwnedToolInvocation, signal: AbortSignal) => Promise<unknown>) | undefined;
  const server = createServer((request, response) => {void receive(request, response);});
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  const deny = (response: ServerResponse, status: number, code?: string) => {
    if (!response.destroyed && !response.writableEnded) {
      response.writeHead(status, {"content-type": "application/json", "cache-control": "no-store"});
      response.end(JSON.stringify({error: "Owned native invocation unavailable.", ...(code ? {code} : {})}));
    }
  };
  async function receive(request: IncomingMessage, response: ServerResponse) {
    const supplied = request.headers["x-hcp-native-tool-proof"];
    if (closed || !handler || request.method !== "POST" || request.url !== "/invoke" ||
        request.headers["content-type"] !== "application/json" || typeof supplied !== "string" ||
        Buffer.byteLength(supplied) !== expected.length || !timingSafeEqual(Buffer.from(supplied), expected)) {
      request.resume(); deny(response, 403); return;
    }
    if (active.size >= 128) {request.resume(); deny(response, 429); return;}
    const lifetime = new AbortController(); active.add(lifetime);
    const abort = () => {if (!response.writableEnded) lifetime.abort();};
    response.once("close", abort); request.once("aborted", abort);
    try {
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > MAX_BYTES) {lifetime.abort(); deny(response, 413); request.destroy(); return;}
        chunks.push(buffer);
      }
      lifetime.signal.throwIfAborted();
      const invocation = openCodeOwnedToolInvocationSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const result = await handler(invocation, lifetime.signal);
      lifetime.signal.throwIfAborted();
      const encoded = JSON.stringify(result);
      if (!encoded || Buffer.byteLength(encoded) > MAX_BYTES) throw new Error("Response limit");
      response.writeHead(200, {"content-type": "application/json", "cache-control": "no-store"}); response.end(encoded);
    } catch (failure) {deny(response, 400, failure instanceof HarnessAdapterError ? failure.code : "native_tool_invocation_unconfirmed");}
    finally {lifetime.abort();active.delete(lifetime);response.removeListener("close", abort);request.removeListener("aborted", abort);}
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject); server.listen(0, "127.0.0.1", () => {server.removeListener("error", reject);resolve();});
  });
  const address = server.address();
  if (!address || typeof address === "string") {server.close();throw new HarnessAdapterError("native_tool_bridge_binding", "The private native endpoint could not bind.");}
  return {endpoint: `http://127.0.0.1:${address.port}/invoke`, proof,
    bind(next) {
      if (bound || closed) throw new HarnessAdapterError("native_tool_bridge_binding", "The native invocation owner cannot be replaced.");
      bound = true; handler = next;
    },
    async close() {
      if (closing) return closing; closed = true; handler = undefined;
      for (const lifetime of active) lifetime.abort();
      server.closeAllConnections();
      closing = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await closing;
    }};
}
