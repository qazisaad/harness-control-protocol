import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import type { HcpEventType, LocalCapabilityLease } from "@harness-control/protocol";

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
  encoding: "utf8" | "base64";
  hash: string;
  truncated?: boolean;
};

export type FilesystemReadOptions = {
  encoding?: "utf8" | "base64";
  range?: {
    start?: number;
    length?: number;
  };
  contentByteLimit?: number;
};

export type FilesystemListResult = {
  path: string;
  entries: Array<{
    name: string;
    type: "file" | "directory" | "other";
  }>;
  truncated?: boolean;
};

export type FilesystemListOptions = {
  recursive?: boolean;
  includeHidden?: boolean;
  maxDepth?: number;
  entryLimit?: number;
};

export type FilesystemWriteResult = {
  path: string;
  bytes_written: number;
  new_hash: string;
};

export type FilesystemWriteOptions = {
  encoding?: "utf8" | "base64";
  mode?: "create" | "overwrite";
  createParents?: boolean;
  expectedBaseHash?: string;
};

export type FilesystemPatchResult = {
  path: string;
  changed: boolean;
  new_hash: string;
};

export type FilesystemPatchOptions = {
  expectedBaseHash: string;
  patchContent: string;
  createIfMissing?: boolean;
};

export type GitCommandResult = {
  operation: LocalGitAction;
  exit_code: number;
  stdout: string;
  stderr: string;
  stdout_truncated?: boolean;
  stderr_truncated?: boolean;
  branch?: string;
};

export type GitCommandOptions = {
  status?: {
    porcelainVersion?: "v1" | "v2";
    includeBranch?: boolean;
    outputByteLimit?: number;
  };
  diff?: {
    paths?: string[];
    staged?: boolean;
    baseRef?: string;
    outputByteLimit?: number;
  };
};

export type ShellCommandRequest = {
  executable: string;
  argv: string[];
  cwd?: string;
  timeout_seconds: number;
  use_shell?: boolean;
  env?: Record<string, string>;
  stdin?: string;
  stdout_byte_limit?: number;
  stderr_byte_limit?: number;
  session_active?: () => boolean;
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
  stdout_truncated?: boolean;
  stderr_truncated?: boolean;
};

export type DevServerStartRequest = ShellCommandRequest & {
  server_id: string;
  host: string;
  port: number;
  readiness?: {
    url?: string;
    timeout_ms: number;
  };
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
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
};

type TrackedDevServer = DevServerRecord & {
  session_id: string;
  process: ChildProcessWithoutNullStreams;
};

const MAX_CAPTURED_OUTPUT_BYTES = 64 * 1024;
const PROCESS_TIMEOUT_KILL_GRACE_MS = 500;
const PROCESS_FORCE_KILL_SETTLE_MS = 500;
const DEV_SERVER_START_SETTLE_MS = 250;
const DEV_SERVER_READINESS_POLL_MS = 100;

export class LocalCapabilityExecutor {
  readonly #engine: LocalCapabilityEngine;
  readonly #auditLogger: AuditLogger | undefined;
  readonly #devServers = new Map<string, TrackedDevServer>();

  constructor(engine: LocalCapabilityEngine, auditLogger?: AuditLogger) {
    this.#engine = engine;
    this.#auditLogger = auditLogger;
  }

