import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import type { HcpEventType, LocalCapabilityLease } from "@hcp-runner/protocol";

import type { AuditLogger } from "../audit/index.js";
import { redactValue } from "../mcp/redaction.js";
import {
  LocalCapabilityEngine,
  LocalCapabilityPolicyError,
  type LocalFilesystemAction,
  type LocalGitAction,
} from "./index.js";

export type LocalCapabilityExecutionContext = {
  session_id: string;
  turn_id: string;
  workspace_id: string;
  provider_instance_id: string;
  workspace_root: string;
  sandbox_mode: "read_only" | "workspace_write" | "danger_full_access";
  lease: LocalCapabilityLease;
};

export type LocalCapabilityExecutionEvent = {
  event_type: HcpEventType;
  data: Record<string, unknown>;
};

export type LocalActionResult<TResult> = {
  result: TResult;
  events: LocalCapabilityExecutionEvent[];
};

export type FilesystemReadResult = {
  path: string;
  content: string;
};

export type FilesystemListResult = {
  path: string;
  entries: Array<{
    name: string;
    type: "file" | "directory" | "other";
  }>;
};

export type FilesystemWriteResult = {
  path: string;
  bytes_written: number;
};

export type GitCommandResult = {
  operation: LocalGitAction;
  exit_code: number;
  stdout: string;
  stderr: string;
};

export type ShellCommandRequest = {
  executable: string;
  argv: string[];
  cwd?: string;
  timeout_seconds: number;
  use_shell?: boolean;
  env?: Record<string, string>;
  signal?: AbortSignal;
};

export type ShellCommandResult = {
  executable: string;
  argv: string[];
  cwd: string;
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timed_out: boolean;
};

export type DevServerStartRequest = ShellCommandRequest & {
  server_id: string;
  host: string;
  port: number;
};

export type DevServerRecord = {
  server_id: string;
  pid: number;
  host: string;
  port: number;
  cwd: string;
  started_at: string;
};

type ProcessOutput = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

type TrackedDevServer = DevServerRecord & {
  process: ChildProcessWithoutNullStreams;
};

const MAX_CAPTURED_OUTPUT_BYTES = 64 * 1024;

export class LocalCapabilityExecutor {
  readonly #engine: LocalCapabilityEngine;
  readonly #auditLogger: AuditLogger | undefined;
  readonly #devServers = new Map<string, TrackedDevServer>();

  constructor(engine: LocalCapabilityEngine, auditLogger?: AuditLogger) {
    this.#engine = engine;
    this.#auditLogger = auditLogger;
  }

