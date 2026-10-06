import {hash, publicHistory} from "./conversation-history.js";
import { z } from "zod";
import type { HcpConversationRequestPayload, HcpConversationResultPayload } from "@harness-control/protocol";
import { hcpConversationResultPayloadSchema } from "@harness-control/protocol";
import type { ProviderInstanceConfig } from "../config/index.js";
import type { NativeConversation } from "../state/index.js";
import { CodexRpc, CodexRpcRequestError } from "./adapters/providers/codex-rpc.js";
import { HarnessAdapterError } from "./adapters/types.js";
import {type ContentPublisher} from "./adapters/providers/content-projection.js";

const threadSchema = z.object({thread: z.object({id: z.string(), historyMode: z.enum(["legacy", "paginated"]).optional(), turns: z.array(z.object({id: z.string(), status: z.string(), items: z.array(z.record(z.string(), z.json()))}))})});
type Thread = z.infer<typeof threadSchema>["thread"];
async function readThread(rpc: Pick<CodexRpc, "request">, threadId: string, owned = false): Promise<Thread> {
  const metadata = threadSchema.parse(await rpc.request("thread/read", {threadId, includeTurns: false})).thread;
  if (metadata.id !== threadId) throw new HarnessAdapterError("native_history_binding", "Native history belongs to another conversation.");
  if (metadata.historyMode !== "paginated" || !owned) {
    try {
    const legacy = threadSchema.parse(await rpc.request("thread/read", {threadId, includeTurns: true})).thread;
    if (legacy.id !== threadId) throw new HarnessAdapterError("native_history_binding", "Native history belongs to another conversation.");
    return legacy;
    } catch (failure) {
      // Loaded paginated threads require their owner's turns endpoint. Unloaded
      // native rollouts can be read without resuming or changing execution policy.
      if (metadata.historyMode !== "paginated" || !(failure instanceof CodexRpcRequestError) || failure.nativeCode !== -32601) throw failure;
    }
  }
  const turns: Thread["turns"] = [];
  const visited = new Set<string>();
  let cursor: string | undefined, size = 0;
  do {
    let result: unknown;
    try {result = await rpc.request("thread/turns/list", {threadId, cursor: cursor ?? null, limit: 100, sortDirection: "desc", itemsView: "full"});}
    catch (failure) {
      // Pinned native 0.160.0 explicitly confirms that no first user message
      // exists. A generic not-found/unloaded failure cannot establish emptiness.
      if (owned && cursor === undefined && turns.length === 0 && failure instanceof CodexRpcRequestError &&
        failure.nativeCode === -32600 && failure.message ===
          `thread ${threadId} is not materialized yet; thread/turns/list is unavailable before first user message`)
        return {...metadata, turns: []};
      throw failure;
    }
    const page = z.object({data: z.array(threadSchema.shape.thread.shape.turns.element), nextCursor: z.string().nullish()}).parse(result);
    size += Buffer.byteLength(JSON.stringify(page.data));
    if (size > 8 * 1024 * 1024 || turns.length + page.data.length > 10_000)
      throw new HarnessAdapterError("native_history_limit", "Native history exceeds the bounded snapshot limit.");
    turns.push(...page.data);
    cursor = page.nextCursor ?? undefined;
    if (cursor && visited.has(cursor)) throw new HarnessAdapterError("native_history_cursor", "The native provider repeated a history cursor.");
    if (cursor) visited.add(cursor);
  } while (cursor);
  return {...metadata, turns: turns.reverse()};
}

/** The caller owns the deadline and exclusive transport; this never starts, resumes or mutates a thread. */
export async function readCodexOwnedHistory(rpc: CodexRpc, nativeReference: string, signal: AbortSignal,
  page: {cursor?: string; limit?: number}, publish?: ContentPublisher) {
  const boundedRpc = {request: (method: string, params: unknown) => rpc.request(method, params, {signal})};
  const thread = await readThread(boundedRpc, nativeReference, true);
  if (hash((await readThread(boundedRpc, nativeReference, true)).turns) !== hash(thread.turns))
    throw new HarnessAdapterError("native_history_changed", "Native history changed during the snapshot; read it again.");
  signal.throwIfAborted();
  return publicHistory(thread, publish, {kind: "read", ...page}, "codex");
}

