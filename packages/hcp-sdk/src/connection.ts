import {uploadHcpInputFile, uploadHcpImageFile, HcpInputFileUploadError, type HcpInputFileUpload, type InputFileUploadOptions} from "./input-files.js";
import {resolveHcpFinalText} from "./final-text.js";
import {projectHcpTextItemsComplete, type TextContentOptions} from "./text-content.js";
import {resolveHcpPortableItem} from "./portable-items.js";
import type {HarnessPortableItemObservation} from "@harness-control/protocol";
import {projectHcpNativeProposalInputsComplete} from "./native-proposal-inputs.js";
import {projectHcpProposedPlansComplete, type ProposedPlanContentOptions} from "./proposed-plans.js";
import {projectHcpNativePlanObservationsComplete, type NativePlanContentOptions} from "./native-plan-observations.js";
import {
  createHcpEnvelope, parseHcpMessage, HcpSessionEventReducer, HcpAccountUsageReducer,
  type HcpMessage, type HcpHostHelloPayload, type HcpHostAcceptedPayload,
  type HcpEventApplyResult, type HcpSnapshotApplyResult, type HcpCommandNackPayload,
  type HarnessContentReference,
  type HcpConversationResultPayload,
  type HcpHarnessEventPayload,
} from "@harness-control/protocol";
import {projectHcpReasoningItemsComplete, type ReasoningContentOptions} from "./reasoning-content.js";
import {resolveHcpHistoryPage, type HistoryContentOptions} from "./history-content.js";
import {readHcpContent, type CompleteContentOptions} from "./content.js";
import { createCommand, parseCommand, type HcpCommand, type HcpCommandType, type HcpCommandResponse, type CommandOptions } from "./commands.js";

export type ReceiveResult =
  | { message: Extract<HcpMessage, { type: "harness.event" }>; reduction: HcpEventApplyResult }
  | { message: Extract<HcpMessage, { type: "harness.session.snapshot" }>; reduction: HcpSnapshotApplyResult }
  | { message: Exclude<HcpMessage, { type: "harness.event" | "harness.session.snapshot" }> };
export type WaitOptions = { timeoutMs?: number; signal?: AbortSignal };
export type SessionEventWaitOptions = WaitOptions & {afterSequence?: number};
export type HcpSessionObservation = {kind: "event"; event: HcpHarnessEventPayload}
  | {kind: "unconfirmed"; reason: "disconnected" | "reconciliation_required"; session_id?: string};
export class HcpSessionEventWaitError extends Error {
  constructor(readonly sessionId: string, readonly reason: "disconnected" | "timeout" | "aborted" | "reconciliation_required") {
    super(`HCP session event wait failed: ${reason}. Waiting does not establish native execution closure.`);
    this.name = "HcpSessionEventWaitError";
  }
}
type EventWaiter = {sessionId: string; afterSequence: number; predicate: (event: HcpHarnessEventPayload) => boolean;
  resolve: (event: HcpHarnessEventPayload) => void; reject: (error: unknown) => void; dispose: () => void};
export type HcpConversationInventory = {history_hash: string; turn_count: number; turn_ids: string[]};
export type ConversationInventoryOptions = WaitOptions & {maxTurns?: number; maxPages?: number; pageSize?: number};
type NativeWorkPage = Extract<NonNullable<HcpConversationResultPayload["work"]>, {action: "read"}>;
export type HcpNativeWorkInventory = Omit<NativeWorkPage, "action" | "next_cursor">;
export type NativeWorkInventoryOptions = WaitOptions & {maxItems?: number; maxPages?: number; pageSize?: number};
export class HcpNativeWorkInventoryError extends Error {
  constructor(readonly reason: "limit" | "snapshot_changed" | "duplicate_work" | "cursor_cycle" | "incomplete") {
    super(`HCP native work inventory failed: ${reason}.`);
    this.name = "HcpNativeWorkInventoryError";
  }
}
export class HcpHistoryInventoryError extends Error {
  constructor(readonly reason: "limit" | "snapshot_changed" | "duplicate_turn" | "cursor_cycle" | "incomplete" | "invalid_turn_id") {
    super(`HCP history inventory failed: ${reason}.`);
    this.name = "HcpHistoryInventoryError";
  }
}
type Pending = {
  command: HcpCommand;
  resolve: (message: HcpMessage) => void;
  reject: (error: Error) => void;
  dispose: () => void;
};

export class HcpOutcomeUnknownError extends Error {
  constructor(readonly command: HcpCommand, reason: string, options?: ErrorOptions) {
    super(`${reason} Outcome of ${command.id} is unknown; reconcile before retrying.`, options);
    this.name = "HcpOutcomeUnknownError";
  }
}
export class HcpCommandRejectedError extends Error {
  constructor(readonly rejection: HcpCommandNackPayload) {
    super(rejection.error.message);
    this.name = "HcpCommandRejectedError";
  }
}