  async readFile(context: LocalCapabilityExecutionContext, path: string): Promise<LocalActionResult<FilesystemReadResult>> {
    return this.#runAction(context, "filesystem", "read_file", "read", async (): Promise<FilesystemReadResult> => {
      this.#engine.authorizeFilesystemAction(context.lease, {
        session_id: context.session_id,
        turn_id: context.turn_id,
        workspace_id: context.workspace_id,
        provider_instance_id: context.provider_instance_id,
        action: "read",
      });
      const resolvedPath: string = await resolveExistingWorkspacePath(path, context.workspace_root);
      const content: string = await readFile(resolvedPath, "utf8");
      return {
        path: workspaceRelativePath(resolvedPath, context.workspace_root),
        content,
      };
    });
  }

  async listDirectory(context: LocalCapabilityExecutionContext, path: string): Promise<LocalActionResult<FilesystemListResult>> {
    return this.#runAction(context, "filesystem", "list_directory", "list", async (): Promise<FilesystemListResult> => {
      this.#engine.authorizeFilesystemAction(context.lease, {
        session_id: context.session_id,
        turn_id: context.turn_id,
        workspace_id: context.workspace_id,
        provider_instance_id: context.provider_instance_id,
        action: "list",
      });
      const resolvedPath: string = await resolveExistingWorkspacePath(path, context.workspace_root);
      const entries = await readdir(resolvedPath, { withFileTypes: true });
      return {
        path: workspaceRelativePath(resolvedPath, context.workspace_root),
        entries: entries.map((entry) => ({
          name: entry.name,
          type: entry.isFile() ? "file" : entry.isDirectory() ? "directory" : "other",
        })),
      };
    });
  }

  async writeFile(context: LocalCapabilityExecutionContext, path: string, content: string): Promise<LocalActionResult<FilesystemWriteResult>> {
    return this.#runAction(context, "filesystem", "write_file", "write", async (): Promise<FilesystemWriteResult> => {
      assertWritableSandbox(context, "write");
      this.#engine.authorizeFilesystemAction(context.lease, {
        session_id: context.session_id,
        turn_id: context.turn_id,
        workspace_id: context.workspace_id,
        provider_instance_id: context.provider_instance_id,
        action: "write",
      });
      const resolvedPath: string = await resolveWritableWorkspacePath(path, context.workspace_root);
      await mkdir(dirname(resolvedPath), { recursive: true });
      await writeFile(resolvedPath, content, "utf8");
      return {
        path: workspaceRelativePath(resolvedPath, context.workspace_root),
        bytes_written: Buffer.byteLength(content),
      };
    });
  }

  async deletePath(context: LocalCapabilityExecutionContext, path: string): Promise<LocalActionResult<{ path: string }>> {
    return this.#runAction(context, "filesystem", "delete_path", "delete", async (): Promise<{ path: string }> => {
      assertWritableSandbox(context, "delete");
      this.#engine.authorizeFilesystemAction(context.lease, {
        session_id: context.session_id,
        turn_id: context.turn_id,
        workspace_id: context.workspace_id,
        provider_instance_id: context.provider_instance_id,
        action: "delete",
      });
      const resolvedPath: string = await resolveExistingWorkspacePath(path, context.workspace_root);
      await rm(resolvedPath, { recursive: true, force: false });
      return {
        path: workspaceRelativePath(resolvedPath, context.workspace_root),
      };
    });
  }

  async git(context: LocalCapabilityExecutionContext, operation: LocalGitAction): Promise<LocalActionResult<GitCommandResult>> {
    return this.#runAction(context, "git", `git.${operation}`, operation, async (): Promise<GitCommandResult> => {
      if (operation === "commit" || operation === "checkout" || operation === "push") {
        assertWritableSandbox(context, operation);
      }
      this.#engine.authorizeGitAction(context.lease, {
        session_id: context.session_id,
        turn_id: context.turn_id,
        workspace_id: context.workspace_id,
        provider_instance_id: context.provider_instance_id,
        action: operation,
      });
      const cwd: string = await resolveExistingWorkspacePath(".", context.workspace_root);
      const argv: string[] = gitArgvForOperation(operation);
      const output: ProcessOutput = await runProcess("git", argv, {
        cwd,
        timeoutSeconds: 30,
        useShell: false,
        env: minimalEnv(),
      });
      return {
        operation,
        exit_code: output.exitCode ?? 1,
        stdout: output.stdout,
        stderr: output.stderr,
      };
    });
  }

  async shell(context: LocalCapabilityExecutionContext, request: ShellCommandRequest): Promise<LocalActionResult<ShellCommandResult>> {
    return this.#runAction(context, "shell", "run_command", "run_command", async (): Promise<ShellCommandResult> => {
      const cwd: string = await resolveExistingWorkspacePath(request.cwd ?? ".", context.workspace_root);
      const useShell: boolean = request.use_shell ?? false;
      await this.#engine.authorizeShellCommand(context.lease, {
        session_id: context.session_id,
        turn_id: context.turn_id,
        workspace_id: context.workspace_id,
        provider_instance_id: context.provider_instance_id,
        executable: request.executable,
        argv: request.argv,
        cwd,
        workspace_root: context.workspace_root,
        use_shell: useShell,
        timeout_seconds: request.timeout_seconds,
        env: request.env ?? {},
      });
      const output: ProcessOutput = await runProcess(request.executable, request.argv, {
        cwd,
        timeoutSeconds: request.timeout_seconds,
        useShell,
        env: minimalEnv(),
        ...(request.signal ? { signal: request.signal } : {}),
      });
      return {
        executable: request.executable,
        argv: request.argv,
        cwd,
        exit_code: output.exitCode,
        signal: output.signal,
        stdout: output.stdout,
        stderr: output.stderr,
        timed_out: output.timedOut,
      };
    });
  }

  async startDevServer(
    context: LocalCapabilityExecutionContext,
    request: DevServerStartRequest,
  ): Promise<LocalActionResult<DevServerRecord>> {
    return this.#runAction(context, "dev_server", "dev_server.start", "start", async (): Promise<DevServerRecord> => {
      if (this.#devServers.has(request.server_id)) {
        throw new LocalCapabilityPolicyError("local_capability_dev_server_exists", `Dev server '${request.server_id}' is already running.`);
      }
      assertAllowedDevServerEndpoint(request.host, request.port);
      const cwd: string = await resolveExistingWorkspacePath(request.cwd ?? ".", context.workspace_root);
      await this.#engine.authorizeDevServerAction(context.lease, {
        session_id: context.session_id,
        turn_id: context.turn_id,
        workspace_id: context.workspace_id,
        provider_instance_id: context.provider_instance_id,
        action: "start",
        executable: request.executable,
        argv: request.argv,
        cwd,
        workspace_root: context.workspace_root,
        use_shell: request.use_shell ?? false,
        timeout_seconds: request.timeout_seconds,
        env: request.env ?? {},
      });
      const child: ChildProcessWithoutNullStreams = spawn(request.executable, request.argv, {
        cwd,
        shell: request.use_shell ?? false,
        env: minimalEnv(),
        detached: true,
        stdio: "pipe",
      });
      child.stdout.on("data", () => undefined);
      child.stderr.on("data", () => undefined);
      const pid: number | undefined = child.pid;
      if (pid === undefined) {
        throw new LocalCapabilityPolicyError("local_capability_dev_server_start_failed", "Dev server process did not expose a pid.");
      }
      const record: DevServerRecord = {
        server_id: request.server_id,
        pid,
        host: request.host,
        port: request.port,
        cwd,
        started_at: new Date().toISOString(),
      };
      this.#devServers.set(request.server_id, {
        ...record,
        process: child,
      });
      child.once("exit", () => {
        this.#devServers.delete(request.server_id);
      });
      return record;
    });
  }

  async stopDevServer(context: LocalCapabilityExecutionContext, serverId: string): Promise<LocalActionResult<{ server_id: string }>> {
    return this.#runAction(context, "dev_server", "dev_server.stop", "stop", async (): Promise<{ server_id: string }> => {
      await this.#engine.authorizeDevServerAction(context.lease, {
        session_id: context.session_id,
        turn_id: context.turn_id,
        workspace_id: context.workspace_id,
        provider_instance_id: context.provider_instance_id,
        action: "stop",
      });
      const server: TrackedDevServer | undefined = this.#devServers.get(serverId);
      if (!server) {
        throw new LocalCapabilityPolicyError("local_capability_dev_server_not_found", `Dev server '${serverId}' is not running.`);
      }
      killProcessTree(server.process);
      this.#devServers.delete(serverId);
      return { server_id: serverId };
    });
  }

  listDevServers(): DevServerRecord[] {
    return Array.from(this.#devServers.values()).map(({ process: _process, ...record }) => record);
  }

  async #runAction<TResult>(
    context: LocalCapabilityExecutionContext,
    capabilityId: string,
    action: string,
    policyAction: string,
    run: () => Promise<TResult>,
  ): Promise<LocalActionResult<TResult>> {
    const events: LocalCapabilityExecutionEvent[] = [
      localCapabilityEvent(context, "local_capability.action.started", capabilityId, action, "started"),
    ];
    await this.#recordAudit(context, `${capabilityId}.${action}.started`, { capability_id: capabilityId, action });

    try {
      const result: TResult = await run();
      events.push(
        localCapabilityEvent(context, "local_capability.action.completed", capabilityId, action, "completed", {
          result: summarizeResult(result),
        }),
      );
      await this.#recordAudit(context, `${capabilityId}.${action}.completed`, {
        capability_id: capabilityId,
        action,
        result: summarizeResult(result),
      });
      return { result, events };
    } catch (error: unknown) {
      const errorSummary: Record<string, unknown> = errorToSummary(error);
      events.push(
        localCapabilityEvent(context, "local_capability.action.failed", capabilityId, action, "failed", {
          error: errorSummary,
          policy_action: policyAction,
        }),
      );
      await this.#recordAudit(context, `${capabilityId}.${action}.failed`, {
        capability_id: capabilityId,
        action,
        error: errorSummary,
      });
      throw new LocalCapabilityExecutionError(events, error);
    }
  }

  async #recordAudit(context: LocalCapabilityExecutionContext, event: string, data: Record<string, unknown>): Promise<void> {
    if (!this.#auditLogger) {
      return;
    }
    await this.#auditLogger.record({
      event,
      session_id: context.session_id,
      turn_id: context.turn_id,
      provider_instance_id: context.provider_instance_id,
      workspace_id: context.workspace_id,
      data,
    });
  }
}

