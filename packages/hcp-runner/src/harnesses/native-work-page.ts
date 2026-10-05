import {createHash} from "node:crypto";
import {z} from "zod";
import type {HcpConversationRequestPayload, HcpConversationResultPayload} from "@harness-control/protocol";
import type {NativeWorkState} from "../state/index.js";
import {HarnessAdapterError} from "./adapters/types.js";

export function nativeWorkPage(sessionId: string, state: NativeWorkState, ownerAvailable: boolean, live: ReadonlySet<string>,
  operation: Extract<HcpConversationRequestPayload["operation"], {action: "read"}>): Extract<NonNullable<HcpConversationResultPayload["work"]>, {action: "read"}> {
  const rows = Object.values(state.items).sort((a, b) => a.work_id < b.work_id ? -1 : a.work_id > b.work_id ? 1 : 0)
    .map(work => ({work, owner_status: ownerAvailable && live.has(work.work_id) ? "active" as const : "unavailable" as const}));
  const observationHash = createHash("sha256").update(JSON.stringify({sessionId, ownerAvailable, rows})).digest("hex");
  let offset = 0;
  if (operation.cursor) {
    let cursor: {hash: string; offset: number};
    try {cursor = z.object({hash: z.string(), offset: z.number().int().nonnegative()}).strict().parse(JSON.parse(Buffer.from(operation.cursor, "base64url").toString("utf8")));}
    catch {throw new HarnessAdapterError("native_work_cursor", "Invalid native-work cursor.");}
    if (cursor.hash !== observationHash || cursor.offset > rows.length)
      throw new HarnessAdapterError("native_work_changed", "Native work changed; restart pagination from a fresh read.");
    offset = cursor.offset;
  }
  const items: typeof rows = [];
  let bytes = 0;
  for (const row of rows.slice(offset, offset + (operation.limit ?? 32))) {
    const size = Buffer.byteLength(JSON.stringify(row));
    if (bytes + size > 192 * 1024) break;
    items.push(row); bytes += size;
  }
  if (offset < rows.length && !items.length) throw new HarnessAdapterError("native_work_record_limit", "A native-work record exceeds the bounded read size.");
  const next = offset + items.length;
  return {action: "read", owner_status: ownerAvailable ? "active" : "unavailable", observation_hash: observationHash, total_count: rows.length, items,
    ...(next < rows.length ? {next_cursor: Buffer.from(JSON.stringify({hash: observationHash, offset: next})).toString("base64url")} : {})};
}