export async function nativeConversationOperation(commandId: string, request: HcpConversationRequestPayload,
  conversation: NativeConversation, provider: ProviderInstanceConfig, save: (conversation: NativeConversation) => void,
  beginMutation?: () => void, publish?: ContentPublisher, ownedRpc?: CodexRpc): Promise<HcpConversationResultPayload> {
  if (ownedRpc && request.operation.kind !== "read") throw new HarnessAdapterError("native_history_read_only", "A live native owner can only lend its transport for history reads.");
  const rpc = ownedRpc ?? new CodexRpc(provider.executable_path ?? "codex", conversation.cwd, {...process.env, ...provider.env,
    ...(provider.home ? {CODEX_HOME: provider.home} : {})});
  const deadline = new AbortController();
  const timer = setTimeout(() => {
    deadline.abort(new HarnessAdapterError("native_history_timeout", "Native conversation operation exceeded its deadline."));
    if (!ownedRpc) void rpc.process.stop();
  }, 30_000);
  const boundedRpc = {request: (method: string, params: unknown) => rpc.request(method, params, {signal: deadline.signal})};
  try {
    if (!ownedRpc) {
    await boundedRpc.request("initialize", {clientInfo: {name: "hcp-conversation", version: "0.4.10"}, capabilities: {experimentalApi: true}});
    rpc.notify("initialized");
    }
    let thread = await readThread(boundedRpc, conversation.native_thread_id, !!ownedRpc);
    if (thread.id !== conversation.native_thread_id) throw new HarnessAdapterError("native_history_binding", "Native history belongs to another conversation.");
    if (request.operation.kind === "read" && hash((await readThread(boundedRpc, thread.id, !!ownedRpc)).turns) !== hash(thread.turns))
      throw new HarnessAdapterError("native_history_changed", "Native history changed during the snapshot; read it again.");
    if (request.operation.kind === "inject") {
      const operation = request.operation;
      if (hash(thread.turns) !== operation.expected_history_hash)
        throw new HarnessAdapterError("native_history_changed", "Read current history before injecting context.");
      const inherited = z.object({config: z.record(z.string(), z.unknown())}).parse(await boundedRpc.request("config/read", {cwd: conversation.cwd, includeLayers: false})).config;
      const disabled = (value: unknown) => Object.fromEntries(Object.keys(z.record(z.string(), z.unknown()).parse(value ?? {})).map(name => [name, {enabled: false}]));
      const loaded = threadSchema.parse(await boundedRpc.request("thread/resume", {threadId: thread.id, cwd: conversation.cwd,
        approvalPolicy: "never", sandbox: "read-only", config: {mcp_servers: disabled(inherited.mcp_servers), plugins: disabled(inherited.plugins),
          "features.apps": false, "features.multi_agent": false}})).thread;
      if (loaded.id !== thread.id || hash((loaded.historyMode === "paginated" ? await readThread(boundedRpc, loaded.id) : loaded).turns) !== operation.expected_history_hash)
        throw new HarnessAdapterError("native_history_changed", "Native history changed while loading injection context.");
      if (!beginMutation) throw new HarnessAdapterError("native_mutation_fence_missing", "Context injection requires the runner's durable dispatch fence.");
      beginMutation();
      try {
        z.object({}).strict().parse(await boundedRpc.request("thread/inject_items", {threadId: thread.id, items: operation.messages.map(message => ({type: "message",
          role: message.role, content: [{type: message.role === "user" ? "input_text" : "output_text", text: message.content}]}))}));
      } catch (failure) {
        if (failure instanceof CodexRpcRequestError && failure.nativeCode === -32601)
          return {command_id: commandId, session_id: request.session_id, operation: "inject", filesystem_undo: false,
            injection: {outcome: "unsupported", reason: "native_method_unavailable"}};
        throw failure;
      }
      return {command_id: commandId, session_id: request.session_id, operation: "inject", filesystem_undo: false,
        injection: {outcome: "applied", message_count: operation.messages.length}};
    }
    if (request.operation.kind === "fork") {
      const operation = request.operation;
      if (hash(thread.turns) !== operation.expected_history_hash ||
          (operation.last_turn_id && !thread.turns.some(turn => turn.id === operation.last_turn_id)))
        throw new HarnessAdapterError("native_history_changed", "Read the current source history before forking.");
      const inherited = z.object({config: z.record(z.string(), z.unknown())}).parse(await boundedRpc.request("config/read", {cwd: conversation.cwd, includeLayers: false})).config;
      const disabled = (value: unknown) => Object.fromEntries(Object.keys(z.record(z.string(), z.unknown()).parse(value ?? {})).map(name => [name, {enabled: false}]));
      if (!beginMutation) throw new HarnessAdapterError("native_mutation_fence_missing", "A native fork requires the runner's durable mutation fence.");
      beginMutation();
      const forked = threadSchema.parse(await boundedRpc.request("thread/fork", {threadId: thread.id,
        ...(request.operation.last_turn_id ? {lastTurnId: request.operation.last_turn_id} : {}), cwd: conversation.cwd,
        approvalPolicy: "never", sandbox: "read-only", config: {mcp_servers: disabled(inherited.mcp_servers), plugins: disabled(inherited.plugins),
          "features.apps": false, "features.multi_agent": false}})).thread;
      if (forked.id === thread.id) throw new HarnessAdapterError("native_history_binding", "Fork returned its source identity.");
      const retained = thread.turns.slice(0, operation.last_turn_id ? thread.turns.findIndex(turn => turn.id === operation.last_turn_id) + 1 : thread.turns.length);
      const verified = forked.historyMode === "paginated" ? await readThread(boundedRpc, forked.id) : forked;
      if (hash(verified.turns) !== hash(retained))
        throw new HarnessAdapterError("native_fork_unknown", "Codex did not confirm the selected retained context on its fork.");
      return {command_id: commandId, session_id: request.session_id, operation: "fork", filesystem_undo: false,
        fork: {session_id: request.operation.target_session_id, continuation_group_key: request.operation.continuation_group_key, native_reference: forked.id}};
    }
    if (request.operation.kind === "rollback") {
      const currentHash = hash(thread.turns), previous = conversation.rollback;
      if (previous?.command_id === commandId) {
        if (currentHash !== previous.target_hash) throw new HarnessAdapterError("native_rollback_unknown", "The original rollback has no matching terminal evidence; it will not be repeated.");
      } else {
        if (previous?.phase === "pending") throw new HarnessAdapterError("native_rollback_unknown", "A prior rollback must be reconciled before another mutation.");
        if (currentHash !== request.operation.expected_history_hash || request.operation.num_turns > thread.turns.length)
          throw new HarnessAdapterError("native_history_changed", "Native history changed; read it again before requesting rollback.");
        // Rollback operates on an in-memory thread. Load it without starting a turn or inherited tools.
        const inherited = z.object({config: z.record(z.string(), z.unknown())}).parse(await boundedRpc.request("config/read", {cwd: conversation.cwd, includeLayers: false})).config;
        const disabled = (value: unknown) => Object.fromEntries(Object.keys(z.record(z.string(), z.unknown()).parse(value ?? {})).map(name => [name, {enabled: false}]));
        const loadedMetadata = threadSchema.parse(await boundedRpc.request("thread/resume", {threadId: conversation.native_thread_id, cwd: conversation.cwd,
          approvalPolicy: "never", sandbox: "read-only", config: {mcp_servers: disabled(inherited.mcp_servers), plugins: disabled(inherited.plugins), "features.apps": false, "features.multi_agent": false}})).thread;
        const loaded = loadedMetadata.historyMode === "paginated" ? await readThread(boundedRpc, conversation.native_thread_id) : loadedMetadata;
        if (loaded.id !== conversation.native_thread_id || hash(loaded.turns) !== currentHash)
          throw new HarnessAdapterError("native_history_changed", "Native history changed while loading; read it again.");
        const intent = {command_id: commandId, source_hash: currentHash, target_hash: hash(thread.turns.slice(0, -request.operation.num_turns)), phase: "pending" as const};
        save({...conversation, rollback: intent});
        if (thread.historyMode === "paginated") {
          const reverted = threadSchema.parse(await boundedRpc.request("thread/revert", {threadId: conversation.native_thread_id,
            beforeTurnId: thread.turns[thread.turns.length - request.operation.num_turns]!.id})).thread;
          if (reverted.id !== conversation.native_thread_id) throw new HarnessAdapterError("native_history_binding", "Native revert returned another thread.");
          thread = await readThread(boundedRpc, conversation.native_thread_id);
        } else {
          thread = threadSchema.parse(await boundedRpc.request("thread/rollback", {threadId: conversation.native_thread_id, numTurns: request.operation.num_turns})).thread;
        }
        if (thread.id !== conversation.native_thread_id || hash(thread.turns) !== intent.target_hash)
          throw new HarnessAdapterError("native_rollback_unknown", "Codex did not confirm the expected conversation-only rollback.");
        conversation = {...conversation, rollback: intent};
      }
      save({...conversation, rollback: {...conversation.rollback!, phase: "completed"}});
    }
    return hcpConversationResultPayloadSchema.parse({command_id: commandId, session_id: request.session_id,
      operation: request.operation.kind, filesystem_undo: false, history: publicHistory(thread, publish, request.operation.kind === "read" ? request.operation : undefined, "codex")});
  } finally {if (timer) clearTimeout(timer); if (!ownedRpc) await rpc.process.stop();}
}
