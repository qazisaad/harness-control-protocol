import {randomUUID} from "node:crypto";
import {realpath} from "node:fs/promises";
import {z} from "zod";
import {readCodexSettingsNotification} from "./codex-settings.js";
import {isNativeWorkTerminal, type HarnessNativeWorkObservation, type HarnessNativeWorkRecord} from "@harness-control/protocol";
import {HarnessAdapterError, type HarnessAdapterStartInput} from "../types.js";
import {CodexRpc, type RpcMessage} from "./codex-rpc.js";
import type {NativeWorkCustody} from "../../../state/index.js";

const identity = z.string().min(1).max(512);
const binding = z.object({threadId: identity, turnId: identity});
const activity = binding.extend({item: z.object({id: identity, type: z.literal("subAgentActivity"), agentThreadId: identity,
  agentPath: z.string().max(2048), kind: z.enum(["started", "interacted", "interrupted", "completed"])})});
const childRead = z.object({thread: z.object({id: identity, cwd: z.string().min(1).max(4096), parentThreadId: identity,
  source: z.object({subAgent: z.object({thread_spawn: z.object({parent_thread_id: identity})})}),
  turns: z.array(z.object({id: identity, status: z.string()})).optional()})});
type Origin = {turn: string; parent?: string};
type Child = {thread: string; parent: string; launch: string; turn?: string; finalText?: string; work: HarnessNativeWorkObservation; custody?: NativeWorkCustody};
type Command = {thread: string; turn: string; item: string; process?: string; work: HarnessNativeWorkObservation};
const key = (thread: string, turn: string): string => `${thread}\0${turn}`;

/** Native launch bookends and native parent readback establish ownership. Idle is never terminal proof. */
export class CodexOwnedWork {
  readonly #roots = new Map<string, Origin>();
  readonly #activeRoots = new Set<string>();
  readonly #rootThreads = new Set<string>();
  readonly #children = new Map<string, Child>();
  readonly #works = new Map<string, Child>();
  readonly #launches = new Map<string, Child>();
  readonly #commands = new Map<string, Command>();
  readonly #pending = new Map<string, RpcMessage[]>();
  readonly #unconfirmed = new Set<string>();
  readonly #unsubscribe: () => void;
  #queue: Promise<void> = Promise.resolve();
  #lost = false;
  #stopping = false;
  #closureCertified = false;

