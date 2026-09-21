import { isDeepStrictEqual } from "node:util";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { z } from "zod";
import { HarnessAdapterError, type HarnessMcpContinuation } from "../types.js";
import type { CodexRpc } from "./codex-rpc.js";
import { nativeMcpNamespace } from "./native-mcp.js";

const threadSchema = z.object({thread: z.object({id: z.string(), path: z.string().min(1)})});
const recordSchema = z.object({type: z.string(), payload: z.record(z.string(), z.unknown())});

export async function recordMcpContinuation(
  rpc: Pick<CodexRpc, "request">, threadId: string, continuation: HarnessMcpContinuation,
): Promise<void> {
  if (continuation.outcome.kind !== "completed") return;
  const result = continuation.outcome.result;
  const callId = `reviewed_${continuation.request_id}`;
  const namespace = nativeMcpNamespace(continuation.attachment_name);
  const call = {type: "function_call", call_id: callId, namespace, name: continuation.tool_name,
    arguments: JSON.stringify(continuation.arguments)};
  const output = {type: "function_call_output", call_id: callId, output: JSON.stringify(continuation.outcome.result)};
  const {thread} = threadSchema.parse(await rpc.request("thread/read", {threadId, includeTurns: false}));
  if (thread.id !== threadId) throw historyError("Native history belongs to another thread.");
  // The projected item API omits injected response items; use the native-owned rollout.
  const file = await stat(thread.path);
  if (!file.isFile() || file.size > 128 * 1024 * 1024) throw historyError("Native history exceeds its recovery limit.");
  let sessionMatches = false;
  let callFound = false;
  let outputFound = false;
  let buffer = "";
  const consume = (line: string): void => {
    const record = recordSchema.parse(JSON.parse(line));
    if (record.type === "session_meta") {
      if (record.payload.id !== threadId) throw historyError("Native rollout has another session identity.");
      sessionMatches = true;
    }
    if (record.type !== "response_item" || record.payload.call_id !== callId) return;
    if (record.payload.type === "function_call") {
      if (record.payload.namespace !== namespace || record.payload.name !== continuation.tool_name ||
          typeof record.payload.arguments !== "string" ||
          !isDeepStrictEqual(JSON.parse(record.payload.arguments), continuation.arguments)) {
        throw historyError("Native call differs from its durable reviewed operation.");
      }
      callFound = true;
    } else if (record.payload.type === "function_call_output") {
      if (typeof record.payload.output !== "string" || !isDeepStrictEqual(JSON.parse(record.payload.output), result)) {
        throw historyError("Native result differs from its durable reviewed operation.");
      }
      outputFound = true;
    } else throw historyError("Native review identity was reused by another item.");
  };
  for await (const chunk of createReadStream(thread.path, {encoding: "utf8"})) {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      if (newline > 8 * 1024 * 1024) throw historyError("Native history record exceeds its recovery limit.");
      consume(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
    }
    if (buffer.length > 8 * 1024 * 1024) throw historyError("Native history record exceeds its recovery limit.");
  }
  if (buffer.trim()) throw historyError("Native history ended with an uncommitted record.");
  if (!sessionMatches || callFound !== outputFound) throw historyError("Native history has an incomplete reviewed operation.");
  if (!callFound) await rpc.request("thread/inject_items", {threadId, items: [call, output]});
}

function historyError(message: string): HarnessAdapterError {
  return new HarnessAdapterError("mcp_continuation_history_unavailable", message);
}
