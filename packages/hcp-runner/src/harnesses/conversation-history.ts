import {createHash} from "node:crypto";
import {z} from "zod";
import type {HcpConversationRequestPayload, HcpConversationResultPayload} from "@harness-control/protocol";
import {HarnessAdapterError} from "./adapters/types.js";
import {retainedContent, type ContentPublisher} from "./adapters/providers/content-projection.js";
export const conversationHistoryTurnSchema = z.object({id: z.string(), status: z.string(), items: z.array(z.record(z.string(), z.json()))});
export type HistoryTurn = z.infer<typeof conversationHistoryTurnSchema>;
export type Thread = {id: string; turns: HistoryTurn[]; revision?: string};
const sorted = (value: unknown): unknown => Array.isArray(value) ? value.map(sorted) : value && typeof value === "object"
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, sorted(child)])) : value;
export const hash = (turns: Thread["turns"]) => createHash("sha256").update(JSON.stringify(sorted(turns))).digest("hex");
export function publicHistory(thread: Thread, publish?: ContentPublisher, request?: Extract<HcpConversationRequestPayload["operation"], {kind: "read"}>): NonNullable<HcpConversationResultPayload["history"]> {
  const historyHash = thread.revision ?? hash(thread.turns);
  let offset = 0;
  if (request?.cursor) {
    let cursor: {hash: string; offset: number; thread: string};
    try {cursor = z.object({hash: z.string(), offset: z.number().int().nonnegative(), thread: z.string()}).strict().parse(JSON.parse(Buffer.from(request.cursor, "base64url").toString("utf8")));}
    catch {throw new HarnessAdapterError("native_history_cursor", "Invalid history cursor.");}
    if (cursor.hash !== historyHash || cursor.thread !== thread.id || cursor.offset > thread.turns.length)
      throw new HarnessAdapterError("native_history_changed", "History changed; restart pagination from a fresh read.");
    offset = cursor.offset;
  }
  let size = 0, truncated = false;
  const turns: Thread["turns"] = [];
  const end = thread.turns.length - offset;
  for (const turn of thread.turns.slice(Math.max(0, end - (request?.limit ?? 100)), end).reverse()) {
    const items = turn.items.map(item => Object.fromEntries(Object.entries(item).filter(([key]) =>
      ["id", "type", "text", "command", "cwd", "status", "aggregatedOutput", "exitCode", "changes", "content", "role", "tool_name", "output", "arguments", "error"].includes(key))
      .map(([key, value]) => {
        const encoded = JSON.stringify(value);
        if (Buffer.byteLength(encoded) <= 32 * 1024) return [key, value];
        truncated = true; return [key, z.json().parse(retainedContent(value, publish))];
      })));
    const entry = {...turn, items};
    size += Buffer.byteLength(JSON.stringify(entry));
    if (size > 192 * 1024) {truncated = true; break;}
    turns.unshift(entry);
  }
  const consumed = offset + turns.length;
  if (consumed < thread.turns.length && !turns.length) throw new HarnessAdapterError("native_history_item_limit", "A history turn exceeds the bounded page size.");
  return {history_hash: historyHash, turn_count: thread.turns.length, truncated: truncated || consumed < thread.turns.length, turns,
    ...(consumed < thread.turns.length ? {next_cursor: Buffer.from(JSON.stringify({hash: historyHash, offset: consumed, thread: thread.id})).toString("base64url")} : {})};
}