  async readFile(
    context: LocalCapabilityExecutionContext,
    path: string,
    options: FilesystemReadOptions = {},
  ): Promise<LocalActionResult<FilesystemReadResult>> {
    return this.#runAction(context, "filesystem", "read_file", "read", async (): Promise<FilesystemReadResult> => {
      this.#engine.authorizeFilesystemAction(context.lease, {
        session_id: context.session_id,
        turn_id: context.turn_id,
        workspace_id: context.workspace_id,
        provider_instance_id: context.provider_instance_id,
        action: "read",
      });
      const resolvedPath: string = await resolveExistingWorkspacePath(path, context.workspace_root);
      const contentBytes: Buffer = await readFile(resolvedPath);
      const selectedBytes: Buffer = applyByteRange(contentBytes, options.range);
      const limitedContent: LimitedBuffer = limitBuffer(selectedBytes, options.contentByteLimit);
      const encoding: "utf8" | "base64" = options.encoding ?? "utf8";
      return {
        path: workspaceRelativePath(resolvedPath, context.workspace_root),
        content: encodeBuffer(limitedContent.buffer, encoding),
        encoding,
        hash: sha256Hash(contentBytes),
        ...(limitedContent.truncated ? { truncated: true } : {}),
      };
    });
  }

  async listDirectory(
    context: LocalCapabilityExecutionContext,
    path: string,
    options: FilesystemListOptions = {},
  ): Promise<LocalActionResult<FilesystemListResult>> {
    return this.#runAction(context, "filesystem", "list_directory", "list", async (): Promise<FilesystemListResult> => {
      this.#engine.authorizeFilesystemAction(context.lease, {
        session_id: context.session_id,
        turn_id: context.turn_id,
        workspace_id: context.workspace_id,
        provider_instance_id: context.provider_instance_id,
        action: "list",
      });
      const resolvedPath: string = await resolveExistingWorkspacePath(path, context.workspace_root);
      const listResult: WorkspaceListResult = await listWorkspaceEntries(resolvedPath, options);
      return {
        path: workspaceRelativePath(resolvedPath, context.workspace_root),
        entries: listResult.entries,
        ...(listResult.truncated ? { truncated: true } : {}),
      };
    });
  }

  async writeFile(
    context: LocalCapabilityExecutionContext,
    path: string,
    content: string,
    options: FilesystemWriteOptions = {},
  ): Promise<LocalActionResult<FilesystemWriteResult>> {
    const filesystemAction: LocalFilesystemAction = options.mode === "create" ? "create" : "write";
    return this.#runAction(context, "filesystem", "write_file", filesystemAction, async (): Promise<FilesystemWriteResult> => {
      assertWritableSandbox(context, filesystemAction);
      this.#engine.authorizeFilesystemAction(context.lease, {
        session_id: context.session_id,
        turn_id: context.turn_id,
        workspace_id: context.workspace_id,
        provider_instance_id: context.provider_instance_id,
        action: filesystemAction,
      });
      const resolvedPath: string = await resolveWritableWorkspacePath(path, context.workspace_root);
      await assertWriteModeAllowed(resolvedPath, options);
      const contentBytes: Buffer = decodeContent(content, options.encoding ?? "utf8");
      if (options.createParents ?? true) {
        await mkdir(dirname(resolvedPath), { recursive: true });
      }
      await writeFile(resolvedPath, contentBytes);
      const writtenBytes: Buffer = await readFile(resolvedPath);
      return {
        path: workspaceRelativePath(resolvedPath, context.workspace_root),
        bytes_written: contentBytes.byteLength,
        new_hash: sha256Hash(writtenBytes),
      };
    });
  }

  async patchFile(
    context: LocalCapabilityExecutionContext,
    path: string,
    options: FilesystemPatchOptions,
  ): Promise<LocalActionResult<FilesystemPatchResult>> {
    return this.#runAction(context, "filesystem", "patch_file", "patch", async (): Promise<FilesystemPatchResult> => {
      assertWritableSandbox(context, "patch");
      this.#engine.authorizeFilesystemAction(context.lease, {
        session_id: context.session_id,
        turn_id: context.turn_id,
        workspace_id: context.workspace_id,
        provider_instance_id: context.provider_instance_id,
        action: "patch",
      });
      const resolvedPath: string = await resolveWritableWorkspacePath(path, context.workspace_root);
      const existingBytes: Buffer = await readExistingFileForPatch(resolvedPath, options.createIfMissing ?? false);
      assertExpectedHash(existingBytes, options.expectedBaseHash);
      const originalContent: string = existingBytes.toString("utf8");
      const patchResult: TextPatchResult = applyUnifiedDiff(originalContent, options.patchContent);
      const newBytes: Buffer = Buffer.from(patchResult.content, "utf8");
      if (patchResult.changed) {
        await mkdir(dirname(resolvedPath), { recursive: true });
        await writeFile(resolvedPath, newBytes);
      }
      return {
        path: workspaceRelativePath(resolvedPath, context.workspace_root),
        changed: patchResult.changed,
        new_hash: sha256Hash(newBytes),
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

  async git(
    context: LocalCapabilityExecutionContext,
    operation: LocalGitAction,
    options: GitCommandOptions = {},
  ): Promise<LocalActionResult<GitCommandResult>> {
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
      const argv: string[] = await gitArgvForOperation(operation, context.workspace_root, options);
      const outputByteLimit: number | undefined =
        operation === "status" ? options.status?.outputByteLimit : operation === "diff" ? options.diff?.outputByteLimit : undefined;
      const output: ProcessOutput = await runProcess("git", argv, {
        cwd,
        timeoutSeconds: 30,
        useShell: false,
        env: minimalEnv(),
        ...(outputByteLimit ? { stdoutByteLimit: outputByteLimit } : {}),
      });
      return {
        operation,
        exit_code: output.exitCode ?? 1,
        stdout: output.stdout,
        stderr: output.stderr,
        ...(output.stdoutTruncated ? { stdout_truncated: true } : {}),
        ...(output.stderrTruncated ? { stderr_truncated: true } : {}),
        ...gitStatusBranchResult(operation, options, output.stdout),
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
        env: processEnvFor(request.env),
        ...(request.stdin !== undefined ? { stdin: request.stdin } : {}),
        ...(request.stdout_byte_limit ? { stdoutByteLimit: request.stdout_byte_limit } : {}),
        ...(request.stderr_byte_limit ? { stderrByteLimit: request.stderr_byte_limit } : {}),
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
        ...(output.stdoutTruncated ? { stdout_truncated: true } : {}),
        ...(output.stderrTruncated ? { stderr_truncated: true } : {}),
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
      if (request.session_active && !request.session_active()) {
        throw new LocalCapabilityPolicyError("local_capability_lease_revoked", "Local action session stopped before dev server start.");
      }
      const child: ChildProcessWithoutNullStreams = spawn(request.executable, request.argv, {
        cwd,
        shell: request.use_shell ?? false,
        env: processEnvFor(request.env),
        detached: true,
        stdio: "pipe",
      });
      child.once("error", () => {
        this.#devServers.delete(request.server_id);
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
        session_id: context.session_id,
        process: child,
      });
      child.once("exit", () => {
        this.#devServers.delete(request.server_id);
      });
      try {
        await waitForDevServerStartup(child, request);
      } catch (error: unknown) {
        await terminateProcessTree(child, "SIGTERM", PROCESS_TIMEOUT_KILL_GRACE_MS);
        this.#devServers.delete(request.server_id);
        throw error;
      }
      return record;
    });
  }

  async stopDevServer(
    context: LocalCapabilityExecutionContext,
    serverId: string,
    signal: NodeJS.Signals = "SIGTERM",
    timeoutMs = 5_000,
  ): Promise<LocalActionResult<{ server_id: string }>> {
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
      await terminateProcessTree(server.process, signal, timeoutMs);
      this.#devServers.delete(serverId);
      return { server_id: serverId };
    });
  }

  listDevServers(): DevServerRecord[] {
    return Array.from(this.#devServers.values()).map(({ process: _process, session_id: _sessionId, ...record }) => record);
  }

  async stopDevServersForSession(sessionId: string, timeoutMs = 5_000): Promise<void> {
    for (const server of Array.from(this.#devServers.values())) {
      if (server.session_id !== sessionId) {
        continue;
      }
      await terminateProcessTree(server.process, "SIGTERM", timeoutMs);
      this.#devServers.delete(server.server_id);
    }
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
          output: summarizeResult(result),
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
          input: { policy_action: policyAction },
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
  let resolvedPath: string;
  try {
    resolvedPath = await realpath(candidate);
  } catch (error: unknown) {
    if (error instanceof Error) {
      throw new LocalCapabilityPolicyError(
        "local_capability_path_unresolved",
        `Path '${path}' could not be resolved inside the selected workspace: ${error.message}`,
      );
    }
    throw error;
  }
  await assertInsideWorkspace(resolvedPath, workspaceRoot);
  return resolvedPath;
}

async function resolveWritableWorkspacePath(path: string, workspaceRoot: string): Promise<string> {
  const candidate: string = await resolveCandidatePath(path, workspaceRoot);
  await assertCandidateInsideWorkspace(candidate, workspaceRoot);
  try {
    const resolvedPath: string = await realpath(candidate);
    await assertInsideWorkspace(resolvedPath, workspaceRoot);
    return resolvedPath;
  } catch (error: unknown) {
    if (!isFileMissingError(error)) {
      throw error;
    }
    const nearestExistingParent: string = await findNearestExistingParent(candidate, workspaceRoot);
    await assertInsideWorkspace(nearestExistingParent, workspaceRoot);
    await assertMissingWritableTargetHasNoSymlink(candidate);
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

async function gitArgvForOperation(
  operation: LocalGitAction,
  workspaceRoot: string,
  options: GitCommandOptions,
): Promise<string[]> {
  switch (operation) {
    case "status": {
      const statusOptions = options.status ?? {};
      return [
        "status",
        `--porcelain=${statusOptions.porcelainVersion ?? "v1"}`,
        ...(statusOptions.includeBranch ? ["--branch"] : []),
      ];
    }
    case "diff": {
      const diffOptions = options.diff ?? {};
      if (diffOptions.paths) {
        await assertRequestedPathsInsideWorkspace(diffOptions.paths, workspaceRoot);
      }
      if (diffOptions.baseRef) {
        assertSafeGitRevision(diffOptions.baseRef);
      }
      return [
        "diff",
        ...(diffOptions.staged ? ["--staged"] : []),
        ...(diffOptions.baseRef ? [diffOptions.baseRef] : []),
        "--",
        ...(diffOptions.paths ?? []),
      ];
    }
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

function assertSafeGitRevision(revision: string): void {
  if (revision.startsWith("-") || revision.includes("\0")) {
    throw new LocalCapabilityPolicyError("local_capability_command_denied", "Git base ref is not a safe revision token.");
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
    stdin?: string;
    stdoutByteLimit?: number;
    stderrByteLimit?: number;
    signal?: AbortSignal;
  },
): Promise<ProcessOutput> {
  return await new Promise<ProcessOutput>((resolveProcess, rejectProcess) => {
    const child: ChildProcessWithoutNullStreams = spawn(executable, argv, {
      cwd: options.cwd,
      env: options.env,
      shell: options.useShell,
      detached: true,
      stdio: "pipe",
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let forceKillTimeout: NodeJS.Timeout | undefined;
    let forceKillSettleTimeout: NodeJS.Timeout | undefined;
    let onAbort: () => void = () => undefined;
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.stdin ?? "");
    const clearProcessTimers = (): void => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = undefined;
      }
      if (forceKillTimeout) {
        clearTimeout(forceKillTimeout);
        forceKillTimeout = undefined;
      }
      if (forceKillSettleTimeout) {
        clearTimeout(forceKillSettleTimeout);
        forceKillSettleTimeout = undefined;
      }
    };
    const resolveOutput = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearProcessTimers();
      if (options.signal) {
        options.signal.removeEventListener("abort", onAbort);
      }
      resolveProcess({
        exitCode,
        signal,
        stdout,
        stderr,
        timedOut,
        stdoutTruncated,
        stderrTruncated,
      });
    };
    const terminateChild = (signal: NodeJS.Signals): void => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      killProcessTree(child, signal);
      if (forceKillTimeout || forceKillSettleTimeout) {
        return;
      }
      forceKillTimeout = setTimeout(() => {
        forceKillTimeout = undefined;
        killProcessTree(child, "SIGKILL");
        forceKillSettleTimeout = setTimeout(() => {
          resolveOutput(child.exitCode, child.signalCode ?? "SIGKILL");
        }, PROCESS_FORCE_KILL_SETTLE_MS);
      }, PROCESS_TIMEOUT_KILL_GRACE_MS);
    };
    timeout = setTimeout(() => {
      timedOut = true;
      terminateChild("SIGTERM");
    }, options.timeoutSeconds * 1000);
    onAbort = (): void => {
      terminateChild("SIGTERM");
    };

    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.stdout.on("data", (chunk: Buffer) => {
      const appended: LimitedString = appendLimited(stdout, chunk, options.stdoutByteLimit ?? MAX_CAPTURED_OUTPUT_BYTES);
      stdout = appended.value;
      stdoutTruncated = stdoutTruncated || appended.truncated;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const appended: LimitedString = appendLimited(stderr, chunk, options.stderrByteLimit ?? MAX_CAPTURED_OUTPUT_BYTES);
      stderr = appended.value;
      stderrTruncated = stderrTruncated || appended.truncated;
    });
    child.once("error", (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearProcessTimers();
      if (options.signal) {
        options.signal.removeEventListener("abort", onAbort);
      }
      rejectProcess(error);
    });
    child.once("close", (exitCode: number | null, signal: NodeJS.Signals | null) => {
      resolveOutput(exitCode, signal);
    });
  });
}

type LimitedString = {
  value: string;
  truncated: boolean;
};

function appendLimited(existing: string, chunk: Buffer, limitBytes: number): LimitedString {
  const combined: Buffer = Buffer.concat([Buffer.from(existing), chunk]);
  if (combined.byteLength <= limitBytes) {
    return { value: combined.toString("utf8"), truncated: false };
  }
  return { value: combined.subarray(0, limitBytes).toString("utf8"), truncated: true };
}

function minimalEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
  };
}

function processEnvFor(env: Record<string, string> | undefined): Record<string, string> {
  return {
    ...minimalEnv(),
    ...(env ?? {}),
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
      retryable: false,
    };
  }
  if (error instanceof Error) {
    return {
      code: "local_capability_action_failed",
      message: error.message,
      retryable: false,
    };
  }
  return {
    code: "local_capability_action_failed",
    message: "Local capability action failed.",
    retryable: false,
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

async function waitForDevServerStartup(
  child: ChildProcessWithoutNullStreams,
  request: DevServerStartRequest,
): Promise<void> {
  const readiness: DevServerStartRequest["readiness"] = request.readiness;
  if (readiness === undefined || readiness.url === undefined) {
    await waitForDevServerNoFailure(child, request, DEV_SERVER_START_SETTLE_MS);
    return;
  }

  const readinessUrl: string = readiness.url;
  const allowedUrl: string = assertAllowedReadinessUrl(readinessUrl, request);
  const readinessTimeoutMs: number = Math.min(readiness.timeout_ms, devServerStartupTimeoutMs(request));
  await waitForReadinessUrl(child, request, allowedUrl, readinessTimeoutMs);
}

function devServerStartupTimeoutMs(request: DevServerStartRequest): number {
  return Math.max(1, request.timeout_seconds) * 1000;
}

function assertAllowedReadinessUrl(url: string, request: DevServerStartRequest): string {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch (error: unknown) {
    if (error instanceof TypeError) {
      throw new LocalCapabilityPolicyError("local_capability_dev_server_host_denied", `Readiness URL '${url}' is invalid.`);
    }
    throw error;
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new LocalCapabilityPolicyError("local_capability_dev_server_host_denied", `Readiness URL '${url}' must use http or https.`);
  }
  if (parsedUrl.hostname !== "127.0.0.1" && parsedUrl.hostname !== "localhost") {
    throw new LocalCapabilityPolicyError("local_capability_dev_server_host_denied", `Readiness URL host '${parsedUrl.hostname}' is not allowed.`);
  }

  const port: number = portForUrl(parsedUrl);
  if (port !== request.port) {
    throw new LocalCapabilityPolicyError(
      "local_capability_dev_server_port_denied",
      `Readiness URL port ${port} does not match dev server port ${request.port}.`,
    );
  }

  return parsedUrl.toString();
}

function portForUrl(url: URL): number {
  if (url.port.length > 0) {
    return Number.parseInt(url.port, 10);
  }
  return url.protocol === "https:" ? 443 : 80;
}

async function waitForReadinessUrl(
  child: ChildProcessWithoutNullStreams,
  request: DevServerStartRequest,
  url: string,
  timeoutMs: number,
): Promise<void> {
  const deadline: number = Date.now() + timeoutMs;
  let lastErrorMessage: string | undefined;

  while (Date.now() < deadline) {
    assertDevServerStillRunning(child, request.server_id);
    assertDevServerSessionActive(request);

    const remainingMs: number = deadline - Date.now();
    const probe: ReadinessProbeResult = await probeReadinessUrl(url, Math.max(1, Math.min(remainingMs, DEV_SERVER_READINESS_POLL_MS)));
    if (probe.ready) {
      return;
    }
    if (probe.errorMessage) {
      lastErrorMessage = probe.errorMessage;
    }

    const waitMs: number = Math.max(0, Math.min(deadline - Date.now(), DEV_SERVER_READINESS_POLL_MS));
    await waitForDevServerNoFailure(child, request, waitMs);
  }

  throw new LocalCapabilityPolicyError(
    "local_capability_timeout",
    `Dev server '${request.server_id}' did not become ready at '${url}' within ${timeoutMs}ms${
      lastErrorMessage ? `: ${lastErrorMessage}` : "."
    }`,
  );
}

type ReadinessProbeResult =
  | {
      ready: true;
    }
  | {
      ready: false;
      errorMessage?: string;
    };

async function probeReadinessUrl(url: string, timeoutMs: number): Promise<ReadinessProbeResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const response: Response = await fetch(url, { signal: controller.signal });
    if (response.ok) {
      return { ready: true };
    }
    return { ready: false, errorMessage: `HTTP ${response.status}` };
  } catch (error: unknown) {
    return { ready: false, errorMessage: error instanceof Error ? error.message : "Readiness probe failed." };
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForDevServerNoFailure(
  child: ChildProcessWithoutNullStreams,
  request: DevServerStartRequest,
  timeoutMs: number,
): Promise<void> {
  assertDevServerStillRunning(child, request.server_id);
  assertDevServerSessionActive(request);
  if (timeoutMs <= 0) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const settle = (result: "ready" | Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      child.off("exit", onExit);
      child.off("error", onError);
      if (result === "ready") {
        try {
          assertDevServerSessionActive(request);
          resolve();
        } catch (error: unknown) {
          reject(error);
        }
        return;
      }
      reject(result);
    };
    function onExit(exitCode: number | null, signal: NodeJS.Signals | null): void {
      settle(devServerExitError(request.server_id, exitCode, signal));
    }
    function onError(error: Error): void {
      settle(devServerProcessError(request.server_id, error));
    }
    timer = setTimeout(() => {
      settle("ready");
    }, timeoutMs);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

function assertDevServerStillRunning(child: ChildProcessWithoutNullStreams, serverId: string): void {
  if (child.exitCode !== null || child.signalCode !== null) {
    throw devServerExitError(serverId, child.exitCode, child.signalCode);
  }
}

function assertDevServerSessionActive(request: DevServerStartRequest): void {
  if (request.session_active && !request.session_active()) {
    throw new LocalCapabilityPolicyError("local_capability_lease_revoked", "Local action session stopped before dev server was ready.");
  }
}

function devServerExitError(
  serverId: string,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
): LocalCapabilityPolicyError {
  const exitDescription: string = signal ? `signal ${signal}` : `exit code ${exitCode ?? "unknown"}`;
  return new LocalCapabilityPolicyError(
    "local_capability_dev_server_start_failed",
    `Dev server '${serverId}' exited before it was ready with ${exitDescription}.`,
  );
}

function devServerProcessError(serverId: string, error: Error): LocalCapabilityPolicyError {
  return new LocalCapabilityPolicyError(
    "local_capability_dev_server_start_failed",
    `Dev server '${serverId}' failed to start: ${error.message}`,
  );
}

function killProcessTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  const pid: number | undefined = child.pid;
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && (error as { code?: unknown }).code === "ESRCH") {
      return;
    }
    child.kill(signal);
  }
}

