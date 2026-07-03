import type {
  HcpHarnessEventPayload,
  LocalActionErrorCode,
  LocalActionErrorPayload,
  LocalActionRequestPayload,
  LocalActionResponseAuditEvents,
  LocalActionResponsePayload,
} from "@harness-control/protocol";
import { parseLocalActionErrorPayload, parseLocalActionResponsePayload } from "@harness-control/protocol";

import { LocalCapabilityPolicyError } from "./index.js";
import {
  LocalCapabilityExecutionError,
  LocalCapabilityExecutor,
  type LocalCapabilityExecutionContext,
  type LocalCapabilityExecutionEvent,
} from "./executors.js";

export type LocalActionContextResolver = (request: LocalActionRequestPayload) => Promise<LocalCapabilityExecutionContext>;

export type LocalActionEventEmitter = (
  sessionId: string,
  turnId: string,
  events: LocalCapabilityExecutionEvent[],
) => HcpHarnessEventPayload[];

export type LocalActionDispatcherOptions = {
  executor: LocalCapabilityExecutor;
  resolveContext: LocalActionContextResolver;
  emitEvents: LocalActionEventEmitter;
  now?: () => Date;
};

export type LocalActionDispatchOutcome =
  | {
      type: "response";
      payload: LocalActionResponsePayload;
      events: HcpHarnessEventPayload[];
    }
  | {
      type: "error";
      payload: LocalActionErrorPayload;
      events: HcpHarnessEventPayload[];
    };

export class LocalActionDispatcher {
  readonly #executor: LocalCapabilityExecutor;
  readonly #resolveContext: LocalActionContextResolver;
  readonly #emitEvents: LocalActionEventEmitter;
  readonly #now: () => Date;
  readonly #stoppedSessionIds = new Set<string>();

  constructor(options: LocalActionDispatcherOptions) {
    this.#executor = options.executor;
    this.#resolveContext = options.resolveContext;
    this.#emitEvents = options.emitEvents;
    this.#now = options.now ?? (() => new Date());
  }

  async dispatch(request: LocalActionRequestPayload): Promise<LocalActionDispatchOutcome> {
    if (this.#stoppedSessionIds.has(request.attribution.session_id)) {
      return this.#errorOutcome(
        request,
        new LocalCapabilityPolicyError("local_capability_lease_revoked", "Local action session has already stopped."),
        [],
      );
    }
    let context: LocalCapabilityExecutionContext;
    try {
      context = await this.#resolveContext(request);
    } catch (error: unknown) {
      return this.#errorOutcome(request, error, []);
    }

