import { createHash } from "node:crypto";
import { z } from "zod";
import type { HcpConversationRequestPayload, HcpConversationResultPayload } from "@harness-control/protocol";
import { hcpConversationResultPayloadSchema } from "@harness-control/protocol";
import type { ProviderInstanceConfig } from "../config/index.js";
import type { NativeConversation } from "../state/index.js";
import { CodexRpc } from "./adapters/providers/codex-rpc.js";
import { HarnessAdapterError } from "./adapters/types.js";

const threadSchema = z.object({thread: z.object({id: z.string(), historyMode: z.enum(["legacy", "paginated"]).optional(), turns: z.array(z.object({id: z.string(), status: z.string(), items: z.array(z.record(z.string(), z.json()))}))})});
type Thread = z.infer<typeof threadSchema>["thread"];
const sorted = (value: unknown): unknown => Array.isArray(value) ? value.map(sorted) : value && typeof value === "object"
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, sorted(child)])) : value;
const hash = (turns: Thread["turns"]) => createHash("sha256").update(JSON.stringify(sorted(turns))).digest("hex");
function publicHistory(thread: Thread): NonNullable<HcpConversationResultPayload["history"]> {
  let size = 0, truncated = thread.turns.length > 100;
  const turns: Thread["turns"] = [];
  for (const turn of thread.turns.slice(-100).reverse()) {
    const items = turn.items.map(item => Object.fromEntries(Object.entries(item).filter(([key]) =>
      ["id", "type", "text", "command", "cwd", "status", "aggregatedOutput", "exitCode", "changes"].includes(key))
      .map(([key, value]) => {
        const encoded = JSON.stringify(value);
        if (Buffer.byteLength(encoded) <= 32 * 1024) return [key, value];
        truncated = true; return [key, {truncated: true, summary: [...encoded].slice(0, 4096).join("")}];
      })));
    const entry = {...turn, items};
    size += Buffer.byteLength(JSON.stringify(entry));
    if (size > 192 * 1024) {truncated = true; break;}
    turns.unshift(entry);
  }
  return {history_hash: hash(thread.turns), turn_count: thread.turns.length, truncated, turns};
}

export async function nativeConversationOperation(commandId: string, request: HcpConversationRequestPayload,
  conversation: NativeConversation, provider: ProviderInstanceConfig, save: (conversation: NativeConversation) => void): Promise<HcpConversationResultPayload> {
  const rpc = new CodexRpc(provider.executable_path ?? "codex", conversation.cwd, {...process.env, ...provider.env,
    ...(provider.home ? {CODEX_HOME: provider.home} : {})});
  const timer = setTimeout(() => {void rpc.process.stop();}, 30_000);
  try {
    await rpc.request("initialize", {clientInfo: {name: "hcp-conversation", version: "0.4.10"}, capabilities: {experimentalApi: true}});
    rpc.notify("initialized");
    let thread = threadSchema.parse(await rpc.request("thread/read", {threadId: conversation.native_thread_id, includeTurns: true})).thread;
    if (thread.id !== conversation.native_thread_id) throw new HarnessAdapterError("native_history_binding", "Native history belongs to another conversation.");
    if (request.operation.kind === "rollback") {
      const currentHash = hash(thread.turns), previous = conversation.rollback;
      if (previous?.command_id === commandId) {
        if (currentHash !== previous.target_hash) throw new HarnessAdapterError("native_rollback_unknown", "The original rollback has no matching terminal evidence; it will not be repeated.");
      } else {
        if (previous?.phase === "pending") throw new HarnessAdapterError("native_rollback_unknown", "A prior rollback must be reconciled before another mutation.");
        if (currentHash !== request.operation.expected_history_hash || request.operation.num_turns > thread.turns.length)
          throw new HarnessAdapterError("native_history_changed", "Native history changed; read it again before requesting rollback.");
        // Rollback operates on an in-memory thread. Load it without starting a turn or inherited tools.
        const inherited = z.object({config: z.record(z.string(), z.unknown())}).parse(await rpc.request("config/read", {cwd: conversation.cwd, includeLayers: false})).config;
        const disabled = (value: unknown) => Object.fromEntries(Object.keys(z.record(z.string(), z.unknown()).parse(value ?? {})).map(name => [name, {enabled: false}]));
        const loaded = threadSchema.parse(await rpc.request("thread/resume", {threadId: conversation.native_thread_id, cwd: conversation.cwd,
          approvalPolicy: "never", sandbox: "read-only", config: {mcp_servers: disabled(inherited.mcp_servers), plugins: disabled(inherited.plugins), "features.apps": false, "features.multi_agent": false}})).thread;
        if (loaded.id !== conversation.native_thread_id || hash(loaded.turns) !== currentHash)
          throw new HarnessAdapterError("native_history_changed", "Native history changed while loading; read it again.");
        const intent = {command_id: commandId, source_hash: currentHash, target_hash: hash(thread.turns.slice(0, -request.operation.num_turns)), phase: "pending" as const};
        save({...conversation, rollback: intent});
        if (thread.historyMode === "paginated") {
          const reverted = threadSchema.parse(await rpc.request("thread/revert", {threadId: conversation.native_thread_id,
            beforeTurnId: thread.turns[thread.turns.length - request.operation.num_turns]!.id})).thread;
          if (reverted.id !== conversation.native_thread_id) throw new HarnessAdapterError("native_history_binding", "Native revert returned another thread.");
          thread = threadSchema.parse(await rpc.request("thread/read", {threadId: conversation.native_thread_id, includeTurns: true})).thread;
        } else {
          thread = threadSchema.parse(await rpc.request("thread/rollback", {threadId: conversation.native_thread_id, numTurns: request.operation.num_turns})).thread;
        }
        if (thread.id !== conversation.native_thread_id || hash(thread.turns) !== intent.target_hash)
          throw new HarnessAdapterError("native_rollback_unknown", "Codex did not confirm the expected conversation-only rollback.");
        conversation = {...conversation, rollback: intent};
      }
      save({...conversation, rollback: {...conversation.rollback!, phase: "completed"}});
    }
    return hcpConversationResultPayloadSchema.parse({command_id: commandId, session_id: request.session_id,
      operation: request.operation.kind, filesystem_undo: false, history: publicHistory(thread)});
  } finally {clearTimeout(timer); await rpc.process.stop();}
}
