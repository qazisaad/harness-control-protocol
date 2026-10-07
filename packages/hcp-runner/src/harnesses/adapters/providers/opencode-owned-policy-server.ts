import {randomBytes, timingSafeEqual} from "node:crypto";
import {createServer, type IncomingMessage, type ServerResponse} from "node:http";
import {openCodePolicyPromptSchema, type OpenCodePolicyPrompt} from "./opencode-child-policy.js";
import {HarnessAdapterError} from "../types.js";

const MAX_BYTES = 64 * 1024;
/** The prompt hook transports only physical scope; its private proof never enters model input. */
export async function openCodeOwnedPolicyServer(): Promise<{
  endpoint: string; proof: string;
  bind(handler: (input: OpenCodePolicyPrompt, signal: AbortSignal) => Promise<{confirmed: true; native_reference: string; native_execution_reference: string}>): void;
  close(): Promise<void>;
}> {
  const proof = randomBytes(32).toString("base64url"), expected = Buffer.from(proof);
  const active = new Set<AbortController>();
  let closed = false, bound = false, closing: Promise<void> | undefined;
  let handler: Parameters<Awaited<ReturnType<typeof openCodeOwnedPolicyServer>>["bind"]>[0] | undefined;
  const server = createServer((request, response) => {void receive(request, response);});
  server.requestTimeout = 15_000;server.headersTimeout = 10_000;
  const deny = (response: ServerResponse, status: number) => {
    if (!response.destroyed && !response.writableEnded) {
      response.writeHead(status, {"content-type": "application/json", "cache-control": "no-store"});
      response.end(JSON.stringify({error: "Native prompt permission ownership unavailable."}));
    }
  };
  async function receive(request: IncomingMessage, response: ServerResponse) {
    const supplied = request.headers["x-hcp-native-policy-proof"];
    if (closed || !handler || request.method !== "POST" || request.url !== "/policy" || request.headers["content-type"] !== "application/json"
      || typeof supplied !== "string" || Buffer.byteLength(supplied) !== expected.length || !timingSafeEqual(Buffer.from(supplied), expected)) {
      request.resume();deny(response, 403);return;
    }
    if (active.size >= 128) {request.resume();deny(response, 429);return;}
    const lifetime = new AbortController();active.add(lifetime);
    const abort = () => {if (!response.writableEnded) lifetime.abort();};
    response.once("close", abort);request.once("aborted", abort);
    try {
      const chunks: Buffer[] = [];let bytes = 0;
      for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);bytes += buffer.length;
        if (bytes > MAX_BYTES) {lifetime.abort();deny(response, 413);request.destroy();return;}
        chunks.push(buffer);
      }
      lifetime.signal.throwIfAborted();
      const input = openCodePolicyPromptSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const result = await handler(input, AbortSignal.any([lifetime.signal, AbortSignal.timeout(8_000)]));
      lifetime.signal.throwIfAborted();
      if (result.confirmed !== true || result.native_reference !== input.session_id || result.native_execution_reference !== input.message_id) throw new Error("Scope drift");
      response.writeHead(200, {"content-type": "application/json", "cache-control": "no-store"});response.end(JSON.stringify(result));
    } catch {deny(response, 400);}
    finally {lifetime.abort();active.delete(lifetime);response.removeListener("close", abort);request.removeListener("aborted", abort);}
  }
  await new Promise<void>((resolve, reject) => {server.once("error", reject);server.listen(0, "127.0.0.1", () => {server.removeListener("error", reject);resolve();});});
  const address = server.address();
  if (!address || typeof address === "string") {server.close();throw new HarnessAdapterError("native_policy_bridge_binding", "The owned native policy endpoint could not bind.");}
  return {endpoint: `http://127.0.0.1:${address.port}/policy`, proof,
    bind(next) {if (bound || closed) throw new HarnessAdapterError("native_policy_bridge_binding", "The native prompt policy owner cannot be replaced.");bound = true;handler = next;},
    async close() {if (closing) return closing;closed = true;handler = undefined;for (const lifetime of active) lifetime.abort();server.closeAllConnections();
      closing = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));await closing;}};
}
