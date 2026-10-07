import type {HcpHarnessEventPayload, HcpSessionStartPayload} from "@harness-control/protocol";
import {createCommand} from "./commands.js";
import {HcpCommandRejectedError, HcpOutcomeUnknownError, type HcpHostConnection, type WaitOptions} from "./connection.js";

export type HcpNativeSessionState = {payload: HcpSessionStartPayload;
  phase: "opening" | "reserved" | "active" | "closing" | "closed" | "unconfirmed";
  close_attempted?: true; configured?: HcpHarnessEventPayload; exited?: HcpHarnessEventPayload};
export class HcpNativeSessionError extends Error {
  constructor(readonly session_id: string, readonly operation: "open" | "close",
    readonly outcome: "not_sent" | "unknown" | "rejected" | "unconfirmed", cause: unknown) {
    super(`Native session ${operation} has ${outcome} outcome.`, {cause});this.name = "HcpNativeSessionError";
  }
}
class NotSent extends Error {}
type Attempt = {claim: () => void; check: () => void};
const ready = (event: HcpHarnessEventPayload, profile: string) => {
  const data = event.data as {native_conversation_ready?: boolean; native_reference?: string; execution_profile?: string};
  return event.event_type === "session.configured" && data.execution_profile === profile
    && data.native_conversation_ready === true && typeof data.native_reference === "string";
};