  constructor(readonly rpc: CodexRpc, readonly start: HarnessAdapterStartInput) {
    if (!start.emitSessionEvent) throw new HarnessAdapterError("native_session_owner_required", "Native child work requires a session observation owner.");
    this.#unsubscribe = rpc.observeNotifications(message => {this.#enqueue(() => this.#observe(message));});
    void rpc.process.closed.then(() => {if (!this.#closureCertified) this.#lose("native_exit");});
  }
  #enqueue(operation: () => Promise<void>): void {
    this.#queue = this.#queue.then(operation).catch(() => {this.#lose("runtime_error");});
  }
  #lose(reason: "native_exit" | "runtime_error"): void {
    if (this.#lost) return;
    this.#lost = true;
    try {this.start.emitSessionEvent!({event_type: "native.work.owner_lost", data: {reason,
      ...(this.busy || this.#activeRoots.size ? {closure_unconfirmed: true} : {})}});} catch { /* Persistence failure cannot restore native ownership. */ }
    if (reason === "runtime_error") void this.rpc.process.stop();
  }
  #publish(child: Child): void {this.start.emitSessionEvent!({event_type: "native.work.updated", data: {work: structuredClone(child.work)},
    ...(child.custody ? {nativeWorkCustody: child.custody} : {})});}
  async #request(method: string, params: unknown): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {return await Promise.race([this.rpc.request(method, params), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new HarnessAdapterError("native_work_transport_timeout", "The native work request has no confirmed outcome.")), 10000);
    })]);} finally {if (timer) clearTimeout(timer);}
  }
  attachRootThread(thread: string): void {
    this.#rootThreads.add(thread);
    // Root thread lifecycle notifications can precede thread/start's response.
    const pending = this.#pending.get(thread);
    if (pending) {
      const turns = pending.filter(message => typeof (message.params as {turnId?: unknown})?.turnId === "string");
      if (turns.length) this.#pending.set(thread, turns); else this.#pending.delete(thread);
    }
  }
  admitRoot(thread: string, nativeTurn: string, appTurn: string): void {
    if (this.#lost || this.#stopping) throw new HarnessAdapterError("native_owner_unavailable", "The native work owner is unavailable.");
    if (this.#roots.size >= 1024) throw new HarnessAdapterError("native_work_origin_limit", "The native owner exceeded its admitted origin registry.");
    this.#rootThreads.add(thread);
    this.#roots.set(key(thread, nativeTurn), {turn: appTurn});
    this.#activeRoots.add(key(thread, nativeTurn));
    this.#enqueue(() => this.#replay(thread));
  }
  async settled(): Promise<void> {await this.#queue; if (this.#lost) throw new HarnessAdapterError("native_owner_unavailable", "The native work observation owner was lost.");}
  get busy(): boolean {return this.#pending.size > 0 || this.#unconfirmed.size > 0 || [...this.#children.values()].some(child => !isNativeWorkTerminal(child.work.status))
    || [...this.#commands.values()].some(command => !isNativeWorkTerminal(command.work.status));}
  #publishCommand(command: Command): void {
    if (command.work.background) this.start.emitSessionEvent!({event_type: "native.work.updated", data: {work: structuredClone(command.work)}});
  }
  async #observeCommand(message: RpcMessage, thread: string): Promise<boolean> {
    const event = binding.extend({item: z.object({id: identity, type: z.literal("commandExecution"),
      command: z.string().max(128 * 1024), processId: identity.nullish(), status: z.enum(["inProgress", "completed", "failed", "declined"]),
      exitCode: z.number().int().nullish(), aggregatedOutput: z.string().max(4 * 1024 * 1024).nullish()})}).parse(message.params);
    const origin = this.#roots.get(key(thread, event.turnId));
    if (!origin) {this.#buffer(thread, message); return true;}
    const commandKey = key(key(thread, event.turnId), event.item.id);
    let command = this.#commands.get(commandKey);
    if (event.item.status === "inProgress") {
      if (!command) {
        if (this.#commands.size + this.#works.size >= 128) throw new Error("Native work registry limit");
        command = {thread, turn: event.turnId, item: event.item.id, ...(event.item.processId ? {process: event.item.processId} : {}),
          work: {work_id: `codex-command-${randomUUID()}`, native_reference: event.item.id, origin_turn_id: origin.turn,
            kind: "command", background: !this.#activeRoots.has(key(thread, event.turnId)), status: "running", supports_cancel: false,
            summary: event.item.command.slice(0, 2048)}};
        this.#commands.set(commandKey, command);
      } else if (isNativeWorkTerminal(command.work.status)) return true;
      if (event.item.processId) {
        if (command.process && command.process !== event.item.processId) throw new Error("Native command process identity changed");
        command.process = event.item.processId;
      }
      command.work.supports_cancel = command.work.background && !!command.process;
      this.#publishCommand(command); return true;
    }
    if (!command || isNativeWorkTerminal(command.work.status)) return true;
    command.work.status = event.item.status === "declined" ? "cancelled" : event.item.status === "failed" || event.item.exitCode != null && event.item.exitCode !== 0 ? "failed" : "completed";
    command.work.supports_cancel = false;
    if (command.work.background && event.item.aggregatedOutput != null && this.start.publishContent)
      command.work.content_ref = this.start.publishContent(event.item.aggregatedOutput);
    this.#publishCommand(command);
    if (!command.work.background) this.#commands.delete(commandKey);
    return true;
  }
  async #cancelCommand(command: Command, signal?: AbortSignal): Promise<void> {
    if (!command.process || isNativeWorkTerminal(command.work.status)) throw new HarnessAdapterError("native_work_owner_unavailable", "Native command has no active process identity.");
    signal?.throwIfAborted();
    let cursor: string | undefined;
    const seen = new Set<string>(); let matched = false;
    do {
      const page = z.object({data: z.array(z.object({processId: identity, itemId: identity, cwd: z.string().min(1).max(4096)})).max(128), nextCursor: identity.nullish()})
        .parse(await this.#request("thread/backgroundTerminals/list", {threadId: command.thread, ...(cursor ? {cursor} : {}), limit: 128}));
      for (const terminal of page.data) if (terminal.processId === command.process) {
        if (terminal.itemId !== command.item || await realpath(terminal.cwd) !== await realpath(this.start.payload.cwd))
          throw new HarnessAdapterError("native_work_binding_unconfirmed", "Native command item or workspace changed.");
        matched = true;
      }
      cursor = page.nextCursor ?? undefined;
      if (cursor && (seen.has(cursor) || seen.size >= 16)) throw new HarnessAdapterError("native_work_inventory_unconfirmed", "Native command inventory is cyclic or exceeds its bound.");
      if (cursor) seen.add(cursor);
    } while (cursor);
    if (!matched) throw new HarnessAdapterError("native_work_turn_unconfirmed", "The original native command is absent from its execution owner's inventory.");
    signal?.throwIfAborted();
    const response = z.object({terminated: z.boolean()}).parse(await this.#request("thread/backgroundTerminals/terminate", {threadId: command.thread, processId: command.process}));
    if (!response.terminated) throw new HarnessAdapterError("native_work_cancel_unknown", "The provider did not confirm native command termination.");
    if (!isNativeWorkTerminal(command.work.status)) {command.work.status = "cancelled"; command.work.supports_cancel = false; this.#publishCommand(command);}
  }
  childOrigin(thread: string, turn: string): {origin_turn_id: string; work_id: string} | undefined {
    const child = this.#children.get(thread);
    return child && child.turn === turn && !this.#lost && !isNativeWorkTerminal(child.work.status)
      ? {origin_turn_id: child.work.origin_turn_id, work_id: child.work.work_id} : undefined;
  }
  async verifyHistoryOwner(work: HarnessNativeWorkRecord, signal: AbortSignal): Promise<string> {
    await this.settled(); signal.throwIfAborted();
    const child = this.#works.get(work.work_id);
    if (this.#lost || this.#stopping || !child || this.#children.get(child.thread) !== child || child.thread !== work.native_reference
      || child.work.origin_turn_id !== work.origin_turn_id || child.work.parent_work_id !== work.parent_work_id)
      throw new HarnessAdapterError("native_work_history_binding", "This native child history has no matching execution owner.");
    const read = childRead.parse(await this.rpc.request("thread/read", {threadId: child.thread, includeTurns: false}, {signal})).thread;
    if (read.id !== child.thread || read.parentThreadId !== child.parent || read.source.subAgent.thread_spawn.parent_thread_id !== child.parent
      || await realpath(read.cwd) !== await realpath(this.start.payload.cwd))
      throw new HarnessAdapterError("native_work_history_binding", "Native child history ancestry or workspace changed.");
    signal.throwIfAborted();
    if (this.#lost || this.#stopping) throw new HarnessAdapterError("native_work_history_unavailable", "The native child history owner was lost.");
    return read.id;
  }
  #buffer(thread: string, message: RpcMessage): void {
    if (this.#pending.size >= 128 && !this.#pending.has(thread)) throw new Error("Unconfirmed native membership limit");
    const messages = this.#pending.get(thread) ?? [];
    if (messages.length >= 256 || messages.reduce((bytes, entry) => bytes + Buffer.byteLength(JSON.stringify(entry)), 0)
      + Buffer.byteLength(JSON.stringify(message)) > 1024 * 1024) throw new Error("Unconfirmed native event limit");
    messages.push(message); this.#pending.set(thread, messages);
  }
  async #replay(thread: string): Promise<void> {
    const messages = this.#pending.get(thread) ?? []; this.#pending.delete(thread);
    for (const message of messages) await this.#observe(message);
  }
  async #observe(message: RpcMessage): Promise<void> {
    if (this.#lost) return;
    const p = z.object({threadId: identity.optional()}).passthrough().safeParse(message.params);
    if (!p.success || !p.data.threadId) return;
    const thread = p.data.threadId;
    const item = (p.data.item as {type?: unknown} | undefined);
    if (this.#rootThreads.has(thread) && ["item/started", "item/completed"].includes(message.method ?? "") && item?.type === "commandExecution") {
      await this.#observeCommand(message, thread); return;
    }
    if ((message.method === "item/started" || message.method === "item/completed") && item?.type === "subAgentActivity") {
      const event = activity.parse(message.params);
      const parent = this.#children.get(thread);
      const origin = this.#roots.get(key(thread, event.turnId)) ?? (parent?.turn === event.turnId
        ? {turn: parent.work.origin_turn_id, parent: parent.work.work_id} : undefined);
      if (!origin) {this.#buffer(thread, message); return;}
      if (event.item.kind !== "started" && event.item.kind !== "interacted") {
        if (!this.#children.has(event.item.agentThreadId)) this.#buffer(event.item.agentThreadId, message);
        return;
      }
      const launch = key(thread, event.item.id);
      if (this.#launches.has(launch)) return;
      const prior = this.#children.get(event.item.agentThreadId);
      if (prior && !isNativeWorkTerminal(prior.work.status)) {
        if (event.item.kind === "started") throw new Error("Native child identity reused while active");
        this.#launches.set(launch, prior); return;
      }
      this.#unconfirmed.add(event.item.agentThreadId);
      const read = childRead.parse(await this.#request("thread/read", {threadId: event.item.agentThreadId, includeTurns: false})).thread;
      if (read.id !== event.item.agentThreadId || read.parentThreadId !== thread || read.source.subAgent.thread_spawn.parent_thread_id !== thread)
        throw new Error("Native child parent is unconfirmed");
      if (await realpath(read.cwd) !== await realpath(this.start.payload.cwd)) throw new Error("Native child left its admitted workspace");
      if (this.#works.size >= 128) throw new Error("Native work registry limit");
      const child: Child = {thread: read.id, parent: thread, launch, work: {work_id: `codex-agent-${randomUUID()}`, native_reference: read.id,
        origin_turn_id: origin.turn, ...(origin.parent ? {parent_work_id: origin.parent} : {}), kind: "agent", background: true,
        status: "running", supports_cancel: false, summary: event.item.agentPath}};
      child.custody = {source: "codex", work_id: child.work.work_id, native_reference: read.id, origin_turn_id: origin.turn,
        ...(origin.parent ? {parent_work_id: origin.parent} : {}), root_native_reference: parent?.custody?.root_native_reference ?? thread,
        parent_native_reference: thread, launch_native_reference: event.item.id};
      this.#children.set(read.id, child); this.#works.set(child.work.work_id, child); this.#launches.set(launch, child);
      this.#unconfirmed.delete(read.id);
      this.#publish(child); await this.#replay(read.id); return;
    }
    const child = this.#children.get(thread);
    if (!child) {
      if (this.#rootThreads.has(thread)) {
        const nativeTurn = typeof p.data.turnId === "string" ? p.data.turnId : (p.data.turn as {id?: unknown} | undefined)?.id;
        if (message.method === "turn/completed") {
          const terminal = z.object({turn:z.object({id:identity,status:z.enum(["completed","interrupted","failed"])})}).parse(message.params);
          this.#activeRoots.delete(key(thread, terminal.turn.id));
          for (const command of this.#commands.values()) if (command.thread === thread && command.turn === terminal.turn.id && !isNativeWorkTerminal(command.work.status)) {
            command.work.background = true; command.work.supports_cancel = !!command.process; this.#publishCommand(command);
          }
        }
        if (typeof nativeTurn === "string" && !this.#roots.has(key(thread, nativeTurn)) &&
          ["turn/started", "turn/completed"].includes(message.method ?? "")) this.#buffer(thread, message);
        return;
      }
      if (["thread/status/changed", "thread/settings/updated", "model/rerouted", "turn/started", "turn/completed", "item/completed"].includes(message.method ?? "")) this.#buffer(thread, message);
      return;
    }
    if (message.method === "thread/settings/updated") {
      const settings = readCodexSettingsNotification(message);
      if (!settings || settings.threadId !== child.thread) throw new Error("Native child settings have invalid ownership");
      if (await realpath(settings.threadSettings.cwd) !== await realpath(this.start.payload.cwd))
        throw new Error("Native child settings left the admitted workspace");
      if (child.work.model !== settings.threadSettings.model) {child.work.model = settings.threadSettings.model; this.#publish(child);}
    } else if (message.method === "model/rerouted") {
      const reroute = binding.extend({fromModel: identity, toModel: identity, reason: z.string().max(2048)}).parse(message.params);
      if (reroute.turnId !== child.turn) throw new Error("Native child model reroute has another execution owner");
      child.work.model = reroute.toModel; this.#publish(child);
      this.start.emitSessionEvent!({event_type: "model.rerouted", turn_id: child.work.origin_turn_id, data: {
        native_work_id: child.work.work_id, from_model: reroute.fromModel, to_model: reroute.toModel, reason: reroute.reason}});
    } else if (message.method === "turn/started") {
      const event = z.object({turn: z.object({id: identity})}).parse(message.params);
      if (isNativeWorkTerminal(child.work.status) || child.turn && child.turn !== event.turn.id) throw new Error("Native child turn lacks an admitted launch");
      child.turn = event.turn.id;
      if (child.custody) child.custody.native_execution_reference = event.turn.id;
      child.work.supports_cancel = true; this.#publish(child);
    } else if (message.method === "thread/status/changed" && !isNativeWorkTerminal(child.work.status)) {
      const event = z.object({status:z.object({type:z.string(),activeFlags:z.array(z.enum(["waitingOnApproval","waitingOnUserInput"])).optional()})}).parse(message.params);
      if (event.status.type === "active") {
        const waiting = event.status.activeFlags?.length;
        const status = waiting ? "waiting" : "running";
        if (child.work.status !== status) {
          child.work.status = status;
          child.work.summary = waiting ? "Waiting for native approval or input" : "Native child work running";
          this.#publish(child);
        }
      }
    } else if (message.method === "item/started" && !isNativeWorkTerminal(child.work.status)) {
      const event = binding.extend({item:z.object({type:z.string().min(1).max(128)})}).parse(message.params);
      if (event.turnId === child.turn) {child.work.summary = `Native ${event.item.type} started`; this.#publish(child);}
    } else if (message.method === "item/completed" && item?.type === "agentMessage") {
      const event = binding.extend({item: z.object({type: z.literal("agentMessage"), text: z.string().max(4 * 1024 * 1024), phase: z.string().nullish()})}).parse(message.params);
      if (event.turnId === child.turn && event.item.phase !== "commentary") child.finalText = event.item.text;
    } else if (message.method === "turn/completed") {
      const event = z.object({turn: z.object({id: identity, status: z.enum(["completed", "interrupted", "failed"]), error: z.unknown().nullish()})}).parse(message.params);
      if (event.turn.id !== child.turn) return;
      const status = event.turn.status === "interrupted" ? "cancelled" : event.turn.status === "failed" || event.turn.error != null ? "failed" : "completed";
      if (isNativeWorkTerminal(child.work.status)) {if (child.work.status !== status) throw new Error("Native terminal work reopened"); return;}
      child.work.status = status; child.work.supports_cancel = false;
      if (child.finalText !== undefined && this.start.publishContent) child.work.content_ref = this.start.publishContent(child.finalText);
      this.#publish(child);
    }
  }
  async cancel(work: HarnessNativeWorkRecord, signal: AbortSignal): Promise<void> {
    await this.settled(); signal.throwIfAborted();
    const command = [...this.#commands.values()].find(value => value.work.work_id === work.work_id);
    if (command) {
      if (command.work.native_reference !== work.native_reference || command.work.origin_turn_id !== work.origin_turn_id || this.#lost || this.#stopping)
        throw new HarnessAdapterError("native_work_owner_unavailable", "The native command execution owner changed.");
      await this.#cancelCommand(command, signal); return;
    }
    const child = this.#works.get(work.work_id);
    if (!child || this.#children.get(child.thread) !== child || child.thread !== work.native_reference || !child.turn || isNativeWorkTerminal(child.work.status))
      throw new HarnessAdapterError("native_work_owner_unavailable", "The admitted native child cancellation owner is unavailable.");
    const turn = child.turn;
    const read = childRead.parse(await this.#request("thread/read", {threadId: child.thread, includeTurns: true})).thread;
    if (await realpath(read.cwd) !== await realpath(this.start.payload.cwd) || read.parentThreadId !== child.parent || read.source.subAgent.thread_spawn.parent_thread_id !== child.parent
      || !read.turns?.some(value => value.id === turn && value.status === "inProgress"))
      throw new HarnessAdapterError("native_work_turn_unconfirmed", "Native child cancellation requires the observed active turn.");
    signal.throwIfAborted();
    z.object({}).strict().parse(await this.#request("turn/interrupt", {threadId: child.thread, turnId: turn}));
    // Acknowledgement is distinct from the later observed terminal work event.
  }
  async stop(): Promise<void> {
    await this.#queue;
    if (this.#lost && !this.busy && !this.#activeRoots.size) {
      this.#closureCertified = true; this.#unsubscribe(); return;
    }
    await this.settled();
    if (this.#pending.size || this.#unconfirmed.size) throw new HarnessAdapterError("native_work_closure_unknown", "Unconfirmed native child membership prevents safe unload.");
    this.#stopping = true;
    try {
      for (const command of this.#commands.values()) if (!isNativeWorkTerminal(command.work.status)) await this.#cancelCommand(command);
      for (const child of this.#children.values()) if (!isNativeWorkTerminal(child.work.status)) {
        if (!child.turn) throw new HarnessAdapterError("native_work_closure_unknown", "Native child has no confirmed interruptible turn.");
        z.object({}).strict().parse(await this.#request("turn/interrupt", {threadId: child.thread, turnId: child.turn}));
      }
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline && this.busy) {await this.settled(); await new Promise(resolve => setTimeout(resolve, 20));}
      await this.settled();
      if (this.busy) throw new HarnessAdapterError("native_work_closure_unknown", "Native children did not provide terminal shutdown proof.");
      for (const threadId of [...this.#children.keys(), ...this.#rootThreads]) {
        z.object({status: z.enum(["unsubscribed", "notSubscribed", "notLoaded"])}).parse(await this.#request("thread/unsubscribe", {threadId}));
      }
      await this.settled();
      if (this.busy) throw new HarnessAdapterError("native_work_closure_unknown", "Native work changed during unload.");
      this.#closureCertified = true;
      this.#unsubscribe();
    } catch (failure) {this.#stopping = false; throw failure;}
  }
}
