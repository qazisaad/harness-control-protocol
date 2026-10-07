import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { killChildProcess } from "./cli-process.js";

export class NativeProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly closed: Promise<void>;
  #closed = false;
  #stopping: Promise<void> | undefined;

  constructor(
    executable: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
  ) {
    this.child = spawn(executable, args, {
      cwd,
      env,
      stdio: "pipe",
      detached: process.platform !== "win32",
    });
    this.child.on("error", () => {}); // The close event also fires after spawn errors.
    this.child.stdin.on("error", () => {}); // Runtime detects closure; avoid an unhandled EPIPE.
    this.closed = new Promise<void>((resolve) => {
      this.child.once("close", () => {
        this.#closed = true;
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    if (!this.#stopping) {
      this.#stopping = this.#stop();
      // Notification/error paths may initiate cleanup without awaiting it. Keep
      // the original rejecting promise available to the owner without an unhandled rejection.
      void this.#stopping.catch(() => {});
    }
    return this.#stopping;
  }

  async #stop(): Promise<void> {
    if (this.#closed) return;
    killChildProcess(this.child, "SIGTERM");
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    const signalFailure = new Promise<never>((_, reject) => {
      forceKill = setTimeout(() => {
        // A failed signal is uncertain closure, not an uncaught timer exception.
        // Propagate it to the owning stop operation so its durable fence survives.
        try {killChildProcess(this.child, "SIGKILL");} catch (failure) {reject(failure);}
      }, 1_000);
    });
    try {
      await Promise.race([this.closed, signalFailure]);
    } finally {
      clearTimeout(forceKill);
    }
  }
}