async function terminateProcessTree(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
  timeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolve) => {
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let forceKillSettleTimer: NodeJS.Timeout | undefined;
    const settle = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
        forceKillTimer = undefined;
      }
      if (forceKillSettleTimer) {
        clearTimeout(forceKillSettleTimer);
        forceKillSettleTimer = undefined;
      }
      child.off("exit", settle);
      child.off("error", settle);
      resolve();
    };
    forceKillTimer = setTimeout(() => {
      forceKillTimer = undefined;
      killProcessTree(child, "SIGKILL");
      forceKillSettleTimer = setTimeout(() => {
        settle();
      }, PROCESS_FORCE_KILL_SETTLE_MS);
    }, Math.max(1, timeoutMs));
    child.once("exit", settle);
    child.once("error", settle);
    killProcessTree(child, signal);
  });
}

type LimitedBuffer = {
  buffer: Buffer;
  truncated: boolean;
};

type WorkspaceListResult = {
  entries: FilesystemListResult["entries"];
  truncated: boolean;
};

type TextPatchResult = {
  content: string;
  changed: boolean;
};

async function listWorkspaceEntries(root: string, options: FilesystemListOptions): Promise<WorkspaceListResult> {
  const entries: FilesystemListResult["entries"] = [];
  const includeHidden: boolean = options.includeHidden ?? false;
  const recursive: boolean = options.recursive ?? false;
  const maxDepth: number = recursive ? options.maxDepth ?? Number.POSITIVE_INFINITY : 1;
  const entryLimit: number | undefined = options.entryLimit;
  let truncated = false;

  const collect = async (directory: string, relativeDirectory: string, depth: number): Promise<void> => {
    if (truncated) {
      return;
    }
    const directoryEntries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of directoryEntries) {
      if (!includeHidden && entry.name.startsWith(".")) {
        continue;
      }
      if (entryLimit !== undefined && entries.length >= entryLimit) {
        truncated = true;
        return;
      }
      const name: string = relativeDirectory.length > 0 ? `${relativeDirectory}/${entry.name}` : entry.name;
      entries.push({
        name,
        type: entry.isFile() ? "file" : entry.isDirectory() ? "directory" : "other",
      });
      if (recursive && entry.isDirectory() && depth < maxDepth) {
        await collect(resolve(directory, entry.name), name, depth + 1);
      }
    }
  };

  await collect(root, "", 1);
  return { entries, truncated };
}

