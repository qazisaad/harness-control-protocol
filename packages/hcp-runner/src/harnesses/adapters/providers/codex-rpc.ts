import {HARNESS_CONTENT_MAX_BYTES} from "@harness-control/protocol";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import { HarnessAdapterError } from "../types.js";
import { NativeProcess } from "./native-process.js";
import { processFailureMessage } from "./cli-process.js";

const messageSchema = z.object({
  id: z.union([z.string().min(1).max(512), z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER)]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});
export type RpcMessage = z.infer<typeof messageSchema>;
/** Native method absence is confirmed non-dispatch; transport and payload errors are not. */
export class CodexRpcRequestError extends HarnessAdapterError {
  constructor(message: string, readonly nativeCode?: number) {super("codex_request_failed", message);}
}
export type RpcRequestContext = {readonly requestId: string | number};
export type RpcRequestHandler = (
  params: unknown,
  signal: AbortSignal,
  context?: RpcRequestContext,
) => Promise<unknown>;
type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
};

export class CodexRpc {
  readonly process: NativeProcess;
  readonly #pending = new Map<number, Pending>();
  #nextId = 1;
  #failure: Error | undefined;
  #buffer = "";
  readonly #decoder = new StringDecoder("utf8");
  readonly #handlers = new Map<string, RpcRequestHandler>();
  readonly #sessionHandlers = new Map<string, RpcRequestHandler>();
  readonly #activeRequests = new Set<string | number>();
  readonly #requestSignals = new Map<string | number, AbortController>();
  readonly #requestTurns = new Map<string | number, {threadId: string; turnId: string}>();
  readonly #requestsAbort = new AbortController();
  readonly #observers = new Set<(message: RpcMessage) => void>();
  onNotification: (message: RpcMessage) => void = () => {};
  onFailure: (error: Error) => void = () => {};

