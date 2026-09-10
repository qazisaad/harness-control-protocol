import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { redactValue } from "../../../mcp/redaction.js";

const MAX_CAPTURED_CLI_OUTPUT_BYTES = 64 * 1024;

export type CliProcessRunOptions = {
  cwd: string;
  env: Record<string, string>;
};

export type CliProcessResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error: string | undefined;
  timedOut: boolean;
};

export type CliProcessHandle = {
  readonly result: Promise<CliProcessResult>;
  kill(signal?: NodeJS.Signals): void;
};

export type CliProcessSpawner = (
  executable: string,
  argv: string[],
  options: CliProcessRunOptions,
) => CliProcessHandle;

export type CodexProcessRunOptions = CliProcessRunOptions;
export type CodexProcessResult = CliProcessResult;
export type CodexProcessHandle = CliProcessHandle;
export type CodexProcessSpawner = CliProcessSpawner;

export type CliManagedProcess = {
  readonly completion: Promise<CliProcessResult>;
  terminate(): void;
};

export type CliManagedProcessOptions = {
  processSpawner: CliProcessSpawner;
  executable: string;
  argv: string[];
  runOptions: CliProcessRunOptions;
  timeoutMs: number;
  processKillGraceMs: number;
  timeoutErrorMessage: string;
  terminatedErrorMessage: string;
  startFailureMessage: string;
};

export function startManagedCliProcess(options: CliManagedProcessOptions): CliManagedProcess {
  const handle: CliProcessHandle = spawnCliProcess(options);
  let settled = false;
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let forceKill: ReturnType<typeof setTimeout> | undefined;
  let settleProcess: (result: CliProcessResult) => void = () => {};
  const completion: Promise<CliProcessResult> = new Promise<CliProcessResult>((resolve) => {
    settleProcess = (result: CliProcessResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      if (forceKill) {
        clearTimeout(forceKill);
      }
      resolve({
        ...result,
        timedOut: result.timedOut || timedOut,
      });
    };
  });

  const terminate = (asTimeout: boolean): void => {
    if (settled) return;
    if (asTimeout) {
      timedOut = true;
    }
    handle.kill("SIGTERM");
    if (!forceKill) {
      forceKill = setTimeout((): void => {
        handle.kill("SIGKILL");
      }, options.processKillGraceMs);
    }
  };

  timeout = setTimeout((): void => terminate(true), options.timeoutMs);
  handle.result.then(
    (result: CliProcessResult): void => settleProcess(result),
    (error: unknown): void => settleProcess(processExceptionResult(error, options.startFailureMessage)),
  );

  return {
    completion,
    terminate: (): void => terminate(false),
  };
}

export function spawnProviderCliProcess(
  executable: string,
  argv: string[],
  options: CliProcessRunOptions,
): CliProcessHandle {
  const child: ChildProcessWithoutNullStreams = spawn(executable, argv, {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...options.env,
    },
    stdio: "pipe",
    detached: process.platform !== "win32",
  });
  let stdout = "";
  let stderr = "";
  let settled = false;

  child.stdin.end();

  const result: Promise<CliProcessResult> = new Promise<CliProcessResult>((resolve) => {
    const settle = (processResult: CliProcessResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(processResult);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendLimitedProcessOutput(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendLimitedProcessOutput(stderr, chunk);
    });
    child.once("error", (error: Error) => {
      settle({
        exitCode: null,
        signal: null,
        stdout,
        stderr,
        error: error.message,
        timedOut: false,
      });
    });
    child.once("close", (exitCode: number | null, signal: NodeJS.Signals | null) => {
      settle({
        exitCode,
        signal,
        stdout,
        stderr,
        error: undefined,
        timedOut: false,
      });
    });
  });

  return {
    result,
    kill(signal: NodeJS.Signals = "SIGTERM"): void {
      killChildProcess(child, signal);
    },
  };
}

export function processFailureDetails(result: CliProcessResult): Record<string, unknown> {
  return {
    ...(result.exitCode !== null ? { exit_code: result.exitCode } : {}),
    ...(result.signal !== null ? { signal: result.signal } : {}),
    ...(result.timedOut ? { timed_out: true } : {}),
  };
}

export function processFailureMessage(
  result: CliProcessResult,
  fallback: string,
  diagnosticPaths: string[],
): string {
  const rawMessage: string = firstNonEmpty(result.error ?? "", result.stderr, result.stdout, fallback);
  const redactedValue: unknown = redactValue(redactLocalPaths(rawMessage, diagnosticPaths));
  return typeof redactedValue === "string" ? redactedValue : fallback;
}

export function firstLine(value: string): string | undefined {
  const line: string | undefined = value.split(/\r?\n/).find((candidate: string): boolean => candidate.trim().length > 0);
  return line?.trim();
}

function spawnCliProcess(options: CliManagedProcessOptions): CliProcessHandle {
  try {
    return options.processSpawner(options.executable, options.argv, options.runOptions);
  } catch (error: unknown) {
    return resolvedProcessHandle(processExceptionResult(error, options.startFailureMessage));
  }
}

function appendLimitedProcessOutput(existing: string, chunk: Buffer): string {
  const combined: Buffer = Buffer.concat([Buffer.from(existing), chunk]);
  if (combined.byteLength <= MAX_CAPTURED_CLI_OUTPUT_BYTES) {
    return combined.toString("utf8");
  }
  return combined.subarray(0, MAX_CAPTURED_CLI_OUTPUT_BYTES).toString("utf8");
}

export function killChildProcess(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  try {
    if (process.platform === "win32" && child.pid !== undefined) {
      const argv: string[] = ["/pid", String(child.pid), "/T"];
      if (signal === "SIGKILL") {
        argv.push("/F");
      }
      const killer = spawn("taskkill", argv, { stdio: "ignore" });
      killer.once("error", () => {
        child.kill(signal);
      });
      return;
    }
    if (process.platform !== "win32" && child.pid !== undefined) {
      process.kill(-child.pid, signal);
      return;
    }
    child.kill(signal);
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return;
    }
    throw error;
  }
}

function resolvedProcessHandle(result: CliProcessResult): CliProcessHandle {
  return {
    result: Promise.resolve(result),
    kill(): void {
      return;
    },
  };
}

function processExceptionResult(error: unknown, fallback = "Provider process failed before start."): CliProcessResult {
  return {
    exitCode: null,
    signal: null,
    stdout: "",
    stderr: "",
    error: error instanceof Error ? error.message : fallback,
    timedOut: false,
  };
}

function firstNonEmpty(...values: string[]): string {
  const found: string | undefined = values.find((value: string): boolean => value.trim().length > 0);
  return found?.trim() ?? "Provider command failed.";
}

function redactLocalPaths(value: string, paths: string[]): string {
  let redacted: string = value;
  const sortedPaths: string[] = [...new Set(paths)].sort((left: string, right: string): number => right.length - left.length);
  for (const path of sortedPaths) {
    redacted = redacted.split(path).join("<local-path>");
  }
  return redacted
    .replace(/\/(?:Users|home|private|tmp|var|opt|Applications|Volumes)\/[^\s'"]+/g, "<local-path>")
    .replace(/[A-Za-z]:\\[^\s'"]+/g, "<local-path>")
    .trim();
}
