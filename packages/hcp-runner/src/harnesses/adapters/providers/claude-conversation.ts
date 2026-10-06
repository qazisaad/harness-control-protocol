import {z} from "zod";
import {realpath} from "node:fs/promises";
import {randomUUID} from "node:crypto";
import type {HarnessAdapterConversationInput} from "../types.js";
import {HarnessAdapterError} from "../types.js";
import {hash, publicHistory, type HistoryTurn} from "../../conversation-history.js";
import {claudeSessionHelper} from "./claude-session-helper.js";
import type {HcpConversationResultPayload} from "@harness-control/protocol";
import type {ContentPublisher} from "./content-projection.js";

export type ClaudeSessionHelper = typeof claudeSessionHelper;
// The SDK rewrites transcript UUIDs when forking; verify retained meaning independently of those IDs.
function contextHash(turns: HistoryTurn[]): string {
  return hash(turns.map(turn => ({...turn, id: "", items: turn.items.map(({id: _id, ...item}) => item)})));
}
const messageSchema = z.object({type: z.enum(["user", "assistant", "system"]), uuid: z.string(), session_id: z.string(),
  message: z.record(z.string(), z.json()).default({})});

async function history(input: HarnessAdapterConversationInput, nativeId: string, helper: ClaudeSessionHelper, boundaries = new Map<string, string>()): Promise<{turns: HistoryTurn[]; revision: string}> {
  const data = z.object({info: z.object({sessionId: z.string(), cwd: z.string()}), messages: z.array(messageSchema), revision: z.string().regex(/^[a-f0-9]{64}$/)}).parse(
    await helper(input.provider, input.conversation.cwd, {kind: "read", sessionId: nativeId}));
  if (data.info.sessionId !== nativeId || await realpath(data.info.cwd) !== await realpath(input.conversation.cwd) || data.messages.some(message => message.session_id !== nativeId))
    throw new HarnessAdapterError("native_history_binding", "Claude history belongs to another conversation or workspace.");
  return {turns: claudeHistoryTurns(data.messages, boundaries), revision: data.revision};
}

function claudeHistoryTurns(messages: z.infer<typeof messageSchema>[], boundaries = new Map<string, string>()): HistoryTurn[] {
  const turns: HistoryTurn[] = [];
  for (const message of messages) {
    const content = message.message.content;
    const blocks = typeof content === "string" ? [{type: "text", text: content}] : Array.isArray(content) ? content : [];
    const isHuman = message.type === "user" && blocks.some(block => block && typeof block === "object" && !Array.isArray(block) && block.type !== "tool_result");
    if (isHuman || !turns.length) turns.push({id: message.uuid, status: "retained", items: []});
    for (const [index, value] of blocks.entries()) {
      const block = z.record(z.string(), z.json()).parse(value);
      const id = typeof block.id === "string" ? block.id : typeof block.tool_use_id === "string" ? block.tool_use_id : `${message.uuid}:${index}`;
      const item = block.type === "text" ? {id, type: "text", role: message.type, text: block.text}
        : block.type === "thinking" ? {id, type: "reasoning", text: block.thinking}
        : block.type === "tool_use" ? {id, type: "tool_call", tool_name: block.name, arguments: block.input}
        : block.type === "tool_result" ? {id, type: "tool_result", content: block.content, status: block.is_error ? "failed" : "completed"}
        : {id, type: "provider_extension", content: {namespace: "claude", value: block}};
      turns.at(-1)!.items.push(z.record(z.string(), z.json()).parse(JSON.parse(JSON.stringify(item))));
    }
    boundaries.set(turns.at(-1)!.id, message.uuid);
  }
  return turns;
}

export async function readClaudeOwnedHistory(provider: import("../../../config/index.js").ProviderInstanceConfig, cwd: string,
  owner: {sessionId: string; agentId: string}, signal: AbortSignal, page: {cursor?: string; limit?: number},
  publish?: ContentPublisher, helper: ClaudeSessionHelper = claudeSessionHelper) {
  signal.throwIfAborted();
  const data = z.object({info: z.object({sessionId: z.string(), cwd: z.string()}), agentId: z.string(),
    messages: z.array(messageSchema).max(10_000), revision: z.string().regex(/^[a-f0-9]{64}$/)}).parse(
      await helper(provider, cwd, {kind: "subagent_read", ...owner}, signal));
  if (data.info.sessionId !== owner.sessionId || data.agentId !== owner.agentId || await realpath(data.info.cwd) !== await realpath(cwd)
    || data.messages.some(message => message.session_id !== owner.sessionId))
    throw new HarnessAdapterError("native_work_history_binding", "Claude child history belongs to another native owner or workspace.");
  signal.throwIfAborted();
  return publicHistory({id: `${owner.sessionId}:${owner.agentId}`, turns: claudeHistoryTurns(data.messages), revision: data.revision},
    publish, {kind: "read", ...page}, "claude");
}

