import {z} from "zod";
import {isDeepStrictEqual} from "node:util";
import {HarnessAdapterError, type HarnessAdapterTurnInput, type HarnessMcpReviewer, type HarnessMcpToolset} from "../types.js";
import {NativeMcpBridge, nativeMcpNamespace} from "./native-mcp.js";
import {OpenCodeOwnedWork} from "./opencode-work.js";
import {openCodeOwnedToolAlias, verifyOpenCodeOwnedToolInvocation, type OpenCodeOwnedToolDefinition, type OpenCodeOwnedToolInvocation} from "./opencode-owned-tools.js";

type Owner = {turn: HarnessAdapterTurnInput; prompt: string; session: string; workId?: string; lifetime: AbortController; reviewer?: HarnessMcpReviewer};
export function openCodeOwnedMcpDefinitions(toolsets: readonly HarnessMcpToolset[]): OpenCodeOwnedToolDefinition[] {
  const definitions = toolsets.flatMap(set => set.tools.map(tool => ({alias: openCodeOwnedToolAlias(set.name, tool.name),
    description: tool.description ?? "", schema: z.record(z.string(), z.json()).parse(tool.input_schema)})));
  if (new Set(definitions.map(tool => tool.alias)).size !== definitions.length)
    throw new HarnessAdapterError("native_tool_catalog_conflict", "Native selected tool bindings must be unique.");
  return definitions;
}
/** Exact native custody, independently retained for children after the original root returns. */
export class OpenCodeOwnedMcp {
  readonly definitions: readonly OpenCodeOwnedToolDefinition[];
  readonly #aliases = new Map<string, {attachment: string; tool: string}>();
  readonly #catalog: Array<{name: string; tools: HarnessMcpToolset["tools"]}>;
  readonly #roots = new Map<string, {input: HarnessAdapterTurnInput; prompt: string; signal: AbortSignal}>();
  readonly #owners = new Map<string, Owner>();
  readonly #closingWork = new Set<string>();
  #closed = false;
  constructor(readonly work: OpenCodeOwnedWork, toolsets: readonly HarnessMcpToolset[]) {
    this.definitions = openCodeOwnedMcpDefinitions(toolsets);
    this.#catalog = toolsets.map(set => ({name: set.name, tools: structuredClone(set.tools)}));
    for (const set of toolsets) for (const tool of set.tools) {
      const alias = openCodeOwnedToolAlias(set.name, tool.name);
      this.#aliases.set(alias, {attachment: set.name, tool: tool.name});
    }
  }
  admitRoot(prompt: string, input: HarnessAdapterTurnInput, signal: AbortSignal) {
    if (this.#closed || this.#roots.size >= 1024 || this.#roots.has(input.payload.turn_id) || this.work.rootOrigin(prompt) !== input.payload.turn_id)
      throw new HarnessAdapterError("native_tool_origin_limit", "The native tool owner requires an exact original prompt admission.");
    if (!isDeepStrictEqual((input.mcpToolsets ?? []).map(set => ({name: set.name, tools: set.tools})), this.#catalog))
      throw new HarnessAdapterError("native_tool_catalog_unconfirmed", "The original turn catalog differs from the owned native definitions.");
    const captured = {...input, payload: structuredClone(input.payload), mcpToolsets: (input.mcpToolsets ?? []).map(set => ({
      name: set.name, tools: structuredClone(set.tools), callTool: set.callTool.bind(set),
    }))};
    this.#roots.set(input.payload.turn_id, {input: captured, prompt, signal});
  }
  #origin(session: string, prompt: string) {
    const child = session === this.work.root ? this.work.continuationOrigin(prompt) : this.work.childOrigin(session);
    if (child?.prompt_id === prompt && !this.#closingWork.has(child.work_id)) return {turnId: child.origin_turn_id, workId: child.work_id};
    if (session === this.work.root) {
      const turnId = this.work.rootOrigin(prompt);
      if (turnId) return {turnId};
    }
    throw new HarnessAdapterError("native_tool_origin_unconfirmed", "The native tool has no live original root or child admission.");
  }
  async invoke(input: OpenCodeOwnedToolInvocation, signal: AbortSignal) {
    signal.throwIfAborted();
    await this.work.settled();
    if (this.#closed) throw new HarnessAdapterError("native_tool_owner_closed", "The native tool owner closed.");
    const proof = await verifyOpenCodeOwnedToolInvocation(input, this.work.start.payload.cwd, this.work.transport);
    const session = input.native_context.session_id, prompt = proof.native_prompt_id;
    const origin = this.#origin(session, prompt), admitted = this.#roots.get(origin.turnId), selected = this.#aliases.get(input.alias);
    if (!admitted || !selected || (!origin.workId && admitted.prompt !== prompt))
      throw new HarnessAdapterError("native_tool_origin_unconfirmed", "The native selected tool has no original authorized catalog.");
    const key = JSON.stringify([session, prompt, origin.workId ?? null]);
    let owner = this.#owners.get(key);
    if (!owner) {
      if (this.#owners.size >= 128) throw new HarnessAdapterError("native_tool_owner_limit", "The native tool owner limit was exceeded.");
      const lifetime = new AbortController(), turn = admitted.input;
      const reviewer = origin.workId ? turn.reviewNativeWorkMcp?.(origin.workId) : turn.reviewMcpTool;
      if (origin.workId && !reviewer) throw new HarnessAdapterError("native_tool_review_unavailable", "The child tool requires its original work review owner.");
      owner = {turn, session, prompt, lifetime, ...(origin.workId ? {workId: origin.workId} : {}), ...(reviewer ? {reviewer} : {})};
      this.#owners.set(key, owner);
    }
    const captured = owner;
    const invocationSignal = AbortSignal.any([signal, captured.lifetime.signal, ...(origin.workId ? [] : [admitted.signal])]);
    const confirm = async () => {
      invocationSignal.throwIfAborted();await this.work.settled();
      if (this.#closed || this.#origin(session, prompt).workId !== captured.workId) throw new HarnessAdapterError("native_tool_origin_unconfirmed", "The native tool owner changed before dispatch.");
      await verifyOpenCodeOwnedToolInvocation(input, this.work.start.payload.cwd, this.work.transport);
      invocationSignal.throwIfAborted();
    };
    // Review may wait for a human. Revalidate native liveness immediately before invoking the authorized backend.
    const reviewer = captured.reviewer;
    const guarded: HarnessMcpReviewer | undefined = reviewer ? {
      request: (request, lifetime) => reviewer.request(request, lifetime), complete: (grant, result) => reviewer.complete(grant, result),
      invoke: async (request, call, lifetime, grant, continuation) => {
        await confirm();
        const guardedCall: HarnessMcpToolset["callTool"] = async (...args) => {await confirm();return call(...args);};
        if (reviewer.invoke) return reviewer.invoke(request, guardedCall, lifetime, grant, continuation);
        const result = await guardedCall(request.tool_name, request.arguments, grant, continuation);
        if (grant) await reviewer.complete(grant, result);
        return result;
      },
    } : undefined;
    // The owner receipt registry enforces one use. Backend guards also cover calls without review.
    const sets = (captured.turn.mcpToolsets ?? []).map(set => ({...set, callTool: async (...args: Parameters<HarnessMcpToolset["callTool"]>) => {
      await confirm();return set.callTool(...args);
    }}));
    const bridge = new NativeMcpBridge(sets, guarded, captured.turn.dispatchMcp);
    await confirm();
    const call = {threadId: session, turnId: prompt, callId: input.native_context.call_id,
      namespace: nativeMcpNamespace(selected.attachment), tool: selected.tool, arguments: input.arguments,
      native_request: {source: "native" as const, native_reference: session, call_reference: input.native_context.call_id,
        message_reference: input.native_context.message_id, execution_reference: prompt, item_reference: proof.native_part_id}};
    const receiptKey = JSON.stringify([session, input.native_context.message_id, input.native_context.call_id]);
    if (this.#seen.has(receiptKey) || this.#seen.size >= 4096) throw new HarnessAdapterError("native_tool_call_identity_invalid", "The native tool call was repeated or its owner limit was exceeded.");
    this.#seen.add(receiptKey);
    const result = await bridge.call(call, {threadId: session, turnId: prompt}, invocationSignal);
    const output = result.contentItems.filter(item => item.type === "inputText").map(item => item.text).join("\n");
    const attachments = result.contentItems.flatMap(item => {
      const url = item.type === "inputImage" ? item.imageUrl : item.type === "inputAudio" ? item.audioUrl : undefined;
      const mime = url?.match(/^data:([^;,]+);base64,/u)?.[1];
      return url && mime ? [{type: "file" as const, mime, url}] : [];
    });
    return {output, metadata: {hcp_tool_success: result.success}, ...(attachments.length ? {attachments} : {})};
  }
  readonly #seen = new Set<string>();
  synchronize() {
    for (const [key, owner] of this.#owners) {
      let live = false;
      try {live = this.#origin(owner.session, owner.prompt).workId === owner.workId;} catch { /* An absent exact owner fences its invocation. */ }
      if (!live) {owner.lifetime.abort();this.#owners.delete(key);}
    }
  }
  closeWork(id: string) {
    this.#closingWork.add(id);
    for (const [key, owner] of this.#owners) if (owner.workId === id) {owner.lifetime.abort();this.#owners.delete(key);}
  }
  close() {this.#closed = true;for (const owner of this.#owners.values()) owner.lifetime.abort();this.#owners.clear();this.#roots.clear();}
}