    try {
      return await this.#dispatchWithContext(request, context);
    } catch (error: unknown) {
      const executionEvents: LocalCapabilityExecutionEvent[] =
        error instanceof LocalCapabilityExecutionError ? error.events : [];
      return this.#errorOutcome(request, error, executionEvents);
    }
  }

  duplicatePayloadMismatch(request: LocalActionRequestPayload): LocalActionDispatchOutcome {
    const error = new LocalCapabilityPolicyError(
      "local_capability_action_failed",
      `Local action request '${request.request_id}' was already seen with a different payload.`,
    );
    return this.#errorOutcome(request, error, [failedEventFor(request, error)]);
  }

  markSessionActive(sessionId: string): void {
    this.#stoppedSessionIds.delete(sessionId);
  }

  async stopDevServersForSession(sessionId: string): Promise<void> {
    this.#stoppedSessionIds.add(sessionId);
    await this.#executor.stopDevServersForSession(sessionId);
  }

  async #dispatchWithContext(
    request: LocalActionRequestPayload,
    context: LocalCapabilityExecutionContext,
  ): Promise<LocalActionDispatchOutcome> {
    switch (request.action) {
      case "local.filesystem.read": {
        const actionResult = await this.#executor.readFile(context, request.input.path, {
          encoding: request.input.encoding ?? "utf8",
          ...(request.input.range ? { range: request.input.range } : {}),
          ...(request.output_limits.content_bytes ? { contentByteLimit: request.output_limits.content_bytes } : {}),
        });
        const events: HcpHarnessEventPayload[] = this.#emitRequestEvents(request, actionResult.events);
        const payload: LocalActionResponsePayload = parseLocalActionResponsePayload({
          ...this.#responseBase(request, events),
          action: request.action,
          output: {
            path: actionResult.result.path,
            content: actionResult.result.content,
            encoding: actionResult.result.encoding,
            hash: actionResult.result.hash,
            ...(actionResult.result.truncated ? { truncated: true } : {}),
          },
        });
        return { type: "response", payload, events };
      }
      case "local.filesystem.list": {
        const actionResult = await this.#executor.listDirectory(context, request.input.path, {
          recursive: request.input.recursive ?? false,
          includeHidden: request.input.include_hidden ?? false,
          ...(request.input.max_depth ? { maxDepth: request.input.max_depth } : {}),
          ...(request.output_limits.entries ? { entryLimit: request.output_limits.entries } : {}),
        });
        const events: HcpHarnessEventPayload[] = this.#emitRequestEvents(request, actionResult.events);
        const payload: LocalActionResponsePayload = parseLocalActionResponsePayload({
          ...this.#responseBase(request, events),
          action: request.action,
          output: {
            path: actionResult.result.path,
            entries: actionResult.result.entries,
            ...(actionResult.result.truncated ? { truncated: true } : {}),
          },
        });
        return { type: "response", payload, events };
      }
      case "local.filesystem.write": {
        const actionResult = await this.#executor.writeFile(context, request.input.path, request.input.content, {
          encoding: request.input.encoding ?? "utf8",
          mode: request.input.mode,
          createParents: request.input.create_parents,
          ...(request.input.expected_base_hash ? { expectedBaseHash: request.input.expected_base_hash } : {}),
        });
        const events: HcpHarnessEventPayload[] = this.#emitRequestEvents(request, actionResult.events);
        const payload: LocalActionResponsePayload = parseLocalActionResponsePayload({
          ...this.#responseBase(request, events),
          action: request.action,
          output: {
            path: actionResult.result.path,
            bytes_written: actionResult.result.bytes_written,
            new_hash: actionResult.result.new_hash,
          },
        });
        return { type: "response", payload, events };
      }
      case "local.filesystem.patch": {
        const actionResult = await this.#executor.patchFile(context, request.input.path, {
          expectedBaseHash: request.input.expected_base_hash,
          patchContent: request.input.patch.content,
          createIfMissing: request.input.create_if_missing ?? false,
        });
        const events: HcpHarnessEventPayload[] = this.#emitRequestEvents(request, actionResult.events);
        const payload: LocalActionResponsePayload = parseLocalActionResponsePayload({
          ...this.#responseBase(request, events),
          action: request.action,
          output: {
            path: actionResult.result.path,
            changed: actionResult.result.changed,
            new_hash: actionResult.result.new_hash,
          },
        });
        return { type: "response", payload, events };
      }
      case "local.git.status": {
        const actionResult = await this.#executor.git(context, "status", {
          status: {
            porcelainVersion: request.input.porcelain_version,
            includeBranch: request.input.include_branch ?? false,
            ...(request.output_limits.status_bytes ? { outputByteLimit: request.output_limits.status_bytes } : {}),
          },
        });
        const events: HcpHarnessEventPayload[] = this.#emitRequestEvents(request, actionResult.events);
        const payload: LocalActionResponsePayload = parseLocalActionResponsePayload({
          ...this.#responseBase(request, events),
          action: request.action,
          output: {
            porcelain: actionResult.result.stdout,
            ...(actionResult.result.branch ? { branch: actionResult.result.branch } : {}),
            ...(actionResult.result.stdout_truncated ? { truncated: true } : {}),
          },
        });
        return { type: "response", payload, events };
      }
      case "local.git.diff": {
        const actionResult = await this.#executor.git(context, "diff", {
          diff: {
            ...(request.input.paths ? { paths: request.input.paths } : {}),
            staged: request.input.staged ?? false,
            ...(request.input.base_ref ? { baseRef: request.input.base_ref } : {}),
            ...(request.output_limits.diff_bytes ? { outputByteLimit: request.output_limits.diff_bytes } : {}),
          },
        });
        const events: HcpHarnessEventPayload[] = this.#emitRequestEvents(request, actionResult.events);
        const payload: LocalActionResponsePayload = parseLocalActionResponsePayload({
          ...this.#responseBase(request, events),
          action: request.action,
          output: {
            diff: actionResult.result.stdout,
            ...(actionResult.result.stdout_truncated ? { truncated: true } : {}),
          },
        });
        return { type: "response", payload, events };
      }
      case "local.shell.exec": {
        const actionResult = await this.#executor.shell(context, {
          executable: request.input.executable,
          argv: request.input.argv,
          cwd: request.input.cwd,
          use_shell: request.input.use_shell,
          env: request.input.env ?? {},
          timeout_seconds: timeoutSecondsFor(request),
          ...(request.input.stdin !== undefined ? { stdin: request.input.stdin } : {}),
          ...(request.output_limits.stdout_bytes ? { stdout_byte_limit: request.output_limits.stdout_bytes } : {}),
          ...(request.output_limits.stderr_bytes ? { stderr_byte_limit: request.output_limits.stderr_bytes } : {}),
        });
        const events: HcpHarnessEventPayload[] = this.#emitRequestEvents(request, actionResult.events);
        const payload: LocalActionResponsePayload = parseLocalActionResponsePayload({
          ...this.#responseBase(request, events),
          action: request.action,
          output: {
            executable: actionResult.result.executable,
            argv: actionResult.result.argv,
            cwd: actionResult.result.cwd,
            exit_code: actionResult.result.exit_code,
            signal: actionResult.result.signal,
            stdout: actionResult.result.stdout,
            stderr: actionResult.result.stderr,
            timed_out: actionResult.result.timed_out,
            ...(actionResult.result.stdout_truncated ? { stdout_truncated: true } : {}),
            ...(actionResult.result.stderr_truncated ? { stderr_truncated: true } : {}),
          },
        });
        return { type: "response", payload, events };
      }
      case "local.dev_server.start": {
        const actionResult = await this.#executor.startDevServer(context, {
          server_id: request.input.server_id,
          executable: request.input.executable,
          argv: request.input.argv,
          cwd: request.input.cwd,
          host: request.input.host,
          port: request.input.port,
          use_shell: request.input.use_shell,
          env: request.input.env ?? {},
          timeout_seconds: timeoutSecondsFor(request),
          ...(request.input.readiness ? { readiness: request.input.readiness } : {}),
          session_active: () => !this.#stoppedSessionIds.has(context.session_id),
        });
        const events: HcpHarnessEventPayload[] = this.#emitRequestEvents(request, actionResult.events);
        const payload: LocalActionResponsePayload = parseLocalActionResponsePayload({
          ...this.#responseBase(request, events),
          action: request.action,
          output: {
            server_id: actionResult.result.server_id,
            pid: actionResult.result.pid,
            host: actionResult.result.host,
            port: actionResult.result.port,
            cwd: actionResult.result.cwd,
            started_at: actionResult.result.started_at,
            url: `http://${actionResult.result.host}:${actionResult.result.port}`,
          },
        });
        return { type: "response", payload, events };
      }
      case "local.dev_server.stop": {
        const actionResult = await this.#executor.stopDevServer(
          context,
          request.input.server_id,
          request.input.signal ?? "SIGTERM",
          request.input.timeout_ms ?? 5_000,
        );
        const events: HcpHarnessEventPayload[] = this.#emitRequestEvents(request, actionResult.events);
        const payload: LocalActionResponsePayload = parseLocalActionResponsePayload({
          ...this.#responseBase(request, events),
          action: request.action,
          output: {
            server_id: actionResult.result.server_id,
            stopped_at: this.#now().toISOString(),
          },
        });
        return { type: "response", payload, events };
      }
    }
  }

  #responseBase(request: LocalActionRequestPayload, events: HcpHarnessEventPayload[]) {
    return {
      request_id: request.request_id,
      status: "completed" as const,
      completed_at: this.#now().toISOString(),
      attribution: request.attribution,
      lease: request.lease,
      audit_events: responseAuditEvents(events),
    };
  }

  #errorOutcome(
    request: LocalActionRequestPayload,
    error: unknown,
    executionEvents: LocalCapabilityExecutionEvent[],
  ): LocalActionDispatchOutcome {
    const emittedEvents: HcpHarnessEventPayload[] =
      executionEvents.length > 0 ? this.#emitErrorEvents(request, executionEvents) : [];
    const localError = toLocalActionError(error);
    const payload: LocalActionErrorPayload = parseLocalActionErrorPayload({
      request_id: request.request_id,
      action: request.action,
      status: localError.code === "local_capability_timeout" ? "timed_out" : localError.code === "local_capability_cancelled" ? "cancelled" : "failed",
      failed_at: this.#now().toISOString(),
      attribution: request.attribution,
      lease: request.lease,
      error: localError,
      audit_events: errorAuditEvents(emittedEvents),
    });
    return { type: "error", payload, events: emittedEvents };
  }

  #emitRequestEvents(
    request: LocalActionRequestPayload,
    events: LocalCapabilityExecutionEvent[],
  ): HcpHarnessEventPayload[] {
    const enrichedEvents: LocalCapabilityExecutionEvent[] = events.map((event: LocalCapabilityExecutionEvent) => ({
      event_type: event.event_type,
      data: {
        ...event.data,
        input: {
          request_id: request.request_id,
          protocol_action: request.action,
          ...(event.data.input === undefined ? {} : { details: event.data.input }),
        },
      },
    }));
    return this.#emitEvents(request.attribution.session_id, request.attribution.turn_id, enrichedEvents);
  }

  #emitErrorEvents(
    request: LocalActionRequestPayload,
    events: LocalCapabilityExecutionEvent[],
  ): HcpHarnessEventPayload[] {
    try {
      return this.#emitRequestEvents(request, events);
    } catch (error: unknown) {
      if (error instanceof LocalCapabilityPolicyError) {
        return [];
      }
      throw error;
    }
  }
}

