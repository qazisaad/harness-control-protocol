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
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.onFailure(error);
  }
}