export async function claudeConversation(input: HarnessAdapterConversationInput, helper: ClaudeSessionHelper = claudeSessionHelper): Promise<HcpConversationResultPayload> {
  const {request, conversation, commandId} = input;
  if (!["read", "fork", "rollback"].includes(request.operation.kind))
    throw new HarnessAdapterError("conversation_operation_unsupported", "Claude supports read, fork and rollback.");
  const boundaries = new Map<string, string>();
  let nativeId = conversation.native_thread_id, fresh = conversation.fresh;
  let snapshot = fresh ? {turns: [], revision: hash([])} : await history(input, nativeId, helper, boundaries);
  let {turns, revision} = snapshot;
  if (request.operation.kind === "fork") {
    const operation = request.operation;
    if (revision !== operation.expected_history_hash || (operation.last_turn_id && !turns.some(turn => turn.id === operation.last_turn_id)))
      throw new HarnessAdapterError("native_history_changed", "Read the source history again before forking.");
    if (!input.beginMutation) throw new HarnessAdapterError("native_mutation_fence_missing", "A fork requires its durable runner fence.");
    const end = operation.last_turn_id ? turns.findIndex(turn => turn.id === operation.last_turn_id) + 1 : turns.length;
    const selected = turns.slice(0, end).at(-1);
    const boundary = selected ? boundaries.get(selected.id) : undefined;
    if (!fresh && !boundary) throw new HarnessAdapterError("native_history_boundary", "The selected history has no stable SDK message boundary.");
    input.beginMutation();
    const forkId = fresh ? randomUUID() : z.object({sessionId: z.string()}).parse(await helper(input.provider, conversation.cwd,
      {kind: "fork", sessionId: nativeId, ...(boundary ? {upToMessageId: boundary} : {})})).sessionId;
    if (forkId === nativeId || (!fresh && (contextHash((await history(input, forkId, helper)).turns) !== contextHash(turns.slice(0, end)) ||
        (await history(input, nativeId, helper)).revision !== revision)))
      throw new HarnessAdapterError("native_fork_unknown", "Claude did not confirm an independent copy of the selected context.");
    return {command_id: commandId, session_id: request.session_id, operation: "fork", filesystem_undo: false,
      ...(fresh ? {native_fresh: true} : {}), fork: {session_id: operation.target_session_id, continuation_group_key: operation.continuation_group_key, native_reference: forkId}};
  }
  if (request.operation.kind === "rollback") {
    const prior = conversation.rollback;
    if (prior?.command_id === commandId) {
      if (prior.phase !== "completed" || !prior.replacement_native_thread_id)
        throw new HarnessAdapterError("native_rollback_unknown", "An earlier rollback has no confirmed replacement; it will not be repeated.");
      nativeId = prior.replacement_native_thread_id; fresh = prior.native_fresh;
      snapshot = fresh ? {turns: [], revision: hash([])} : await history(input, nativeId, helper);
      ({turns, revision} = snapshot);
      if (revision !== prior.target_hash) throw new HarnessAdapterError("native_rollback_unknown", "The replacement history no longer matches its durable proof.");
    } else {
      if (prior?.phase === "pending") throw new HarnessAdapterError("native_rollback_unknown", "An earlier rollback has an unknown outcome.");
      if (revision !== request.operation.expected_history_hash || request.operation.num_turns > turns.length)
        throw new HarnessAdapterError("native_history_changed", "Read the current history before requesting rollback.");
      const retained = turns.slice(0, -request.operation.num_turns);
      fresh = retained.length ? undefined : true;
      const boundary = retained.length ? boundaries.get(retained.at(-1)!.id) : undefined;
      if (!fresh && !boundary) throw new HarnessAdapterError("native_history_boundary", "The retained history has no stable SDK message boundary.");
      const intent = {command_id: commandId, source_hash: revision, target_hash: hash(retained), phase: "pending" as const};
      input.save({...conversation, rollback: intent});
      nativeId = fresh ? randomUUID() : z.object({sessionId: z.string()}).parse(await helper(input.provider, conversation.cwd,
        {kind: "fork", sessionId: nativeId, upToMessageId: boundary!})).sessionId;
      snapshot = fresh ? {turns: [], revision: hash([])} : await history(input, nativeId, helper);
      ({turns, revision} = snapshot);
      if (nativeId === conversation.native_thread_id || contextHash(turns) !== contextHash(retained)) throw new HarnessAdapterError("native_rollback_unknown", "Claude did not confirm the expected retained context.");
      if (!conversation.fresh && (await history(input, conversation.native_thread_id, helper)).revision !== intent.source_hash)
        throw new HarnessAdapterError("native_rollback_unknown", "Claude source history changed during rollback.");
      input.save({...conversation, rollback: {...intent, target_hash: revision, phase: "completed", replacement_native_thread_id: nativeId, ...(fresh ? {native_fresh: true} : {})}});
    }
  }
  return {command_id: commandId, session_id: request.session_id, operation: request.operation.kind, filesystem_undo: false,
    ...(request.operation.kind === "rollback" ? {native_reference: nativeId, ...(fresh ? {native_fresh: true} : {})} : {}),
    history: publicHistory({id: nativeId, turns, revision}, input.publishContent, request.operation.kind === "read" ? request.operation : undefined, "claude")};
}