function timeoutSecondsFor(request: LocalActionRequestPayload): number {
  const timeoutMs: number = request.cancellation.timeout_ms ?? 30_000;
  return Math.max(1, Math.ceil(timeoutMs / 1000));
}

function responseAuditEvents(events: HcpHarnessEventPayload[]): LocalActionResponseAuditEvents {
  const started: HcpHarnessEventPayload | undefined = events.find(
    (event: HcpHarnessEventPayload): boolean => event.event_type === "local_capability.action.started",
  );
  const completed: HcpHarnessEventPayload | undefined = events.find(
    (event: HcpHarnessEventPayload): boolean => event.event_type === "local_capability.action.completed",
  );
  return {
    ...(started ? { started: { event_type: "local_capability.action.started" as const, sequence: started.sequence } } : {}),
    completed: completed
      ? { event_type: "local_capability.action.completed" as const, sequence: completed.sequence }
      : { event_type: "local_capability.action.completed" as const },
  };
}

function errorAuditEvents(events: HcpHarnessEventPayload[]): LocalActionErrorPayload["audit_events"] {
  const started: HcpHarnessEventPayload | undefined = events.find(
    (event: HcpHarnessEventPayload): boolean => event.event_type === "local_capability.action.started",
  );
  const failed: HcpHarnessEventPayload | undefined = events.find(
    (event: HcpHarnessEventPayload): boolean => event.event_type === "local_capability.action.failed",
  );
  return {
    ...(started ? { started: { event_type: "local_capability.action.started" as const, sequence: started.sequence } } : {}),
    failed: failed
      ? { event_type: "local_capability.action.failed" as const, sequence: failed.sequence }
      : { event_type: "local_capability.action.failed" as const },
  };
}

