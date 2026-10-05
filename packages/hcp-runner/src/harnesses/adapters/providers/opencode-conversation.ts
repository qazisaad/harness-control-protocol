import {z} from "zod";
import type {HcpConversationResultPayload} from "@harness-control/protocol";
import type {HarnessAdapterConversationInput} from "../types.js";
import {HarnessAdapterError} from "../types.js";
import type {OpenCodeRuntime} from "./opencode.js";
import {hash, publicHistory, type HistoryTurn} from "../../conversation-history.js";

const messagesSchema = z.array(z.object({info: z.object({id: z.string(), sessionID: z.string(), role: z.enum(["user", "assistant"])}).passthrough(),
  parts: z.array(z.record(z.string(), z.json()))})).max(10_000);
function contextHash(turns: HistoryTurn[]) {
  return hash(turns.map(turn => ({...turn, id: "", items: turn.items.map(({id: _id, ...item}) => item)})));
}
async function history(runtime: OpenCodeRuntime, sessionId: string): Promise<HistoryTurn[]> {
  if (!runtime.readHistory) throw new HarnessAdapterError("conversation_operation_unsupported", "The OpenCode runtime has no retained-history implementation.");
  const messages = messagesSchema.parse(await runtime.readHistory(sessionId));
  if (messages.some(message => message.info.sessionID !== sessionId))
    throw new HarnessAdapterError("native_history_binding", "OpenCode messages belong to another conversation.");
  const turns: HistoryTurn[] = [];
  for (const message of messages) {
    if (message.info.role === "user" || !turns.length) turns.push({id: message.info.id, status: "retained", items: []});
    for (const part of message.parts) {
      if (part.sessionID !== sessionId || part.messageID !== message.info.id || typeof part.id !== "string")
        throw new HarnessAdapterError("native_history_binding", "OpenCode part belongs to another message or conversation.");
      const state = part.type === "tool" ? z.object({status: z.string(), input: z.json(), output: z.json().optional(), error: z.json().optional()}).parse(part.state) : undefined;
      const item = part.type === "text" ? {id: part.id, type: "text", role: message.info.role, text: part.text}
        : part.type === "reasoning" ? {id: part.id, type: "reasoning", text: part.text}
        : state ? {id: part.id, type: "tool_call", tool_name: part.tool, arguments: state.input, status: state.status, output: state.output, error: state.error}
        : {id: part.id, type: "provider_extension", content: {namespace: "opencode", value: Object.fromEntries(Object.entries(part)
            .filter(([key]) => !["id", "sessionID", "messageID", "time"].includes(key)))}};
      turns.at(-1)!.items.push(z.record(z.string(), z.json()).parse(JSON.parse(JSON.stringify(item))));
    }
  }
  return turns;
}

export async function openCodeConversation(input: HarnessAdapterConversationInput, runtime: OpenCodeRuntime): Promise<HcpConversationResultPayload> {
  const {request, conversation, commandId} = input;
  let nativeId = conversation.native_thread_id;
  let turns = await history(runtime, nativeId);
  const operation = request.operation;
  if (operation.kind === "read") return {command_id: commandId, session_id: request.session_id, operation: "read", filesystem_undo: false,
    history: publicHistory({id: nativeId, turns}, input.publishContent, operation)};
  if (operation.kind !== "fork" && operation.kind !== "rollback")
    throw new HarnessAdapterError("conversation_operation_unsupported", "The OpenCode adapter supports read, fork and rollback.");
  if (operation.kind === "rollback" && conversation.rollback?.command_id === commandId) {
    const prior = conversation.rollback;
    if (prior.phase !== "completed" || !prior.replacement_native_thread_id)
      throw new HarnessAdapterError("native_rollback_unknown", "The earlier rollback has no confirmed replacement and will not be repeated.");
    nativeId = prior.replacement_native_thread_id;
    turns = await history(runtime, nativeId);
    if (hash(turns) !== prior.target_hash) throw new HarnessAdapterError("native_rollback_unknown", "The replacement history no longer matches its durable proof.");
  } else {
    if (conversation.rollback?.phase === "pending") throw new HarnessAdapterError("native_rollback_unknown", "An earlier rollback has an unknown outcome.");
    if (hash(turns) !== operation.expected_history_hash) throw new HarnessAdapterError("native_history_changed", "Read current history before changing retained context.");
    let end = turns.length;
    if (operation.kind === "rollback") {
      if (operation.num_turns > turns.length) throw new HarnessAdapterError("native_history_boundary", "Rollback exceeds retained history.");
      end -= operation.num_turns;
    } else if (operation.last_turn_id) {
      const selected = turns.findIndex(turn => turn.id === operation.last_turn_id);
      if (selected < 0) throw new HarnessAdapterError("native_history_boundary", "The fork boundary is absent from retained history.");
      end = selected + 1;
    }
    if (!runtime.forkHistory) throw new HarnessAdapterError("conversation_operation_unsupported", "The OpenCode runtime cannot fork retained context.");
    const retained = turns.slice(0, end);
    const intent = {command_id: commandId, source_hash: hash(turns), target_hash: hash(retained), phase: "pending" as const};
    if (operation.kind === "fork") {
      if (!input.beginMutation) throw new HarnessAdapterError("native_mutation_fence_missing", "A fork requires its durable runner fence.");
      input.beginMutation();
    } else input.save({...conversation, rollback: intent});
    // OpenCode's boundary is exclusive: the first omitted user message defines the retained prefix.
    nativeId = await runtime.forkHistory(turns[end]?.id);
    const copied = await history(runtime, nativeId);
    if (nativeId === conversation.native_thread_id || contextHash(copied) !== contextHash(retained))
      throw new HarnessAdapterError("native_mutation_unknown", "OpenCode did not confirm an independent copy of the selected context.");
    turns = copied;
    if (operation.kind === "fork") return {command_id: commandId, session_id: request.session_id, operation: "fork", filesystem_undo: false,
      fork: {session_id: operation.target_session_id, continuation_group_key: operation.continuation_group_key, native_reference: nativeId}};
    input.save({...conversation, rollback: {...intent, target_hash: hash(turns), phase: "completed", replacement_native_thread_id: nativeId}});
  }
  return {command_id: commandId, session_id: request.session_id, operation: "rollback", filesystem_undo: false, native_reference: nativeId,
    history: publicHistory({id: nativeId, turns}, input.publishContent)};
}
