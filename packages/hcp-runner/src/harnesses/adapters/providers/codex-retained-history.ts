import {realpath} from "node:fs/promises";
import {z} from "zod";
import {CodexRpc} from "./codex-rpc.js";
import {HarnessAdapterError, type HarnessAdapter} from "../types.js";
import {nativeConversationOperation, readCodexOwnedHistory, readThread} from "../../native-conversation.js";
import {hash} from "../../conversation-history.js";

const identity = z.string().min(1).max(512);
const thread = z.object({thread: z.object({id: identity, cwd: z.string().min(1).max(4096),
  parentThreadId: identity.nullish(), source: z.unknown().optional()})});
const childSource = z.object({subAgent: z.object({thread_spawn: z.object({parent_thread_id: identity})})});
type Input = Parameters<NonNullable<HarnessAdapter["readRetainedNativeWorkHistory"]>>[0];

/** A new read-only transport can inspect admitted rollouts without claiming an execution owner. */
export async function readRetainedCodexHistory(input: Input) {
  return withCodexCustody(input, rpc => readCodexOwnedHistory(rpc, input.work.native_reference, input.signal, input.page, input.publishContent, false));
}

/** Exact admitted execution proof settles only the child, never its session or descendants. */
export async function reconcileRetainedCodexWork(input: Parameters<NonNullable<HarnessAdapter["reconcileNativeWork"]>>[0]) {
  if (!input.custody.native_execution_reference)
    throw new HarnessAdapterError("native_work_reconciliation_unavailable", "The child lacks a durably admitted native execution identity.");
  return withCodexCustody(input, async rpc => {
    const bounded = {request: (method: string, params: unknown) => rpc.request(method, params, {signal: input.signal})};
    const first = await readThread(bounded, input.work.native_reference);
    const second = await readThread(bounded, input.work.native_reference);
    if (hash(first.turns) !== hash(second.turns))
      throw new HarnessAdapterError("native_work_changed", "Native execution changed during reconciliation.");
    const execution = first.turns.find(turn => turn.id === input.custody.native_execution_reference);
    if (!execution || first.turns.at(-1)?.id !== execution.id)
      throw new HarnessAdapterError("native_work_reconciliation_unavailable", "Native history does not end at the admitted child execution.");
    const native = z.enum(["completed", "failed", "interrupted"]).safeParse(execution.status);
    if (!native.success) throw new HarnessAdapterError("native_work_reconciliation_unavailable", "The admitted execution has no authoritative native terminal status.");
    return {status: native.data === "interrupted" ? "cancelled" as const : native.data};
  });
}

export async function forkRetainedCodexWork(input: Parameters<NonNullable<HarnessAdapter["forkNativeWork"]>>[0]) {
  return withCodexCustody({...input, scope: {cwd: input.conversation.cwd}}, async rpc => {
    const operation = input.operation;
    const result = await nativeConversationOperation(input.commandId,
      {session_id: input.sessionId, operation: {kind: "fork", target_session_id: operation.target_session_id,
        continuation_group_key: operation.continuation_group_key, expected_history_hash: operation.expected_history_hash,
        ...(operation.last_turn_id ? {last_turn_id: operation.last_turn_id} : {})}},
      {...input.conversation, native_thread_id: input.work.native_reference}, input.provider,
      () => {throw new HarnessAdapterError("native_fork_unknown", "Child fork state belongs to its runner dispatch fence.");},
      input.beginMutation, undefined, rpc, "inspection");
    if (!result.fork) throw new HarnessAdapterError("native_fork_unknown", "The native child fork did not return its destination.");
    return {native_reference: result.fork.native_reference};
  });
}

async function withCodexCustody<T>(input: Pick<Input, "custody" | "work" | "provider" | "signal"> & {scope: {cwd: string}},
  operation: (rpc: CodexRpc) => Promise<T>): Promise<T> {
  const {custody, work, scope, provider, signal} = input;
  if (custody.source !== "codex" || work.kind !== "agent" || custody.native_reference !== work.native_reference
    || custody.work_id !== work.work_id || custody.origin_turn_id !== work.origin_turn_id || custody.parent_work_id !== work.parent_work_id)
    throw new HarnessAdapterError("native_work_history_binding", "Retained history requires the original admitted Codex child.");
  signal.throwIfAborted();
  const cwd = await realpath(scope.cwd);
  const rpc = new CodexRpc(provider.executable_path ?? "codex", cwd,
    {...process.env, ...provider.env, ...(provider.home ? {CODEX_HOME: provider.home} : {})});
  const stop = () => {void rpc.process.stop();};
  signal.addEventListener("abort", stop, {once: true});
  const verify = async () => {
    signal.throwIfAborted();
    const native = thread.parse(await rpc.request("thread/read", {threadId: work.native_reference, includeTurns: false}, {signal})).thread;
    const source = childSource.parse(native.source);
    if (native.id !== work.native_reference || native.parentThreadId !== custody.parent_native_reference
      || source.subAgent.thread_spawn.parent_thread_id !== custody.parent_native_reference || await realpath(native.cwd) !== cwd)
      throw new HarnessAdapterError("native_work_history_binding", "Retained Codex child ancestry or workspace changed.");
    // Both parent and root must remain in the original native storage/workspace.
    for (const id of new Set([custody.parent_native_reference, custody.root_native_reference])) {
      const parent = thread.parse(await rpc.request("thread/read", {threadId: id, includeTurns: false}, {signal})).thread;
      if (parent.id !== id || await realpath(parent.cwd) !== cwd)
        throw new HarnessAdapterError("native_work_history_binding", "Retained Codex parent or root binding changed.");
    }
  };
  try {
    await rpc.request("initialize", {clientInfo: {name: "hcp-retained-history", version: "0.5.0"}, capabilities: {experimentalApi: true}}, {signal});
    rpc.notify("initialized");
    await verify();
    const result = await operation(rpc);
    await verify();
    return result;
  } finally {signal.removeEventListener("abort", stop); await rpc.process.stop();}
}
