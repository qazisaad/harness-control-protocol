import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import { HarnessAdapterError } from "../types.js";
import { NativeProcess } from "./native-process.js";
import { processFailureMessage } from "./cli-process.js";

const messageSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});
export type RpcMessage = z.infer<typeof messageSchema>;
export type RpcRequestHandler = (
  params: unknown,
  signal: AbortSignal,
) => Promise<unknown>;
type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export class CodexRpc {
  readonly process: NativeProcess;
  readonly #pending = new Map<number, Pending>();
  #nextId = 1;
  #failure: Error | undefined;
  #buffer = "";
  readonly #decoder = new StringDecoder("utf8");
  readonly #handlers = new Map<string, RpcRequestHandler>();
  readonly #activeRequests = new Set<string | number>();
  readonly #requestsAbort = new AbortController();
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
          if (newline > 8 * 1024 * 1024) throw new Error("Oversized frame");
          const line = this.#buffer.slice(0, newline);
          this.#buffer = this.#buffer.slice(newline + 1);
          this.#receive(messageSchema.parse(JSON.parse(line)));
        }
        if (Buffer.byteLength(this.#buffer) > 8 * 1024 * 1024)
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

  request(method: string, params: unknown): Promise<unknown> {
    if (this.#failure) return Promise.reject(this.#failure);
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
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
    try {
      const result = await handler(params, this.#requestsAbort.signal);
      if (!this.#failure) this.#write({ id, result });
    } catch {
      if (!this.#failure) {
        this.#write({ id, error: { code: -32603, message: "The native tool request could not complete." } });
        this.#fail(new HarnessAdapterError("native_tool_request_failed", "The native tool request could not complete."));
        await this.process.stop();
      }
    } finally {
      this.#activeRequests.delete(id);
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
      const handler = this.#handlers.get(message.method);
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
      this.onNotification(message);
    } else if (typeof message.id === "number") {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error !== undefined) {
        const error = z
          .object({ message: z.string() })
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
        pending.reject(new HarnessAdapterError("codex_request_failed", detail));
      } else pending.resolve(message.result);
    }
  }

  #fail(error: Error): void {
    if (this.#failure) return;
    this.#failure = error;
    this.#requestsAbort.abort(error);
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.onFailure(error);
  }
}
