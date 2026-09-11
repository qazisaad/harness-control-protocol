import {
  createHcpEnvelope, parseHcpMessage, HcpSessionEventReducer,
  type HcpMessage, type HcpHostHelloPayload, type HcpHostAcceptedPayload,
  type HcpEventApplyResult, type HcpSnapshotApplyResult, type HcpCommandNackPayload,
} from "@harness-control/protocol";
import { createCommand, parseCommand, type HcpCommand, type HcpCommandType, type HcpCommandResponse, type CommandOptions } from "./commands.js";

export type ReceiveResult =
  | { message: Extract<HcpMessage, { type: "harness.event" }>; reduction: HcpEventApplyResult }
  | { message: Extract<HcpMessage, { type: "harness.session.snapshot" }>; reduction: HcpSnapshotApplyResult }
  | { message: Exclude<HcpMessage, { type: "harness.event" | "harness.session.snapshot" }> };
export type WaitOptions = { timeoutMs?: number; signal?: AbortSignal };
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
  readonly #pending = new Map<string, Pending>();
  #state: State = { kind: "awaiting_hello" };

  constructor(private readonly transport: { send: (message: HcpMessage) => void },
    options: { events?: HcpSessionEventReducer } = {}) {
    this.events = options.events ?? new HcpSessionEventReducer();
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
      case "host.heartbeat":
        if (message.payload.host_id !== this.#state.hello.host_id) throw new Error("Heartbeat host identity mismatch.");
        return { message };
      case "host.capabilities.updated":
      case "host.replay.unavailable":
        return { message };
      case "harness.event":
        return { message, reduction: this.events.applyEvent(message.payload) };
      case "harness.session.snapshot": {
        const reduction = this.events.applySnapshot(message.payload);
        this.#settle(message);
        return { message, reduction };
      }
      case "hcp.command.ack":
      case "hcp.command.nack":
      case "host.workspaces.result":
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
  }

  #settle(message: HcpMessage): void {
    let pending: Pending | undefined;
    if (message.type === "hcp.command.ack" || message.type === "hcp.command.nack") {
      pending = this.#pending.get(message.payload.command_id);
      if (message.type === "hcp.command.ack" && pending && ["host.workspaces.request", "harness.session.snapshot.request", "local.action.request"].includes(pending.command.type)) return;
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
  manageWorkspaces(payload: Payload<"host.workspaces.request">, command?: CommandOptions, wait?: WaitOptions) {
    return this.send(createCommand({ type: "host.workspaces.request", payload }, command), wait);
  }
}
type Payload<T extends HcpCommandType> = Extract<HcpCommand, { type: T }>["payload"];