function toLocalActionError(error: unknown): {
  code: LocalActionErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
} {
  const cause: unknown = error instanceof LocalCapabilityExecutionError ? error.cause : error;
  if (cause instanceof LocalCapabilityPolicyError) {
    return {
      code: mapPolicyErrorCode(cause.code),
      message: cause.message,
      retryable: false,
    };
  }
  if (cause instanceof Error) {
    return {
      code: mapProcessErrorCode(cause),
      message: cause.message,
      retryable: false,
    };
  }
  return {
    code: "local_capability_action_failed",
    message: "Local action failed.",
    retryable: false,
  };
}

function failedEventFor(
  request: LocalActionRequestPayload,
  error: LocalCapabilityPolicyError,
): LocalCapabilityExecutionEvent {
  return {
    event_type: "local_capability.action.failed",
    data: {
      lease_id: request.lease.lease_id,
      run_id: request.lease.run_id,
      workspace_id: request.attribution.workspace_id,
      provider_instance_id: request.attribution.provider_instance_id,
      capability_id: request.lease.capability_id,
      action: request.action,
      status: "failed",
      error: {
        code: mapPolicyErrorCode(error.code),
        message: error.message,
        retryable: false,
      },
    },
  };
}

function mapPolicyErrorCode(code: string): LocalActionErrorCode {
  switch (code) {
    case "local_capability_lease_missing":
    case "local_capability_lease_expired":
    case "local_capability_lease_revoked":
    case "local_capability_session_mismatch":
    case "local_capability_workspace_mismatch":
    case "local_capability_provider_mismatch":
    case "local_capability_scope_not_granted":
    case "local_capability_approval_required":
    case "local_capability_expected_hash_mismatch":
    case "local_capability_output_limit_exceeded":
    case "local_capability_timeout":
    case "local_capability_cancelled":
    case "local_capability_command_denied":
    case "local_capability_dev_server_exists":
    case "local_capability_dev_server_not_found":
      return code;
    case "local_capability_scope_unavailable":
    case "local_capability_not_granted":
    case "local_capability_unavailable":
    case "local_capability_provider_unsupported":
    case "local_capability_max_calls_exceeded":
      return "local_capability_scope_not_granted";
    case "local_capability_sandbox_read_only":
      return "local_capability_sandbox_denied";
    case "local_capability_path_denied":
    case "local_capability_cwd_denied":
    case "local_capability_path_unresolved":
      return "local_capability_path_denied";
    case "local_capability_shell_denied":
    case "local_capability_timeout_exceeded":
    case "local_capability_network_policy_unsupported":
    case "local_capability_env_denied":
    case "local_capability_executable_denied":
    case "local_capability_executable_not_allowed":
    case "local_capability_argv_denied":
    case "local_capability_command_policy_required":
    case "local_capability_command_policy_invalid":
    case "local_capability_dev_server_host_denied":
    case "local_capability_dev_server_port_denied":
      return "local_capability_command_denied";
    case "local_capability_dev_server_start_failed":
      return "local_capability_process_failed";
    default:
      return "local_capability_action_failed";
  }
}

function mapProcessErrorCode(error: Error): LocalActionErrorCode {
  return error.message.startsWith("spawn ") ? "local_capability_process_failed" : "local_capability_action_failed";
}