export class LocalCapabilityExecutionError extends Error {
  constructor(
    readonly events: LocalCapabilityExecutionEvent[],
    readonly cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : "Local capability action failed.");
    this.name = "LocalCapabilityExecutionError";
  }
}

function localCapabilityEvent(
  context: LocalCapabilityExecutionContext,
  eventType: HcpEventType,
  capabilityId: string,
  action: string,
  status: string,
  data: Record<string, unknown> = {},
): LocalCapabilityExecutionEvent {
  return {
    event_type: eventType,
    data: {
      lease_id: context.lease.lease_id,
      run_id: context.lease.run_id,
      workspace_id: context.workspace_id,
      provider_instance_id: context.provider_instance_id,
      capability_id: capabilityId,
      action,
      status,
      ...data,
    },
  };
}

async function resolveExistingWorkspacePath(path: string, workspaceRoot: string): Promise<string> {
  const candidate: string = await resolveCandidatePath(path, workspaceRoot);
  const resolvedPath: string = await realpath(candidate);
  await assertInsideWorkspace(resolvedPath, workspaceRoot);
  return resolvedPath;
}

async function resolveWritableWorkspacePath(path: string, workspaceRoot: string): Promise<string> {
  const candidate: string = await resolveCandidatePath(path, workspaceRoot);
  await assertCandidateInsideWorkspace(candidate, workspaceRoot);
  try {
    return await resolveExistingWorkspacePath(candidate, workspaceRoot);
  } catch (error: unknown) {
    if (!isFileMissingError(error)) {
      throw error;
    }
    const nearestExistingParent: string = await findNearestExistingParent(candidate, workspaceRoot);
    await assertInsideWorkspace(nearestExistingParent, workspaceRoot);
    return candidate;
  }
}