function applyByteRange(buffer: Buffer, range: FilesystemReadOptions["range"]): Buffer {
  if (!range) {
    return buffer;
  }
  const start: number = range.start ?? 0;
  const end: number = range.length === undefined ? buffer.byteLength : start + range.length;
  return buffer.subarray(start, end);
}

function limitBuffer(buffer: Buffer, limitBytes: number | undefined): LimitedBuffer {
  if (limitBytes === undefined || buffer.byteLength <= limitBytes) {
    return { buffer, truncated: false };
  }
  return {
    buffer: buffer.subarray(0, limitBytes),
    truncated: true,
  };
}

function encodeBuffer(buffer: Buffer, encoding: "utf8" | "base64"): string {
  return buffer.toString(encoding);
}

function decodeContent(content: string, encoding: "utf8" | "base64"): Buffer {
  return Buffer.from(content, encoding);
}

function sha256Hash(buffer: Buffer): string {
  return `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
}

async function assertWriteModeAllowed(path: string, options: FilesystemWriteOptions): Promise<void> {
  const mode: "create" | "overwrite" = options.mode ?? "overwrite";
  if (mode === "create") {
    if (await fileExists(path)) {
      throw new LocalCapabilityPolicyError("local_capability_action_failed", `Path '${path}' already exists.`);
    }
    return;
  }

  if (options.expectedBaseHash === undefined) {
    return;
  }
  const existingBytes: Buffer = await readFile(path);
  assertExpectedHash(existingBytes, options.expectedBaseHash);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const pathStat = await lstat(path);
    if (pathStat.isSymbolicLink()) {
      throw new LocalCapabilityPolicyError("local_capability_path_denied", `Path '${path}' is a dangling symlink.`);
    }
    return true;
  } catch (error: unknown) {
    if (isFileMissingError(error)) {
      return false;
    }
    throw error;
  }
}

async function readExistingFileForPatch(path: string, createIfMissing: boolean): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch (error: unknown) {
    if (isFileMissingError(error) && createIfMissing) {
      await assertMissingWritableTargetHasNoSymlink(path);
      return Buffer.alloc(0);
    }
    throw error;
  }
}

async function assertMissingWritableTargetHasNoSymlink(path: string): Promise<void> {
  try {
    const pathStat = await lstat(path);
    if (pathStat.isSymbolicLink()) {
      throw new LocalCapabilityPolicyError("local_capability_path_denied", `Path '${path}' is a dangling symlink.`);
    }
  } catch (error: unknown) {
    if (isFileMissingError(error)) {
      return;
    }
    throw error;
  }
}

function assertExpectedHash(buffer: Buffer, expectedHash: string): void {
  const actualHash: string = sha256Hash(buffer);
  if (actualHash !== expectedHash) {
    throw new LocalCapabilityPolicyError(
      "local_capability_expected_hash_mismatch",
      `Expected base hash '${expectedHash}' did not match current hash '${actualHash}'.`,
    );
  }
}

function applyUnifiedDiff(originalContent: string, patchContent: string): TextPatchResult {
  const originalLines: string[] = splitLinesPreservingEndings(originalContent);
  const patchLines: string[] = splitLinesPreservingEndings(patchContent);
  const outputLines: string[] = [];
  let originalIndex = 0;
  let patchIndex = 0;
  let changed = false;

  while (patchIndex < patchLines.length) {
    const line: string = patchLines[patchIndex] ?? "";
    if (!line.startsWith("@@")) {
      patchIndex += 1;
      continue;
    }

    const hunk = parseUnifiedDiffHunkHeader(line);
    while (originalIndex < hunk.oldStart - 1) {
      const originalLine: string | undefined = originalLines[originalIndex];
      if (originalLine === undefined) {
        throw new LocalCapabilityPolicyError("local_capability_action_failed", "Unified diff hunk starts beyond the end of the file.");
      }
      outputLines.push(originalLine);
      originalIndex += 1;
    }
    patchIndex += 1;

    while (patchIndex < patchLines.length && !(patchLines[patchIndex] ?? "").startsWith("@@")) {
      const hunkLine: string = patchLines[patchIndex] ?? "";
      if (hunkLine.startsWith("\\ ")) {
        patchIndex += 1;
        continue;
      }
      const prefix: string = hunkLine.slice(0, 1);
      const body: string = hunkLine.slice(1);
      if (prefix === " ") {
        assertPatchLineMatches(originalLines[originalIndex], body);
        outputLines.push(body);
        originalIndex += 1;
      } else if (prefix === "-") {
        assertPatchLineMatches(originalLines[originalIndex], body);
        originalIndex += 1;
        changed = true;
      } else if (prefix === "+") {
        outputLines.push(body);
        changed = true;
      } else if (hunkLine.startsWith("--- ") || hunkLine.startsWith("+++ ")) {
        break;
      } else {
        throw new LocalCapabilityPolicyError("local_capability_action_failed", `Unsupported unified diff line '${hunkLine.trimEnd()}'.`);
      }
      patchIndex += 1;
    }
  }

  while (originalIndex < originalLines.length) {
    const originalLine: string | undefined = originalLines[originalIndex];
    if (originalLine !== undefined) {
      outputLines.push(originalLine);
    }
    originalIndex += 1;
  }

  return {
    content: outputLines.join(""),
    changed,
  };
}

function splitLinesPreservingEndings(content: string): string[] {
  if (content.length === 0) {
    return [];
  }
  const matches: RegExpMatchArray | null = content.match(/.*(?:\r\n|\n|\r|$)/g);
  if (!matches) {
    return [content];
  }
  return matches.filter((line: string): boolean => line.length > 0);
}

function parseUnifiedDiffHunkHeader(header: string): { oldStart: number } {
  if (/^@@\s*$/.test(header)) {
    return { oldStart: 1 };
  }
  const match: RegExpMatchArray | null = /^@@ -(?<oldStart>\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(header);
  if (!match?.groups?.oldStart) {
    throw new LocalCapabilityPolicyError("local_capability_action_failed", `Invalid unified diff hunk header '${header.trimEnd()}'.`);
  }
  return { oldStart: Number.parseInt(match.groups.oldStart, 10) };
}

function assertPatchLineMatches(actual: string | undefined, expected: string): void {
  if (actual === expected) {
    return;
  }
  throw new LocalCapabilityPolicyError("local_capability_action_failed", "Unified diff context did not match the current file.");
}

async function assertRequestedPathsInsideWorkspace(paths: string[], workspaceRoot: string): Promise<void> {
  for (const path of paths) {
    const candidate: string = await resolveCandidatePath(path, workspaceRoot);
    await assertCandidateInsideWorkspace(candidate, workspaceRoot);
  }
}

function parseGitStatusBranch(stdout: string): string | undefined {
  const firstLine: string | undefined = stdout.split(/\r?\n/, 1)[0];
  if (!firstLine?.startsWith("## ")) {
    return undefined;
  }
  const branch = firstLine.slice(3).split("...", 1)[0]?.trim();
  return branch && branch !== "HEAD (no branch)" ? branch : undefined;
}

function gitStatusBranchResult(
  operation: LocalGitAction,
  options: GitCommandOptions,
  stdout: string,
): { branch: string } | Record<string, never> {
  if (operation !== "status" || !options.status?.includeBranch) {
    return {};
  }
  const branch: string | undefined = parseGitStatusBranch(stdout);
  return branch ? { branch } : {};
}
