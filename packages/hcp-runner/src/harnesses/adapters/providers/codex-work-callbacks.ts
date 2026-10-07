import {z} from "zod";
import {NativeInteractions} from "../../native-interactions.js";
import {HarnessAdapterError, type HarnessAdapterStartInput, type HarnessAdapterTurnInput} from "../types.js";
import {codexRequestIdentity} from "./codex-request-identity.js";
import {CodexRpc, type RpcRequestContext} from "./codex-rpc.js";
import {CodexOwnedWork} from "./codex-work.js";
import {NativeMcpBridge} from "./native-mcp.js";
import {codexApproval} from "./codex-approvals.js";

const binding = z.object({threadId: z.string().min(1).max(512), turnId: z.string().min(1).max(512)});
type Owner = {thread: string; turn: string; interactions: NativeInteractions; bridge: NativeMcpBridge};
const methods = ["item/commandExecution/requestApproval", "item/fileChange/requestApproval",
  "item/permissions/requestApproval", "item/tool/requestUserInput", "item/tool/call"] as const;

/** Session handlers survive root completion; only verified native child membership admits a callback. */
export class CodexWorkCallbacks {
  readonly #roots = new Map<string, HarnessAdapterTurnInput>();
  readonly #owners = new Map<string, Owner>();
  #admission: Promise<void> = Promise.resolve();
  #closed = false;
  constructor(readonly rpc: CodexRpc, readonly work: CodexOwnedWork, readonly start: HarnessAdapterStartInput) {
    if (!start.emitSessionEvent || !start.registerSessionInteractions)
      throw new HarnessAdapterError("native_session_owner_required", "Child callbacks require a registered session observation owner.");
    start.registerSessionInteractions({
      owns: id => [...this.#owners.values()].some(owner => owner.interactions.owns(id)),
      respondApproval: response => this.#find(response.request_id).respondApproval(response),
      respondInput: response => this.#find(response.request_id).respondInput(response),
    });
    for (const method of methods) rpc.setSessionRequestHandler(method, (params, signal, context) => this.#route(method, params, signal, context));
    void rpc.process.closed.then(() => this.close());
  }
  #find(id: string): NativeInteractions {
    const owner = [...this.#owners.values()].find(value => value.interactions.owns(id));
    if (!owner || this.#closed) throw new HarnessAdapterError("native_request_owner_missing", "The child callback owner is unavailable.");
    return owner.interactions;
  }
  pendingAdmission(admission: Promise<void>): void {this.#admission = admission; void admission.catch(() => {});}
  admit(input: HarnessAdapterTurnInput, thread: string, turn: string): void {
    if (this.#roots.size >= 1024 && !this.#roots.has(input.payload.turn_id))
      throw new HarnessAdapterError("native_work_origin_limit", "Child callbacks exceeded the bounded root registry.");
    this.#roots.set(input.payload.turn_id, input);
    this.work.admitRoot(thread, turn, input.payload.turn_id);
  }
  async #route(method: typeof methods[number], params: unknown, signal: AbortSignal, context?: RpcRequestContext): Promise<unknown> {
    await this.#admission; signal.throwIfAborted();
    await this.work.settled(); signal.throwIfAborted();
    if (this.#closed) throw new HarnessAdapterError("native_request_owner_missing", "The persistent callback owner is closed.");
    const native = binding.parse(params);
    const origin = this.work.childOrigin(native.threadId, native.turnId);
    if (!origin) return this.rpc.handleTurnRequest(method, params, signal, context);
    let owner = this.#owners.get(origin.work_id);
    if (!owner) {
      const root = this.#roots.get(origin.origin_turn_id);
      if (!root || !root.reviewNativeWorkMcp) throw new HarnessAdapterError("native_work_request_binding", "The child lacks its original callback admission.");
      if (this.#owners.size >= 128) throw new HarnessAdapterError("native_work_request_limit", "Child callbacks exceeded the bounded work registry.");
      owner = {thread: native.threadId, turn: native.turnId,
        interactions: new NativeInteractions(this.start.payload, root.payload, {threadId: native.threadId, turnId: () => native.turnId},
          this.start.emitSessionEvent!, origin.work_id),
        bridge: new NativeMcpBridge(root.mcpToolsets ?? [], root.reviewNativeWorkMcp(origin.work_id), root.dispatchMcp)};
      this.#owners.set(origin.work_id, owner);
    }
    if (owner.thread !== native.threadId || owner.turn !== native.turnId)
      throw new HarnessAdapterError("native_work_request_binding", "The native child callback changed execution identity.");
    if (method === "item/tool/call") return owner.bridge.call(params, native, signal);
    if (method === "item/tool/requestUserInput") return owner.interactions.questions(params, signal, codexRequestIdentity(params, context));
    if (method === "item/permissions/requestApproval") {
      const request = binding.extend({itemId: z.string(), permissions: z.record(z.string(), z.json())}).passthrough().parse(params);
      const answer = await owner.interactions.approval({...request, additionalPermissions: request.permissions,
        availableDecisions: ["accept", "decline", "cancel"]}, "permissions", signal, codexRequestIdentity(params, context));
      return {permissions: answer.decision === "accept" ? request.permissions : {}, scope: "turn"};
    }
    return codexApproval(owner.interactions, params, method === "item/fileChange/requestApproval" ? "file_change" : "command", signal, true, context);
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const owner of this.#owners.values()) owner.interactions.close();
    this.#owners.clear(); this.#roots.clear();
    this.start.registerSessionInteractions?.(undefined);
  }
}