async function resolveCandidatePath(path: string, workspaceRoot: string): Promise<string> {
  return isAbsolute(path) ? path : resolve(await realpath(workspaceRoot), path);
}

async function assertInsideWorkspace(path: string, workspaceRoot: string): Promise<void> {
  const resolvedWorkspace: string = await realpath(workspaceRoot);
  const relativePath: string = relative(resolvedWorkspace, path);
  if (relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))) {
    return;
  }
  throw new LocalCapabilityPolicyError("local_capability_path_denied", `Path '${path}' is outside the selected workspace.`);
}

async function assertCandidateInsideWorkspace(path: string, workspaceRoot: string): Promise<void> {
  const resolvedWorkspace: string = await realpath(workspaceRoot);
  const relativePath: string = relative(resolvedWorkspace, path);
  if (relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))) {
    return;
  }
  throw new LocalCapabilityPolicyError("local_capability_path_denied", `Path '${path}' is outside the selected workspace.`);
}

async function findNearestExistingParent(path: string, workspaceRoot: string): Promise<string> {
  let current: string = dirname(path);
  const resolvedWorkspace: string = await realpath(workspaceRoot);
  while (true) {
    try {
      return await realpath(current);
    } catch (error: unknown) {
      if (!isFileMissingError(error)) {
        throw error;
      }
      const parent: string = dirname(current);
      if (parent === current) {
        throw error;
      }
      const relativeParent: string = relative(resolvedWorkspace, parent);
      if (relativeParent.startsWith("..") || isAbsolute(relativeParent)) {
        throw error;
      }
      current = parent;
    }
  }
}