  constructor(executable: string, cwd: string, env: NodeJS.ProcessEnv) {
    this.process = new NativeProcess(
      executable,
      ["app-server", "--listen", "stdio://"],
      cwd,
      env,
    );
    this.process.child.stderr.resume();
    this.process.child.stdout.on("data", (chunk: Buffer) => {
      try {
        this.#buffer += this.#decoder.write(chunk);
        let newline: number;
        while ((newline = this.#buffer.indexOf("\n")) >= 0) {
          if (Buffer.byteLength(this.#buffer.slice(0, newline)) > HARNESS_CONTENT_MAX_BYTES) throw new Error("Oversized frame");
          const line = this.#buffer.slice(0, newline);
          this.#buffer = this.#buffer.slice(newline + 1);
          this.#receive(messageSchema.parse(JSON.parse(line)));
        }
        if (Buffer.byteLength(this.#buffer) > HARNESS_CONTENT_MAX_BYTES)
          throw new Error("Oversized frame");
      } catch {
        this.#fail(
          new HarnessAdapterError(
            "codex_protocol_error",
            "Codex returned an invalid protocol message.",
          ),
        );
        void this.process.stop();
      }
    });
    void this.process.closed.then(() =>
      this.#fail(
        new HarnessAdapterError(
          "codex_process_closed",
          "Codex process closed before the operation finished.",
        ),
      ),
    );
  }

  request(method: string, params: unknown, options?: {signal?: AbortSignal}): Promise<unknown> {
    if (this.#failure) return Promise.reject(this.#failure);
    if (options?.signal?.aborted) return Promise.reject(options.signal.reason);
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const signal = options?.signal;
      const abort = () => {
        this.#pending.delete(id);
        cleanup();
        reject(signal!.reason);
      };
      const cleanup = () => {signal?.removeEventListener("abort", abort);};
      this.#pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener("abort", abort, {once: true});
      this.#write({ id, method, params });
    });
  }

  notify(method: string): void {
    this.#write({ method });
  }

  setRequestHandler(method: string, handler: RpcRequestHandler): void {
    if (this.#handlers.has(method)) {
      throw new Error(`A native request handler is already registered for ${method}.`);
    }
    this.#handlers.set(method, handler);
  }

  removeRequestHandler(method: string): void {
    this.#handlers.delete(method);
  }

  setSessionRequestHandler(method: string, handler: RpcRequestHandler): void {
    if (this.#sessionHandlers.has(method)) throw new Error(`A session handler is already registered for ${method}.`);
    this.#sessionHandlers.set(method, handler);
  }

  /** A persistent router can delegate an exact root request to the currently admitted turn. */
  handleTurnRequest(method: string, params: unknown, signal: AbortSignal, context?: RpcRequestContext): Promise<unknown> {
    signal.throwIfAborted();
    const handler = this.#handlers.get(method);
    if (!handler) throw new HarnessAdapterError("native_request_owner_missing", "No admitted root owns this native callback.");
    return handler(params, signal, context);
  }

  observeNotifications(observer: (message: RpcMessage) => void): () => void {
    this.#observers.add(observer);
    return () => {this.#observers.delete(observer);};
  }

  async #handleRequest(
    id: string | number,
    params: unknown,
    handler: RpcRequestHandler,
  ): Promise<void> {
    if (this.#activeRequests.has(id)) {
      this.#fail(new HarnessAdapterError("codex_protocol_error", "Codex repeated an active native request."));
      await this.process.stop();
      return;
    }
    this.#activeRequests.add(id);
    const controller = new AbortController();
    this.#requestSignals.set(id, controller);
    const turn = z.object({threadId: z.string().min(1), turnId: z.string().min(1)}).safeParse(params);
    if (turn.success) this.#requestTurns.set(id, turn.data);
    try {
      const result = await handler(params, AbortSignal.any([this.#requestsAbort.signal, controller.signal]), Object.freeze({requestId: id}));
      if (!this.#failure && !controller.signal.aborted) this.#write({ id, result });
    } catch {
      if (!this.#failure && !controller.signal.aborted) {
        this.#write({ id, error: { code: -32603, message: "The native tool request could not complete." } });
        this.#fail(new HarnessAdapterError("native_tool_request_failed", "The native tool request could not complete."));
        await this.process.stop();
      }
    } finally {
      this.#activeRequests.delete(id);
      this.#requestSignals.delete(id);
      this.#requestTurns.delete(id);
    }
  }

  #write(message: object): void {
    this.process.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error)
        this.#fail(
          new HarnessAdapterError(
            "codex_transport_closed",
            "Codex input transport closed.",
          ),
        );
    });
  }

  #receive(message: RpcMessage): void {
    if (this.#failure) return;
    if (message.method && message.id !== undefined) {
      const handler = this.#sessionHandlers.get(message.method) ?? this.#handlers.get(message.method);
      if (handler) {
        void this.#handleRequest(message.id, message.params, handler);
        return;
      }
      this.#write({
        id: message.id,
        error: {
          code: -32601,
          message:
            "Interactive provider requests are not supported by this runner profile.",
        },
      });
      this.#fail(
        new HarnessAdapterError(
          "unsupported_provider_request",
          "Codex requested unsupported interactive input.",
        ),
      );
      void this.process.stop();
    } else if (message.method) {
      if (message.method === "serverRequest/resolved") {
        const resolved = z.object({requestId: z.union([z.string(), z.number()])}).safeParse(message.params);
        if (resolved.success) this.#requestSignals.get(resolved.data.requestId)?.abort();
      }
      if (message.method === "turn/completed") {
        const terminal = z.object({threadId: z.string().min(1), turn: z.object({id: z.string().min(1),
          status: z.enum(["completed", "interrupted", "failed"])})}).safeParse(message.params);
        if (terminal.success) for (const [id, turn] of this.#requestTurns)
          if (turn.threadId === terminal.data.threadId && turn.turnId === terminal.data.turn.id)
            this.#requestSignals.get(id)?.abort();
      }
      for (const observer of this.#observers) observer(message);
      this.onNotification(message);
    } else if (typeof message.id === "number") {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      pending.cleanup();
      if (message.error !== undefined) {
        const error = z
          .object({ message: z.string(), code: z.number().int().optional() })
          .safeParse(message.error);
        const detail = processFailureMessage(
          {
            exitCode: null,
            signal: null,
            stdout: "",
            stderr: "",
            error: error.success ? error.data.message : undefined,
            timedOut: false,
          },
          "Codex rejected a native request.",
          [],
        );
        pending.reject(new CodexRpcRequestError(detail, error.success ? error.data.code : undefined));
      } else pending.resolve(message.result);
    }
  }

  #fail(error: Error): void {
    if (this.#failure) return;
    this.#failure = error;
    this.#requestsAbort.abort(error);
    for (const pending of this.#pending.values()) {pending.cleanup(); pending.reject(error);}
    this.#pending.clear();
    this.onFailure(error);
  }
}
