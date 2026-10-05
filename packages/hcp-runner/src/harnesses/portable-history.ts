import {createHash} from "node:crypto";
import {harnessHistoryValueSchema, harnessPortableHistoryItemSchema, type HarnessHistoryValue,
  harnessHistoryFileChangesSchema, type HarnessPortableHistoryItem} from "@harness-control/protocol";
import type {ContentPublisher} from "./adapters/providers/content-projection.js";

type NativeItem = Record<string, unknown>;
const json = (value: unknown) => JSON.parse(JSON.stringify(value ?? null)) as unknown;
function value(input: unknown, publish?: ContentPublisher): HarnessHistoryValue {
  if (input === undefined) return {storage: "unavailable", reason: "unsupported_native_shape"};
  const encoded = JSON.stringify(input ?? null);
  if (Buffer.byteLength(encoded) <= 32 * 1024) return harnessHistoryValueSchema.parse({storage: "inline", value: json(input)});
  return publish ? {storage: "reference", content_ref: publish(json(input)), preview: [...encoded].slice(0, 4096).join("")}
    : {storage: "unavailable", reason: "not_retained"};
}
function status(input: unknown): HarnessPortableHistoryItem["status"] {
  switch (input) {
    case "pending": return "pending";
    case "running": case "inProgress": case "in_progress": return "running";
    case "waiting": return "waiting";
    case "completed": case "success": return "completed";
    case "failed": case "error": return "failed";
    case "cancelled": case "interrupted": case "stopped": return "cancelled";
    default: return "unknown";
  }
}
const resultId = (id: string) => id.length <= 505 ? `result:${id}` : `result:${createHash("sha256").update(id).digest("hex")}`;

/** Native translation stays in the runner. Unknown items become optional display extensions. */
export function portableHistoryItem(item: NativeItem, namespace: string, fallbackId: string, publish?: ContentPublisher): HarnessPortableHistoryItem[] {
  const id = typeof item.id === "string" && item.id.length ? item.id : fallbackId;
  const common = {id, status: status(item.status)};
  let rows: unknown[];
  switch (item.type) {
    case "text": case "agentMessage":
      rows = [{...common, type: "message", role: item.type === "agentMessage" ? "assistant" : ["user", "assistant", "system", "developer"].includes(String(item.role)) ? item.role : "unknown", body: value(item.text, publish)}]; break;
    case "userMessage": {
      const content = Array.isArray(item.content) ? item.content : [];
      const texts = content.filter(block => block && typeof block === "object" && block.type === "text").map(block => block.text);
      rows = [{...common, type: "message", role: "user", body: value(texts.join("\n"), publish)}];
      for (const [index, block] of content.entries()) if (!block || typeof block !== "object" || block.type !== "text")
        rows.push({...common, id: resultId(`${id}:attachment:${index}`), type: "extension", namespace: "hcp.attachment", name: "retained_input", body: value(block, publish)});
      break;
    }
    case "reasoning":
      rows = [{...common, type: "reasoning", body: value(item.text ?? item.summary ?? item.content, publish)}]; break;
    case "tool_call": {
      rows = [{...common, type: "tool_call", tool_name: item.tool_name, arguments: value(item.arguments, publish)}];
      if (item.output !== undefined || item.error !== undefined) rows.push({...common, id: resultId(id), type: "tool_result", call_id: id, result: value(item.output ?? item.error, publish)});
      break;
    }
    case "tool_result": rows = [{...common, id: resultId(id), type: "tool_result", call_id: id, result: value(item.content, publish)}]; break;
    case "commandExecution": rows = [{...common, type: "command", command: value(item.command, publish),
      ...(typeof item.cwd === "string" ? {cwd: item.cwd} : {}), ...(typeof item.exitCode === "number" ? {exit_code: item.exitCode} : {}),
      ...(item.aggregatedOutput != null ? {output: value(item.aggregatedOutput, publish)} : {})}]; break;
    case "fileChange": {
      const changes = Array.isArray(item.changes) ? item.changes.map(change => {
        const kind = change && typeof change === "object" ? change.kind : undefined;
        const type = kind && typeof kind === "object" ? kind.type : undefined;
        const destination = kind && typeof kind === "object" ? kind.move_path : undefined;
        return {path: typeof destination === "string" ? destination : change?.path,
          change_type: typeof destination === "string" ? "renamed" : type === "add" ? "added" : type === "delete" ? "deleted" : type === "update" ? "modified" : "unknown",
          ...(typeof destination === "string" ? {previous_path: change.path} : {}), ...(typeof change?.diff === "string" ? {diff: change.diff} : {})};
      }) : undefined;
      const parsed = harnessHistoryFileChangesSchema.safeParse(changes);
      rows = parsed.success ? [{...common, type: "file_change", changes: value(parsed.data, publish)}]
        : [{...common, type: "extension", namespace, name: "fileChange", body: value(item, publish)}];
      break;
    }
    case "plan": rows = [{...common, type: "plan", body: value(item.text ?? item.plan, publish)}]; break;
    case "contextCompaction": rows = [{...common, type: "context_marker", body: value(item.text ?? item.summary, publish)}]; break;
    default: rows = [{...common, type: "extension", namespace, name: typeof item.type === "string" ? item.type : "unknown", body: value(item.content ?? item, publish)}];
  }
  return rows.map(row => {
    const result = harnessPortableHistoryItemSchema.safeParse(row);
    if (result.success) return result.data;
    return harnessPortableHistoryItemSchema.parse({...common, id: id.length > 512 ? createHash("sha256").update(id).digest("hex") : id,
      type: "extension", namespace, name: typeof item.type === "string" ? item.type.slice(0, 512) || "unknown" : "unknown", body: value(item, publish)});
  });
}

export function portableHistoryItemIsComplete(item: HarnessPortableHistoryItem): boolean {
  return ["body", "arguments", "result", "command", "output", "changes"].every(key => {
    const candidate = (item as unknown as Record<string, unknown>)[key];
    return !candidate || typeof candidate !== "object" || !("storage" in candidate) || candidate.storage !== "unavailable";
  });
}