function workspaceRelativePath(path: string, workspaceRoot: string): string {
  const relativePath: string = relative(realpathSync(workspaceRoot), path);
  return relativePath.length === 0 ? "." : relativePath;
}

function assertWritableSandbox(context: LocalCapabilityExecutionContext, action: string): void {
  if (context.sandbox_mode === "read_only") {
    throw new LocalCapabilityPolicyError("local_capability_sandbox_read_only", `Action '${action}' is not allowed in read_only sandbox mode.`);
  }
}

function gitArgvForOperation(operation: LocalGitAction): string[] {
  switch (operation) {
    case "status":
      return ["status", "--short"];
    case "diff":
      return ["diff", "--"];
    case "branch":
      return ["branch", "--show-current"];
    case "commit_metadata":
      return ["log", "-1", "--format=%H%n%an%n%ae%n%aI%n%s"];
    case "commit":
    case "checkout":
    case "push":
      throw new LocalCapabilityPolicyError("local_capability_git_operation_requires_args", `Git operation '${operation}' requires explicit arguments and is not available through the generic executor.`);
  }
}

async function runProcess(
  executable: string,
  argv: string[],
  options: {
    cwd: string;
    timeoutSeconds: number;
    useShell: boolean;
    env: Record<string, string>;
    signal?: AbortSignal;
  },
): Promise<ProcessOutput> {
  return await new Promise<ProcessOutput>((resolveProcess, rejectProcess) => {
    const child: ChildProcessWithoutNullStreams = spawn(executable, argv, {
      cwd: options.cwd,
      env: options.env,
      shell: options.useShell,
      stdio: "pipe",
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutSeconds * 1000);
    const onAbort = (): void => {
      child.kill("SIGTERM");
    };

    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendLimited(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendLimited(stderr, chunk);
    });
    child.once("error", (error: Error) => {
      clearTimeout(timeout);
      if (options.signal) {
        options.signal.removeEventListener("abort", onAbort);
      }
      rejectProcess(error);
    });
    child.once("close", (exitCode: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timeout);
      if (options.signal) {
        options.signal.removeEventListener("abort", onAbort);
      }
      resolveProcess({
        exitCode,
        signal,
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}

function appendLimited(existing: string, chunk: Buffer): string {
  const combined: Buffer = Buffer.concat([Buffer.from(existing), chunk]);
  if (combined.byteLength <= MAX_CAPTURED_OUTPUT_BYTES) {
    return combined.toString("utf8");
  }
  return combined.subarray(0, MAX_CAPTURED_OUTPUT_BYTES).toString("utf8");
}

function minimalEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
  };
}

function summarizeResult(value: unknown): unknown {
  return redactValue(value);
}

function errorToSummary(error: unknown): Record<string, unknown> {
  if (error instanceof LocalCapabilityPolicyError) {
    return {
      code: error.code,
      message: error.message,
    };
  }
  if (error instanceof Error) {
    return {
      code: "local_capability_action_failed",
      message: error.message,
    };
  }
  return {
    code: "local_capability_action_failed",
    message: "Local capability action failed.",
  };
}

function isFileMissingError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function assertAllowedDevServerEndpoint(host: string, port: number): void {
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new LocalCapabilityPolicyError("local_capability_dev_server_host_denied", `Dev server host '${host}' is not allowed.`);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new LocalCapabilityPolicyError("local_capability_dev_server_port_denied", `Dev server port '${port}' is invalid.`);
  }
}

function killProcessTree(child: ChildProcessWithoutNullStreams): void {
  const pid: number | undefined = child.pid;
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && (error as { code?: unknown }).code === "ESRCH") {
      return;
    }
    child.kill("SIGTERM");
  }
}
