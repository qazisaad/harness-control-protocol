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
    this.#stopping ??= this.#stop();
    return this.#stopping;
  }

  async #stop(): Promise<void> {
    if (this.#closed) return;
    killChildProcess(this.child, "SIGTERM");
    const forceKill = setTimeout(
      () => killChildProcess(this.child, "SIGKILL"),
      1_000,
    );
    try {
      await this.closed;
    } finally {
      clearTimeout(forceKill);
    }
  }
}