type State = { kind: "awaiting_hello" } | { kind: "awaiting_accept"; hello: HcpHostHelloPayload }
  | { kind: "accepted"; hello: HcpHostHelloPayload } | { kind: "closed" };

/** One authenticated socket. The application owns authentication and durable replay cursors. */
export class HcpHostConnection {
  readonly events: HcpSessionEventReducer;
  readonly accounts: HcpAccountUsageReducer;
  readonly #pending = new Map<string, Pending>();
  readonly #eventWaiters = new Set<EventWaiter>();
  readonly #sessionObservers = new Set<(observation: HcpSessionObservation) => void>();
  #state: State = { kind: "awaiting_hello" };

  constructor(private readonly transport: { send: (message: HcpMessage) => void },
    options: { events?: HcpSessionEventReducer; accounts?: HcpAccountUsageReducer } = {}) {
    this.events = options.events ?? new HcpSessionEventReducer();
    this.accounts = options.accounts ?? new HcpAccountUsageReducer();
  }

  accept(payload: HcpHostAcceptedPayload): void {
    if (this.#state.kind !== "awaiting_accept") throw new Error("Receive and authorize host.hello before accepting.");
    const message = parseHcpMessage(createHcpEnvelope("host.accepted", payload));
    this.#state = { kind: "accepted", hello: this.#state.hello };
    try { this.transport.send(message); }
    catch (error) { this.disconnect(); throw error; }
  }

  receive(input: unknown): ReceiveResult {
    if (this.#state.kind === "closed") throw new Error("Connection is closed.");
    const message = parseHcpMessage(typeof input === "string" ? JSON.parse(input) : input);
    if (message.type === "host.hello") {
      if (this.#state.kind !== "awaiting_hello") throw new Error("Duplicate host.hello on this connection.");
      this.#state = { kind: "awaiting_accept", hello: message.payload };
      return { message };
    }
    if (this.#state.kind !== "accepted") throw new Error("Runner has not been accepted.");
    switch (message.type) {
      case "host.accounts.snapshot": {
        if (message.payload.host_id !== this.#state.hello.host_id) throw new Error("Account snapshot host identity mismatch.");
        const pending = this.#pending.get(message.payload.request_id);
        if (pending?.command.type !== "host.accounts.read") return { message };
        const requested = pending.command.payload.provider_instance_ids;
        if (requested && (requested.length !== message.payload.providers.length || message.payload.providers.some(p => !requested.includes(p.provider_instance_id)))) {
          throw new Error("Account snapshot provider selection mismatch.");
        }
        this.accounts.apply(message.payload);
        this.#settle(message);
        return { message };
      }
      case "host.heartbeat":
        if (message.payload.host_id !== this.#state.hello.host_id) throw new Error("Heartbeat host identity mismatch.");
        return { message };
      case "host.capabilities.updated":
        return { message };
      case "host.replay.unavailable":
        this.#failEventWaiters("reconciliation_required", message.payload.session_id);
        return { message };
      case "harness.event": {
        const reduction = this.events.applyEvent(message.payload);
        if (reduction.outcome === "applied") this.#observeEvent(message.payload);
        else if (reduction.outcome !== "duplicate") this.#failEventWaiters("reconciliation_required", message.payload.session_id);
        return {message, reduction};
      }
      case "harness.session.snapshot": {
        const reduction = this.events.applySnapshot(message.payload);
        this.#settle(message);
        if (reduction.outcome === "applied") {
          for (const event of this.events.events()) if (event.session_id === message.payload.session_id) this.#observeEvent(event);
        } else this.#failEventWaiters("reconciliation_required", message.payload.session_id);
        return { message, reduction };
      }
      case "hcp.command.ack":
      case "hcp.command.nack":
      case "host.workspaces.result":
      case "harness.conversation.result":
      case "local.action.response":
      case "local.action.error":
        this.#settle(message);
        return { message };
      default: throw new Error(`Not a runner-to-app message: ${message.type}`);
    }
  }

  send<C extends HcpCommand>(input: C, options: WaitOptions = {}): Promise<HcpCommandResponse<C["type"]>> {
    const command = parseCommand(input);
    if (this.#state.kind !== "accepted") throw new Error("Runner is not connected and accepted.");
    options.signal?.throwIfAborted();
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new Error("Invalid command timeout.");
    if (this.#pending.size >= 256) throw new Error("Too many pending HCP requests.");
    if (this.#pending.has(command.id)) throw new Error("Command is already pending.");
    if (command.type === "local.action.request" && [...this.#pending.values()].some(p =>
      p.command.type === "local.action.request" && p.command.payload.request_id === command.payload.request_id)) {
      throw new Error("Local action request is already pending.");
    }
    return new Promise<HcpCommandResponse<C["type"]>>((resolve, reject) => {
      const fail = (reason: string, cause?: unknown): void => {
        this.#pending.get(command.id)?.dispose();
        this.#pending.delete(command.id);
        reject(new HcpOutcomeUnknownError(command, reason, { cause }));
      };
      const timer = setTimeout(() => fail("Timed out waiting for the runner."), timeoutMs);
      const abort = (): void => fail("Stopped waiting for the runner.");
      this.#pending.set(command.id, {
        command, resolve: response => resolve(response as HcpCommandResponse<C["type"]>), reject,
        dispose: () => { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); },
      });
      options.signal?.addEventListener("abort", abort, { once: true });
      try { this.transport.send(command); }
      catch (error) { fail("Sending to the runner failed.", error); }
    });
  }

  disconnect(): void {
    this.#state = { kind: "closed" };
    for (const pending of this.#pending.values()) {
      pending.dispose();
      pending.reject(new HcpOutcomeUnknownError(pending.command, "Runner disconnected."));
    }
    this.#pending.clear();
    this.#failEventWaiters("disconnected");
    this.#sessionObservers.clear();
  }

  /** Committed session observations and lost continuity; callback failures detach only that observer. */
  subscribeSessionObservations(observer: (observation: HcpSessionObservation) => void): () => void {
    if (this.#sessionObservers.size >= 128) throw new Error("Too many HCP session observers.");
    this.#sessionObservers.add(observer);return () => {this.#sessionObservers.delete(observer);};
  }
  #notifySessionObservers(observation: HcpSessionObservation): void {
    for (const observer of this.#sessionObservers) {
      try {observer(structuredClone(observation));} catch {this.#sessionObservers.delete(observer);}
    }
  }
  /** Register before dispatch to observe native proof independently of command acceptance. No implicit mutation or retry. */
  waitForSessionEvent(sessionId: string, predicate: (event: HcpHarnessEventPayload) => boolean,
    options: SessionEventWaitOptions = {}): Promise<HcpHarnessEventPayload> {
    if (this.#state.kind !== "accepted") throw new Error("Runner is not connected and accepted.");
    options.signal?.throwIfAborted();
    const timeoutMs = options.timeoutMs ?? 30_000;
    const afterSequence = options.afterSequence ?? this.events.events().reduce((last, event) => event.session_id === sessionId ? Math.max(last, event.sequence) : last, 0);
    if (!sessionId || sessionId.length > 512 || !Number.isSafeInteger(afterSequence) || afterSequence < 0
        || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new Error("Invalid session event wait.");
    if (this.#eventWaiters.size >= 256) throw new Error("Too many pending HCP event waits.");
    return new Promise((resolve, reject) => {
      const finish = (error: unknown) => {waiter.dispose();this.#eventWaiters.delete(waiter);reject(error);};
      const abort = () => finish(new HcpSessionEventWaitError(sessionId, "aborted"));
      const timer = setTimeout(() => finish(new HcpSessionEventWaitError(sessionId, "timeout")), timeoutMs);
      const waiter: EventWaiter = {sessionId, afterSequence, predicate, resolve, reject,
        dispose: () => {clearTimeout(timer);options.signal?.removeEventListener("abort", abort);}};
      this.#eventWaiters.add(waiter);options.signal?.addEventListener("abort", abort, {once: true});
      // Explicit replay can satisfy the wait; the default boundary observes only subsequent events.
      if (options.afterSequence !== undefined)
        for (const event of this.events.events()) this.#observeEvent(event, waiter);
    });
  }
  #observeEvent(event: HcpHarnessEventPayload, only?: EventWaiter): void {
    if (!only) this.#notifySessionObservers({kind: "event", event});
    for (const waiter of only ? [only] : this.#eventWaiters) {
      if (!this.#eventWaiters.has(waiter) || waiter.sessionId !== event.session_id || event.sequence <= waiter.afterSequence) continue;
      try {
        if (!waiter.predicate(structuredClone(event))) continue;
        waiter.dispose();this.#eventWaiters.delete(waiter);waiter.resolve(structuredClone(event));
      } catch (error) {waiter.dispose();this.#eventWaiters.delete(waiter);waiter.reject(error);}
    }
  }
  #failEventWaiters(reason: HcpSessionEventWaitError["reason"], sessionId?: string): void {
    if (reason === "disconnected" || reason === "reconciliation_required") this.#notifySessionObservers({kind: "unconfirmed", reason,
      ...(sessionId === undefined ? {} : {session_id: sessionId})});
    for (const waiter of this.#eventWaiters) if (sessionId === undefined || waiter.sessionId === sessionId) {
      waiter.dispose();this.#eventWaiters.delete(waiter);waiter.reject(new HcpSessionEventWaitError(waiter.sessionId, reason));
    }
  }

  #settle(message: HcpMessage): void {
    let pending: Pending | undefined;
    if (message.type === "hcp.command.ack" || message.type === "hcp.command.nack") {
      pending = this.#pending.get(message.payload.command_id);
      if (message.type === "hcp.command.ack" && pending && ["host.accounts.read", "host.workspaces.request", "harness.session.snapshot.request", "harness.conversation.request", "local.action.request"].includes(pending.command.type)) return;
    } else if (message.type === "harness.conversation.result") {
      pending = this.#pending.get(message.payload.command_id);
      if (pending?.command.type !== "harness.conversation.request"
        || pending.command.payload.session_id !== message.payload.session_id
        || pending.command.payload.operation.kind !== message.payload.operation) return;
      const operation = pending.command.payload.operation;
      if (operation.kind === "inject" && message.payload.injection?.outcome === "applied" &&
          message.payload.injection.message_count !== operation.messages.length) return;
      if (operation.kind === "steer" && operation.turn_id !== message.payload.turn_id) return;
      if (operation.kind === "goal" && (!message.payload.goal || message.payload.goal.action !== operation.action
        || operation.action !== "read" && (message.payload.goal.action === "read"
          || message.payload.goal.target_native_created_at !== operation.expected_native_created_at))) return;
      if (operation.kind === "feedback" && (!message.payload.feedback
        || message.payload.feedback.classification !== operation.classification
        || message.payload.feedback.diagnostics_requested !== operation.include_diagnostics)) return;
      if (operation.kind === "input_file") {
        const request = operation.request, file = message.payload.input_file;
        if (!file || file.action !== request.action) return;
        if (request.action === "create") {
          if (file.reference.sha256 !== request.sha256 || file.reference.filename !== request.filename ||
            file.reference.mime_type !== request.mime_type || file.reference.byte_length !== request.byte_length) return;
        } else if (file.reference.file_id !== request.file_id) return;
        if (request.action === "append") {
          const size = request.data_base64.length / 4 * 3 - (request.data_base64.endsWith("==") ? 2 : request.data_base64.endsWith("=") ? 1 : 0);
          if (file.received_bytes < request.offset + size) return;
        }
      }
      if (operation.kind === "content" && (operation.content_id !== message.payload.content?.reference.content_id
        || operation.offset !== message.payload.content?.offset)) return;
      if (operation.kind === "fork" && (operation.target_session_id !== message.payload.fork?.session_id
        || operation.continuation_group_key !== message.payload.fork?.continuation_group_key)) return;
      if (operation.kind === "work" && (operation.action !== message.payload.work?.action
        || (operation.action !== "read" && (message.payload.work?.action === "read" || operation.work_id !== message.payload.work?.work_id)))) return;
      if (operation.kind === "work" && operation.action === "history"
        && (message.payload.work?.action !== "history" || message.payload.work.revision !== operation.expected_revision
          || message.payload.work.owner_status !== (operation.owner === "retained" ? "retained" : "active"))) return;
      if (operation.kind === "work" && operation.action === "fork"
        && (message.payload.work?.action !== "fork" || message.payload.work.revision !== operation.expected_revision
          || message.payload.work.fork.session_id !== operation.target_session_id
          || message.payload.work.fork.continuation_group_key !== operation.continuation_group_key)) return;
      if (operation.kind === "work" && operation.action === "reconcile"
        && (message.payload.work?.action !== "reconcile" || message.payload.work.revision !== operation.expected_revision + 1)) return;
    } else if (message.type === "host.accounts.snapshot") {
      pending = this.#pending.get(message.payload.request_id);
      if (pending?.command.type !== "host.accounts.read") return;
    } else if (message.type === "local.action.response" || message.type === "local.action.error") {
      pending = [...this.#pending.values()].find(p => p.command.type === "local.action.request"
        && p.command.payload.request_id === message.payload.request_id && p.command.payload.action === message.payload.action);
    } else if (message.type === "host.workspaces.result" || message.type === "harness.session.snapshot") {
      pending = this.#pending.get(message.type === "host.workspaces.result" ? message.payload.request_id : message.payload.command_id);
      if (pending && (message.type === "host.workspaces.result" ? pending.command.type !== "host.workspaces.request"
        : pending.command.type !== "harness.session.snapshot.request" || pending.command.payload.session_id !== message.payload.session_id)) return;
    }
    if (!pending) return;
    pending.dispose();
    this.#pending.delete(pending.command.id);
    if (message.type === "hcp.command.nack") pending.reject(new HcpCommandRejectedError(message.payload));
    else pending.resolve(message);
  }

  startSession(payload: Payload<"harness.session.start">, command?: CommandOptions, wait?: WaitOptions) {
    return this.send(createCommand({ type: "harness.session.start", payload }, command), wait);
  }
  sendTurn(payload: Payload<"harness.turn.send">, command?: CommandOptions, wait?: WaitOptions) {
    return this.send(createCommand({ type: "harness.turn.send", payload }, command), wait);
  }
  cancelTurn(payload: Payload<"harness.turn.cancel">, command?: CommandOptions, wait?: WaitOptions) {
    return this.send(createCommand({ type: "harness.turn.cancel", payload }, command), wait);
  }
  stopSession(payload: Payload<"harness.session.stop">, command?: CommandOptions, wait?: WaitOptions) {
    return this.send(createCommand({ type: "harness.session.stop", payload }, command), wait);
  }
  requestSnapshot(payload: Payload<"harness.session.snapshot.request">, command?: CommandOptions, wait?: WaitOptions) {
    return this.send(createCommand({ type: "harness.session.snapshot.request", payload }, command), wait);
  }
  conversation(payload: Payload<"harness.conversation.request">, command?: CommandOptions, wait?: WaitOptions) {
    return this.send(createCommand({ type: "harness.conversation.request", payload }, command), wait);
  }
  inputFile(sessionId: string, request: Extract<Payload<"harness.conversation.request">["operation"], {kind: "input_file"}>["request"],
    command?: CommandOptions, wait?: WaitOptions) {
    return this.conversation({session_id: sessionId, operation: {kind: "input_file", request}}, command, wait);
  }
  uploadInputFile(sessionId: string, input: HcpInputFileUpload, options: InputFileUploadOptions = {}) {
    return uploadHcpInputFile(input, async (request, wait) => {
      const result = await this.inputFile(sessionId, request, undefined, wait);
      if (!result.payload.input_file) throw new HcpInputFileUploadError("unconfirmed", request.action);
      return result.payload.input_file;
    }, options);
  }
  uploadImageFile(sessionId: string, input: HcpInputFileUpload, options: InputFileUploadOptions = {}) {
    return uploadHcpImageFile(input, async (request, wait) => {
      const result = await this.inputFile(sessionId, request, undefined, wait);
      if (!result.payload.input_file) throw new HcpInputFileUploadError("unconfirmed", request.action);
      return result.payload.input_file;
    }, options);
  }
  readConversation(sessionId: string, page: {cursor?: string; limit?: number} = {}, command?: CommandOptions, wait?: WaitOptions) {
    return this.conversation({session_id: sessionId, operation: {kind: "read", ...page}}, command, wait);
  }
  readFinalTextComplete(sessionId: string, output: Parameters<typeof resolveHcpFinalText>[0], options: CompleteContentOptions = {}) {
    return resolveHcpFinalText(output, (reference, wait) => this.readContentComplete(sessionId, reference, wait), options);
  }
  readTextItemsComplete(sessionId: string, events: readonly unknown[], origin?: string, options: TextContentOptions = {}) {
    return projectHcpTextItemsComplete(events, sessionId, origin, (reference, wait) => this.readContentComplete(sessionId, reference, wait), options);
  }
  readPortableItemComplete(sessionId: string, observation: HarnessPortableItemObservation, options: HistoryContentOptions = {}) {
    return resolveHcpPortableItem(observation, (reference, wait) => this.readContentComplete(sessionId, reference, wait), options);
  }
  async readConversationPageComplete(sessionId: string, page: {cursor?: string; limit?: number} = {}, options: HistoryContentOptions = {}) {
    const result = await this.readConversation(sessionId, page, undefined, options);
    if (!result.payload.history) throw new HcpHistoryInventoryError("incomplete");
    return resolveHcpHistoryPage(result.payload.history, (reference, wait) => this.readContentComplete(sessionId, reference, wait), options);
  }
  /** Complete chronological native boundaries, without claiming referenced/previewed content is complete. */
  async readConversationInventory(sessionId: string, options: ConversationInventoryOptions = {}): Promise<HcpConversationInventory> {
    const maxTurns = options.maxTurns ?? 10_000, maxPages = options.maxPages ?? 1024, pageSize = options.pageSize ?? 100;
    for (const [value, maximum] of [[maxTurns, 10_000], [maxPages, 1024], [pageSize, 100]] as const)
      if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new HcpHistoryInventoryError("limit");
    const pages: string[][] = [], ids = new Set<string>(), cursors = new Set<string>();
    let cursor: string | undefined, snapshot: {history_hash: string; turn_count: number} | undefined;
    for (let index = 0; index < maxPages; index++) {
      const result = await this.readConversation(sessionId, {limit: pageSize, ...(cursor ? {cursor} : {})}, undefined,
        {...(options.signal ? {signal: options.signal} : {}), ...(options.timeoutMs === undefined ? {} : {timeoutMs: options.timeoutMs})});
      const history = result.payload.history;
      if (!history) throw new HcpHistoryInventoryError("incomplete");
      if (history.turn_count > maxTurns) throw new HcpHistoryInventoryError("limit");
      snapshot ??= {history_hash: history.history_hash, turn_count: history.turn_count};
      if (history.history_hash !== snapshot.history_hash || history.turn_count !== snapshot.turn_count)
        throw new HcpHistoryInventoryError("snapshot_changed");
      if (!history.turns.length && (history.next_cursor || snapshot.turn_count)) throw new HcpHistoryInventoryError("incomplete");
      pages.push(history.turns.map(turn => {
        if (!turn.id || turn.id.length > 512) throw new HcpHistoryInventoryError("invalid_turn_id");
        if (ids.has(turn.id)) throw new HcpHistoryInventoryError("duplicate_turn");
        ids.add(turn.id); return turn.id;
      }));
      if (ids.size > snapshot.turn_count) throw new HcpHistoryInventoryError("incomplete");
      if (!history.next_cursor) {
        if (ids.size !== snapshot.turn_count) throw new HcpHistoryInventoryError("incomplete");
        return {...snapshot, turn_ids: pages.reverse().flat()};
      }
      if (cursors.has(history.next_cursor)) throw new HcpHistoryInventoryError("cursor_cycle");
      cursors.add(history.next_cursor); cursor = history.next_cursor;
    }
    throw new HcpHistoryInventoryError("limit");
  }
  submitNativeFeedback(sessionId: string, feedback: Omit<Extract<Payload<"harness.conversation.request">["operation"], {kind: "feedback"}>, "kind">,
    command?: CommandOptions, wait?: WaitOptions) {
    return this.conversation({session_id: sessionId, operation: {...feedback, kind: "feedback"}}, command, wait);
  }
  updateNativePolicy(sessionId: string, policy: Omit<Extract<Payload<"harness.conversation.request">["operation"], {kind: "policy"}>, "kind">,
    command?: CommandOptions, wait?: WaitOptions) {
    return this.conversation({session_id: sessionId, operation: {...policy, kind: "policy"}}, command, wait);
  }
  forkConversation(sessionId: string, fork: Omit<Extract<Payload<"harness.conversation.request">["operation"], {kind: "fork"}>, "kind">,
    command?: CommandOptions, wait?: WaitOptions) {
    return this.conversation({session_id: sessionId, operation: {kind: "fork", ...fork}}, command, wait);
  }
  rollbackConversation(sessionId: string, rollback: Omit<Extract<Payload<"harness.conversation.request">["operation"], {kind: "rollback"}>, "kind">,
    command?: CommandOptions, wait?: WaitOptions) {
    return this.conversation({session_id: sessionId, operation: {kind: "rollback", ...rollback}}, command, wait);
  }
  retireConversation(sessionId: string, command?: CommandOptions, wait?: WaitOptions) {
    return this.conversation({session_id: sessionId, operation: {kind: "retire"}}, command, wait);
  }
  injectContext(sessionId: string, injection: Omit<Extract<Payload<"harness.conversation.request">["operation"], {kind: "inject"}>, "kind">,
    command?: CommandOptions, wait?: WaitOptions) {
    return this.conversation({session_id: sessionId, operation: {kind: "inject", ...injection}}, command, wait);
  }
  steerTurn(sessionId: string, turnId: string, input: string, command?: CommandOptions, wait?: WaitOptions) {
    return this.conversation({session_id: sessionId, operation: {kind: "steer", turn_id: turnId, input}}, command, wait);
  }
  compactConversation(sessionId: string, turnId: string, command?: CommandOptions, wait?: WaitOptions) {
    return this.sendTurn({session_id: sessionId, turn_id: turnId, action: "compact", input: ""}, command, wait);
  }
  /** The command ACK is acceptance; native goal/phase ownership arrives in correlated events. */
  startNativeGoal(sessionId: string, turnId: string,
    goal: Omit<Extract<NonNullable<Payload<"harness.turn.send">["goal"]>, {action: "start"}>, "action">,
    input = goal.objective, command?: CommandOptions, wait?: WaitOptions) {
    return this.sendTurn({session_id: sessionId, turn_id: turnId, input, goal: {...goal, action: "start"}}, command, wait);
  }
  resumeNativeGoal(sessionId: string, turnId: string, nativeCreatedAt: number, command?: CommandOptions, wait?: WaitOptions) {
    return this.sendTurn({session_id: sessionId, turn_id: turnId, input: "", goal: {action: "resume", expected_native_created_at: nativeCreatedAt}}, command, wait);
  }
  readNativeGoal(sessionId: string, command?: CommandOptions, wait?: WaitOptions) {
    return this.conversation({session_id: sessionId, operation: {kind: "goal", action: "read"}}, command, wait);
  }
  pauseNativeGoal(sessionId: string, nativeCreatedAt: number, command?: CommandOptions, wait?: WaitOptions) {
    return this.conversation({session_id: sessionId, operation: {kind: "goal", action: "pause", expected_native_created_at: nativeCreatedAt}}, command, wait);
  }
  clearNativeGoal(sessionId: string, nativeCreatedAt: number, command?: CommandOptions, wait?: WaitOptions) {
    return this.conversation({session_id: sessionId, operation: {kind: "goal", action: "clear", expected_native_created_at: nativeCreatedAt}}, command, wait);
  }
  readContent(sessionId: string, contentId: string, offset = 0, limit = 64 * 1024, command?: CommandOptions, wait?: WaitOptions) {
    return this.conversation({session_id: sessionId, operation: {kind: "content", content_id: contentId, offset, limit}}, command, wait);
  }
  /** Native plan/todo observations retain source semantics; tool-input plans are not effective native todo state. */
  readNativeProposalInputsComplete(sessionId: string, inputs: readonly unknown[], origin?: string, options: ProposedPlanContentOptions = {}) {
    return projectHcpNativeProposalInputsComplete(inputs, sessionId, origin,
      (reference, readOptions) => this.readContentComplete(sessionId, reference, readOptions), options);
  }

  readProposedPlansComplete(sessionId: string, inputs: readonly unknown[], origin?: string, options: ProposedPlanContentOptions = {}) {
    return projectHcpProposedPlansComplete(inputs, sessionId, origin,
      (reference, readOptions) => this.readContentComplete(sessionId, reference, readOptions), options);
  }

  readNativePlanObservationsComplete(sessionId: string, inputs: readonly unknown[], origin?: string, options: NativePlanContentOptions = {}) {
    return projectHcpNativePlanObservationsComplete(inputs, sessionId, origin,
      (reference, wait) => this.readContentComplete(sessionId, reference, wait), options);
  }
  /** Complete native reasoning bodies, preserving the event evidence separately from decoded content. */
  readReasoningItemsComplete(sessionId: string, inputs: readonly unknown[], origin?: string, options: ReasoningContentOptions = {}) {
    return projectHcpReasoningItemsComplete(inputs, sessionId, origin,
      (reference, wait) => this.readContentComplete(sessionId, reference, wait), options);
  }
  /** Fetch and integrity-check the complete retained object, without retrying or treating previews as full content. */
  readContentComplete(sessionId: string, reference: HarnessContentReference, options: CompleteContentOptions = {}) {
    const captured = {...reference};
    return readHcpContent(captured, async (offset, limit, wait) => {
      const result = await this.readContent(sessionId, captured.content_id, offset, limit, undefined, wait);
      if (!result.payload.content) throw new Error("The HCP content result omitted its required chunk.");
      return result.payload.content;
    }, options);
  }
  readNativeWork(sessionId: string, options: {cursor?: string; limit?: number} = {}, command?: CommandOptions, wait?: WaitOptions) {
    return this.conversation({session_id: sessionId, operation: {kind: "work", action: "read", ...options}}, command, wait);
  }
  /** One stable retained roster. Neither an empty roster nor unavailable owners prove native execution closure. */
  async readNativeWorkInventory(sessionId: string, options: NativeWorkInventoryOptions = {}): Promise<HcpNativeWorkInventory> {
    const maxItems = options.maxItems ?? 128, maxPages = options.maxPages ?? 128, pageSize = options.pageSize ?? 32;
    for (const [value, maximum] of [[maxItems, 128], [maxPages, 128], [pageSize, 32]] as const)
      if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new HcpNativeWorkInventoryError("limit");
    const items: NativeWorkPage["items"] = [], ids = new Set<string>(), cursors = new Set<string>();
    let cursor: string | undefined, snapshot: Omit<HcpNativeWorkInventory, "items"> | undefined;
    for (let index = 0; index < maxPages; index++) {
      options.signal?.throwIfAborted();
      const result = await this.readNativeWork(sessionId, {limit: pageSize, ...(cursor ? {cursor} : {})}, undefined, options);
      const page = result.payload.work;
      if (page?.action !== "read") throw new HcpNativeWorkInventoryError("incomplete");
      if (page.total_count > maxItems) throw new HcpNativeWorkInventoryError("limit");
      snapshot ??= {observation_hash: page.observation_hash, total_count: page.total_count, owner_status: page.owner_status,
        ...(page.closure_unconfirmed ? {closure_unconfirmed: true} : {})};
      if (page.observation_hash !== snapshot.observation_hash || page.total_count !== snapshot.total_count
          || page.owner_status !== snapshot.owner_status || page.closure_unconfirmed !== snapshot.closure_unconfirmed)
        throw new HcpNativeWorkInventoryError("snapshot_changed");
      if (!page.items.length && (page.next_cursor || page.total_count)) throw new HcpNativeWorkInventoryError("incomplete");
      for (const row of page.items) {
        if (ids.has(row.work.work_id)) throw new HcpNativeWorkInventoryError("duplicate_work");
        ids.add(row.work.work_id); items.push(row);
      }
      if (items.length > snapshot.total_count) throw new HcpNativeWorkInventoryError("incomplete");
      if (!page.next_cursor) {
        if (items.length !== snapshot.total_count) throw new HcpNativeWorkInventoryError("incomplete");
        return {...snapshot, items};
      }
      if (cursors.has(page.next_cursor)) throw new HcpNativeWorkInventoryError("cursor_cycle");
      cursors.add(page.next_cursor); cursor = page.next_cursor;
    }
    throw new HcpNativeWorkInventoryError("limit");
  }
  cancelNativeWork(sessionId: string, workId: string, expectedRevision: number, command?: CommandOptions, wait?: WaitOptions) {
    return this.conversation({session_id: sessionId, operation: {kind: "work", action: "cancel", work_id: workId, expected_revision: expectedRevision}}, command, wait);
  }
  readNativeWorkHistory(sessionId: string, workId: string, expectedRevision: number, page: {cursor?: string; limit?: number} = {}, command?: CommandOptions, wait?: WaitOptions) {
    return this.conversation({session_id: sessionId, operation: {kind: "work", action: "history", work_id: workId, expected_revision: expectedRevision, ...page}}, command, wait);
  }
  readRetainedNativeWorkHistory(sessionId: string, workId: string, expectedRevision: number, page: {cursor?: string; limit?: number} = {}, command?: CommandOptions, wait?: WaitOptions) {
    return this.conversation({session_id: sessionId, operation: {kind: "work", action: "history", owner: "retained", work_id: workId, expected_revision: expectedRevision, ...page}}, command, wait);
  }
  /** Hydrate a custody-checked child history page without upgrading its native fidelity or owner availability. */
  async readNativeWorkHistoryPageComplete(sessionId: string, workId: string, expectedRevision: number,
    page: {cursor?: string; limit?: number} = {}, options: HistoryContentOptions & {owner?: "live" | "retained"} = {}) {
    const result = options.owner === "retained"
      ? await this.readRetainedNativeWorkHistory(sessionId, workId, expectedRevision, page, undefined, options)
      : await this.readNativeWorkHistory(sessionId, workId, expectedRevision, page, undefined, options);
    const work = result.payload.work;
    if (work?.action !== "history") throw new HcpNativeWorkInventoryError("incomplete");
    const {history, ...proof} = work;
    return {work: proof, history: await resolveHcpHistoryPage(history,
      (reference, wait) => this.readContentComplete(sessionId, reference, wait), options)};
  }
  forkNativeWork(sessionId: string, fork: Omit<Extract<Payload<"harness.conversation.request">["operation"], {action: "fork"}>, "kind" | "action">,
    command?: CommandOptions, wait?: WaitOptions) {
    return this.conversation({session_id: sessionId, operation: {kind: "work", action: "fork", ...fork}}, command, wait);
  }
  retireNativeWork(sessionId: string, workId: string, expectedRevision: number, command?: CommandOptions, wait?: WaitOptions) {
    return this.conversation({session_id: sessionId, operation: {kind: "work", action: "retire", work_id: workId, expected_revision: expectedRevision}}, command, wait);
  }
  reconcileNativeWork(sessionId: string, workId: string, expectedRevision: number, command?: CommandOptions, wait?: WaitOptions) {
    return this.conversation({session_id: sessionId, operation: {kind: "work", action: "reconcile", work_id: workId, expected_revision: expectedRevision}}, command, wait);
  }
  respondToApproval(payload: Payload<"harness.approval.respond">, command?: CommandOptions, wait?: WaitOptions) {
    return this.send(createCommand({ type: "harness.approval.respond", payload }, command), wait);
  }
  respondToInput(payload: Payload<"harness.input.respond">, command?: CommandOptions, wait?: WaitOptions) {
    return this.send(createCommand({ type: "harness.input.respond", payload }, command), wait);
  }
  detachTools(payload: Payload<"tool_servers.detach">, command?: CommandOptions, wait?: WaitOptions) {
    return this.send(createCommand({ type: "tool_servers.detach", payload }, command), wait);
  }
  runLocalAction(payload: Payload<"local.action.request">, command?: CommandOptions, wait?: WaitOptions) {
    return this.send(createCommand({ type: "local.action.request", payload }, command), wait);
  }
  readAccounts(payload: Payload<"host.accounts.read"> = {}, command?: CommandOptions, wait?: WaitOptions) {
    if (this.#state.kind !== "accepted" || !this.#state.hello.capabilities.includes("account_usage")) throw new Error("Runner does not advertise account usage reads.");
    return this.send(createCommand({ type: "host.accounts.read", payload }, command), { timeoutMs: 150_000, ...wait });
  }
  manageWorkspaces(payload: Payload<"host.workspaces.request">, command?: CommandOptions, wait?: WaitOptions) {
    return this.send(createCommand({ type: "host.workspaces.request", payload }, command), wait);
  }
}
type Payload<T extends HcpCommandType> = Extract<HcpCommand, { type: T }>["payload"];