/** Physical generations never reuse an uncertain continuation owner or replay an unknown unload. */
export class HcpNativeSessions {
  readonly #records = new Map<string, HcpNativeSessionState>();
  readonly #mutations = new Map<string, symbol>();
  readonly #positions = new Map<string, number>();
  readonly #unsubscribe: () => void;
  #disposed = false;
  constructor(readonly connection: HcpHostConnection) {
    this.#unsubscribe = connection.subscribeSessionObservations(observation => {
      if (observation.kind === "event") this.#observe(observation.event);
      else for (const [id, record] of this.#records) if ((!observation.session_id || observation.session_id === id) && record.phase !== "closed") {
        record.phase = "unconfirmed";this.#mutations.delete(id);
      }
    });
  }
  state(sessionId: string): HcpNativeSessionState | undefined {
    const record = this.#records.get(sessionId);return record ? structuredClone(record) : undefined;
  }
  /** Detaches observation and fences outstanding generations; it never sends stop or cancellation. */
  dispose(): void {
    this.#disposed = true;this.#unsubscribe();this.#mutations.clear();
    for (const record of this.#records.values()) if (record.phase !== "closed") record.phase = "unconfirmed";
  }
  #observe(event: HcpHarnessEventPayload): void {
    const record = this.#records.get(event.session_id);
    if (!record || record.phase === "closed" || event.sequence <= (this.#positions.get(event.session_id) ?? 0)) return;
    this.#positions.set(event.session_id, event.sequence);
    if (event.event_type === "session.exited" && record.phase !== "closing") {
      record.phase = "unconfirmed";this.#mutations.delete(event.session_id);return;
    }
    if ((record.phase === "reserved" || record.phase === "active") && ready(event, record.payload.execution_profile!)) {
      const currentNative = record.configured?.data as {native_reference?: string} | undefined;
      const nextNative = event.data as {native_reference?: string};
      if (record.payload.expected_native_reference && record.payload.expected_native_reference !== nextNative.native_reference
        || record.phase === "active" && currentNative?.native_reference !== nextNative.native_reference) {
        record.phase = "unconfirmed"; this.#mutations.delete(event.session_id); return;
      }
      record.configured = structuredClone(event);record.phase = "active";
    }
    if (event.event_type === "native.work.owner_lost" && record.phase !== "closing") {
      record.phase = "unconfirmed";this.#mutations.delete(event.session_id);
    }
  }
  async #operation(sessionId: string, operation: "open" | "close", options: WaitOptions,
    perform: (signal: AbortSignal, attempt: Attempt) => Promise<HcpNativeSessionState>): Promise<HcpNativeSessionState> {
    const token = Symbol(), signal = options.signal ?? new AbortController().signal;let claimed = false;
    const fence = () => {
      if (!claimed || this.#mutations.get(sessionId) !== token) return;
      const record = this.#records.get(sessionId);if (record && record.phase !== "closed") record.phase = "unconfirmed";
      this.#mutations.delete(sessionId);
    };
    signal.addEventListener("abort", fence, {once: true});
    try {
      if (this.#disposed) throw new NotSent("Native session registry was disposed.");
      signal.throwIfAborted();
      return await perform(signal, {claim: () => {claimed = true;this.#mutations.set(sessionId, token);},
        check: () => {signal.throwIfAborted();if (this.#mutations.get(sessionId) !== token) throw new Error("Native control lost commit authority.");}});
    } catch (cause) {
      fence();throw new HcpNativeSessionError(sessionId, operation, cause instanceof HcpCommandRejectedError ? "rejected"
        : cause instanceof HcpOutcomeUnknownError ? "unknown" : cause instanceof NotSent || !claimed ? "not_sent" : "unconfirmed", cause);
    } finally {signal.removeEventListener("abort", fence);if (this.#mutations.get(sessionId) === token) this.#mutations.delete(sessionId);}
  }
  open(input: HcpSessionStartPayload, options: WaitOptions & {readiness?: "configured" | "conversation"} = {}): Promise<HcpNativeSessionState> {
    return this.#operation(input.session_id, "open", options, async (signal, attempt) => {
      if (!input.execution_profile || input.first_turn || options.readiness !== undefined && !["configured", "conversation"].includes(options.readiness))
        throw new NotSent("Ownership requires explicit no-model startup and declared readiness semantics.");
      if (this.#records.has(input.session_id) || this.#records.size >= 4096) throw new NotSent("Physical generation is reused or the registry is full.");
      if (input.continuation_group_key && [...this.#records.values()].some(record => record.payload.continuation_group_key === input.continuation_group_key && record.phase !== "closed"))
        throw new NotSent("The continuation group still has an unresolved physical generation.");
      const payload = structuredClone(input), command = createCommand({type: "harness.session.start", payload});
      const record: HcpNativeSessionState = {payload, phase: "opening"};this.#records.set(payload.session_id, record);attempt.claim();
      const abort = new AbortController(), lifetime = AbortSignal.any([signal, abort.signal]);
      const pending = this.connection.waitForSessionEvent(payload.session_id, event => event.event_type === "session.configured"
        && (event.data as {execution_profile?: string}).execution_profile === payload.execution_profile
        && (options.readiness === "configured" || ready(event, payload.execution_profile!)), {...options, signal: lifetime})
        .then(event => ({event}), cause => ({cause}));
      try {
        await this.connection.send(command, {...options, signal});const observed = await pending;
        if ("cause" in observed) throw observed.cause;attempt.check();
        // Capture readiness which arrived while a lazy configuration's ACK was pending.
        const latest = this.connection.events.events().filter(event => event.session_id === payload.session_id
          && event.sequence >= observed.event.sequence && ready(event, payload.execution_profile!)).at(-1);
        record.configured = latest ?? observed.event;
        if (ready(record.configured, payload.execution_profile!) && payload.expected_native_reference
            && (record.configured.data as {native_reference?: string}).native_reference !== payload.expected_native_reference)
          throw new Error("Native continuation readiness changed its expected conversation identity.");
        record.phase = ready(record.configured, payload.execution_profile!) ? "active" : "reserved";
        return structuredClone(record);
      } finally {abort.abort();}
    });
  }
  close(sessionId: string, options: WaitOptions = {}): Promise<HcpNativeSessionState> {
    return this.#operation(sessionId, "close", options, async (signal, attempt) => {
      const record = this.#records.get(sessionId);
      if (!record) throw new NotSent("The physical generation is not owned.");
      if (record.phase === "closed") return structuredClone(record);
      if (record.phase === "opening" || record.phase === "closing" || record.close_attempted)
        throw new NotSent("A prior native control is pending or has unknown outcome; it cannot be replayed.");
      const command = createCommand({type: "harness.session.stop", payload: {session_id: sessionId}});
      record.phase = "closing";record.close_attempted = true;attempt.claim();
      const abort = new AbortController(), lifetime = AbortSignal.any([signal, abort.signal]);
      const pending = this.connection.waitForSessionEvent(sessionId, event => event.event_type === "session.exited"
        && (event.data as {provider_instance_id?: string}).provider_instance_id === record.payload.provider_instance_id
        && (event.data as {native_owner_closed?: boolean}).native_owner_closed === true, {...options, signal: lifetime})
        .then(event => ({event}), cause => ({cause}));
      try {
        await this.connection.send(command, {...options, signal});const observed = await pending;
        if ("cause" in observed) throw observed.cause;attempt.check();record.exited = observed.event;record.phase = "closed";
        return structuredClone(record);
      } finally {abort.abort();}
    });
  }
}
