import { z } from "zod";

export const HCP_VERSION = "hcp.v0" as const;
export const HCP_METADATA_MAX_ENCODED_BYTES = 16 * 1024;
export const HCP_PAYLOAD_MAX_ENCODED_BYTES = 1024 * 1024;
export const HCP_MESSAGE_MAX_ENCODED_BYTES = HCP_METADATA_MAX_ENCODED_BYTES + HCP_PAYLOAD_MAX_ENCODED_BYTES + 64 * 1024;

export type HcpVersion = typeof HCP_VERSION;

export const HOST_LIFECYCLE_MESSAGE_TYPES = [
  "host.hello",
  "host.accepted",
  "host.rejected",
  "host.heartbeat",
  "host.capabilities.updated",
  "host.replay.unavailable",
  "host.workspaces.request",
  "host.workspaces.result",
] as const;

export const CONTROL_PLANE_COMMAND_MESSAGE_TYPES = [
  "harness.session.start",
  "harness.session.snapshot.request",
  "harness.turn.send",
  "harness.turn.cancel",
  "harness.session.stop",
  "harness.approval.respond",
  "harness.input.respond",
  "tool_servers.detach",
] as const;

export const COMMAND_ACK_MESSAGE_TYPES = ["hcp.command.ack", "hcp.command.nack"] as const;

export const LOCAL_ACTION_MESSAGE_TYPES = [
  "local.action.request",
  "local.action.response",
  "local.action.error",
] as const;

export const RUNTIME_EVENT_MESSAGE_TYPES = ["harness.event"] as const;
export const SESSION_SNAPSHOT_MESSAGE_TYPES = ["harness.session.snapshot"] as const;

export const KNOWN_HCP_EVENT_TYPES = [
  "session.started",
  "session.configured",
  "session.state.changed",
  "session.exited",
  "thread.started",
  "thread.state.changed",
  "thread.metadata.updated",
  "thread.token_usage.updated",
  "thread.realtime.started",
  "thread.realtime.item_added",
  "thread.realtime.audio_delta",
  "thread.realtime.error",
  "thread.realtime.closed",
  "auth.status",
  "account.updated",
  "account.rate_limits.updated",
  "turn.started",
  "turn.completed",
  "turn.failed",
  "turn.aborted",
  "turn.cancelled",
  "turn.plan.updated",
  "turn.proposed.delta",
  "turn.proposed.completed",
  "turn.diff.updated",
  "item.started",
  "item.updated",
  "item.completed",
  "content.delta",
  "reasoning.delta",
  "command.started",
  "command.completed",
  "local_capability.lease.created",
  "local_capability.lease.revoked",
  "local_capability.lease.expired",
  "local_capability.action.started",
  "local_capability.action.completed",
  "local_capability.action.failed",
  "file_change.started",
  "file_change.completed",
  "mcp_tool.started",
  "mcp_tool.completed",
  "mcp.status.updated",
  "mcp.oauth.completed",
  "approval.requested",
  "approval.resolved",
  "input.requested",
  "input.resolved",
  "request.opened",
  "request.resolved",
  "user_input.requested",
  "user_input.resolved",
  "task.started",
  "task.progress",
  "task.completed",
  "hook.started",
  "hook.progress",
  "hook.completed",
  "tool.progress",
  "tool.summary",
  "model.rerouted",
  "config.warning",
  "deprecation.notice",
  "files.persisted",
  "workspace.preflight.completed",
  "usage.updated",
  "runtime.warning",
  "runtime.error",
] as const;

export type HostLifecycleMessageType = (typeof HOST_LIFECYCLE_MESSAGE_TYPES)[number];
export type ControlPlaneCommandMessageType = (typeof CONTROL_PLANE_COMMAND_MESSAGE_TYPES)[number];
export type CommandAckMessageType = (typeof COMMAND_ACK_MESSAGE_TYPES)[number];
export type LocalActionMessageType = (typeof LOCAL_ACTION_MESSAGE_TYPES)[number];
export type RuntimeEventMessageType = (typeof RUNTIME_EVENT_MESSAGE_TYPES)[number];
export type SessionSnapshotMessageType = (typeof SESSION_SNAPSHOT_MESSAGE_TYPES)[number];
export type KnownHcpEventType = (typeof KNOWN_HCP_EVENT_TYPES)[number];
export type ProviderExtensionEventType = `provider.${string}`;
export type AppExtensionEventType = `extension.${string}`;
export type HcpEventType = KnownHcpEventType | ProviderExtensionEventType | AppExtensionEventType;

export type HcpEnvelope<TType extends string, TPayload> = {
  id: string;
  type: TType;
  version: HcpVersion;
  sent_at: string;
  payload: TPayload;
  metadata?: HcpMetadata;
};

export type HcpMetadata = Record<string, unknown>;

export type HcpError = {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
};

export type HcpCommandAckPayload = {
  command_id: string;
  accepted_at: string;
  duplicate: boolean;
};

export type HcpCommandNackPayload = {
  command_id: string;
  rejected_at: string;
  error: HcpError;
};

export type HcpAckPayload = HcpCommandAckPayload;
export type HcpNackPayload = HcpCommandNackPayload;

export type HostResumeCursor = {
  sessions: Array<{
    session_id: string;
    last_event_sequence: number;
  }>;
};

export type HostRetainedEventRanges = {
  sessions: Array<{
    session_id: string;
    first_event_sequence: number;
    last_event_sequence: number;
  }>;
};

export type HcpHostHelloPayload = {
  runner_id: string;
  host_id: string;
  runner_version: string;
  supported_protocol_versions: HcpVersion[];
  capabilities: string[];
  retained_events?: HostRetainedEventRanges;
};

export type HcpHostAcceptedPayload = {
  protocol_version: HcpVersion;
  heartbeat_interval_seconds: number;
  resume?: HostResumeCursor;
};

export type HcpHostRejectedPayload = {
  reason: string;
  supported_protocol_versions?: HcpVersion[];
};

export type HcpHostHeartbeatPayload = {
  host_id: string;
  status: "online" | "degraded" | "draining";
  active_sessions: number;
};

export type LocalCapabilityId = "filesystem" | "git" | "shell" | "dev_server" | "browser" | string;

export type LocalCapabilitySnapshot = {
  id: LocalCapabilityId;
  status: "available" | "unavailable" | "disabled" | "unknown";
  scopes: string[];
  approval_required: boolean;
  message?: string;
};

export type ProviderAuthSnapshot = {
  status: "authenticated" | "unauthenticated" | "unknown";
  type?: string;
  label?: string;
  email?: string;
};

export type HarnessOptionDescriptor = {
  id: string;
  label: string;
  type: "select" | "boolean" | "number" | "string";
  values?: Array<{ value: string; label: string }>;
  default_value?: string | boolean | number;
  current_value?: string | boolean | number;
  prompt_injected_values?: string[];
};

export type HarnessModel = {
  id: string;
  label: string;
  is_default?: boolean;
  capabilities: {
    option_descriptors: HarnessOptionDescriptor[];
  };
};

export type HarnessExecutionCapabilities = {
  streaming: boolean;
  multi_turn: boolean;
  session_continuation: boolean;
  sandbox_modes: Array<"read_only" | "workspace_write" | "danger_full_access">;
  approval_policies: Array<"ask" | "auto_edits" | "full_access">;
};

export type HarnessProviderSnapshot = {
  execution_capabilities?: HarnessExecutionCapabilities;
  provider_instance_id: string;
  driver_kind: string;
  display_name?: string;
  accent_color?: string;
  enabled: boolean;
  installed: boolean;
  version?: string;
  status: "ready" | "unavailable" | "unauthenticated" | "disabled" | "error" | "unknown";
  availability: "available" | "unavailable";
  message?: string;
  checked_at?: string;
  continuation_group_key?: string;
  auth?: ProviderAuthSnapshot;
  models: HarnessModel[];
  hidden_models?: string[];
  model_order?: string[];
  favorite_models?: string[];
  local_capabilities?: LocalCapabilityId[];
  version_advisory?: {
    level: "info" | "warning" | "blocking";
    message: string;
  } | null;
  update_state?: {
    available: boolean;
    latest_version?: string;
    command?: string;
  } | null;
};

export type HcpWorkspaceSnapshot = {
  display_name?: string;
  id: string;
  path: string;
  git_remote?: string;
};

export type HcpMcpStdioProfileSnapshot = {
  id: string;
  provider_instance_ids: string[];
  allowed_tools?: string[];
  denied_tools?: string[];
};

export type HcpHostCapabilitiesUpdatedPayload = {
  providers: HarnessProviderSnapshot[];
  local_capabilities: LocalCapabilitySnapshot[];
  workspaces: HcpWorkspaceSnapshot[];
  workspace_management?: HcpWorkspaceManagement;
  mcp_stdio_profiles?: HcpMcpStdioProfileSnapshot[];
};

export type HcpHostReplayUnavailablePayload = {
  session_id: string;
  requested_after_sequence: number;
  reason: "no_retained_events" | "cursor_outside_retention";
  retained_range?: {
    first_event_sequence: number;
    last_event_sequence: number;
  };
};

export type HarnessProviderReference = {
  execution_host_id: string;
  provider_instance_id: string;
  driver_kind: string;
  continuation_group_key?: string;
};

export type HarnessModelSelection = {
  model: string;
  options?: Array<{
    id: string;
    value: string | boolean | number;
  }>;
};

export type WorkspacePreflight = {
  workspace_id: string;
  expected_git_remote?: string;
  expected_branch?: string;
  allow_dirty_worktree?: boolean;
  required_paths?: string[];
};

export type WorkspacePreflightCompleted = {
  workspace_id: string;
  cwd: string;
  branch?: string;
  commit?: string;
  dirty?: boolean;
  remote?: string;
  result: "passed" | "failed" | "warning";
  message?: string;
};

export type CommandPolicy = {
  allowed_executables?: string[];
  denied_executables?: string[];
  argv_patterns?: string[];
  cwd_policy: "selected_workspace_only";
  env_policy: "minimal" | "allowlisted";
  allow_shell: boolean;
  timeout_seconds: number;
  network_policy: "inherit" | "disabled" | "allowlisted";
};

export type LocalCapabilityGrant = {
  id: LocalCapabilityId;
  scopes: string[];
  approval_policy?: "ask" | "auto_edits" | "full_access";
  command_policy?: CommandPolicy;
  max_calls?: number;
};

export type LocalCapabilityLease = {
  lease_id: string;
  org_id: string;
  actor_id?: string;
  workflow_id: string;
  run_id: string;
  node_id: string;
  hcp_session_id: string;
  execution_host_id: string;
  provider_instance_id: string;
  workspace_id: string;
  issued_at: string;
  expires_at: string;
  policy_version: string;
  capabilities: LocalCapabilityGrant[];
};

export type McpProofOfPossession = {
  scheme: "runner_signed_request";
  key_id: string;
  required_headers: string[];
};

export type StreamableHttpMcpServerAttachment = {
  name: string;
  transport: "streamable_http";
  url: string;
  headers: Record<string, string>;
  lease_id: string;
  proof_of_possession: McpProofOfPossession;
  expires_at?: string;
  allowed_tools?: string[];
  denied_tools?: string[];
};

export type RunnerStdioMcpProfileAttachment = {
  name: string;
  transport: "runner_stdio_profile";
  profile_id: string;
  allowed_tools?: string[];
  denied_tools?: string[];
};

export type McpServerAttachment = StreamableHttpMcpServerAttachment | RunnerStdioMcpProfileAttachment;

export type HcpSessionStartPayload = {
  session_id: string;
  workspace_id: string;
  provider_instance_id: string;
  driver_kind: string;
  continuation_group_key?: string;
  cwd: string;
  sandbox_mode: "read_only" | "workspace_write" | "danger_full_access";
  approval_policy: "ask" | "auto_edits" | "full_access";
  continue_session: boolean;
  model_selection: HarnessModelSelection;
  workspace_preflight?: WorkspacePreflight;
  local_capability_lease?: LocalCapabilityLease;
  mcp_servers: McpServerAttachment[];
};

export type HcpSessionSnapshotRequestPayload = {
  session_id: string;
};

export type HcpTurnSendPayload = {
  session_id: string;
  turn_id: string;
  input: string;
  model_selection?: HarnessModelSelection;
};

export type HcpTurnCancelPayload = {
  session_id: string;
  turn_id: string;
  reason?: string;
};

export type HcpSessionStopPayload = {
  session_id: string;
  reason?: string;
};

export type HcpApprovalResponsePayload = {
  request_id: string;
  session_id: string;
  turn_id: string;
  action_hash: string;
  decision: "accept" | "accept_for_session" | "decline" | "cancel";
  actor_id: string;
};

export type HcpInputResponsePayload = {
  request_id: string;
  session_id: string;
  turn_id: string;
  actor_id: string;
  value?: unknown;
  cancelled?: boolean;
};

export type ToolServersDetachPayload = {
  session_id: string;
  names: string[];
  reason?: string;
};

export const LOCAL_ACTION_TYPES = [
  "local.filesystem.read",
  "local.filesystem.list",
  "local.filesystem.write",
  "local.filesystem.patch",
  "local.git.status",
  "local.git.diff",
  "local.shell.exec",
  "local.dev_server.start",
  "local.dev_server.stop",
] as const;

export type LocalActionType = (typeof LOCAL_ACTION_TYPES)[number];
export type LocalActionProtocolCapabilityId = "filesystem" | "git" | "shell" | "dev_server";

export type LocalActionAttribution = {
  session_id: string;
  turn_id: string;
  workspace_id: string;
  provider_instance_id: string;
  run_id: string;
};

export type LocalActionLeaseBinding = {
  lease_id: string;
  capability_id: LocalActionProtocolCapabilityId;
  scope: string;
  run_id: string;
  hcp_session_id: string;
  execution_host_id: string;
  provider_instance_id: string;
  workspace_id: string;
  expires_at?: string;
};

export type LocalActionSandboxRequirements = {
  mode: HcpSessionStartPayload["sandbox_mode"];
  workspace_root: string;
  cwd: string;
  requires_workspace_containment: boolean;
};

export type LocalActionOutputLimits = {
  content_bytes?: number;
  entries?: number;
  status_bytes?: number;
  diff_bytes?: number;
  stdout_bytes?: number;
  stderr_bytes?: number;
};

export type LocalActionCancellation = {
  cancellable: boolean;
  timeout_ms?: number;
  token?: string;
};

export type LocalActionApprovalBinding =
  | {
      status: "not_required";
    }
  | {
      status: "approved";
      request_id: string;
      action_hash: string;
      decision: "accept" | "accept_for_session";
      actor_id: string;
      approved_at: string;
    };

export type LocalActionAuditMapping = {
  started_event_type: "local_capability.action.started";
  completed_event_type: "local_capability.action.completed";
  failed_event_type: "local_capability.action.failed";
};

export type LocalActionAuditEventRef = {
  event_type:
    | "local_capability.action.started"
    | "local_capability.action.completed"
    | "local_capability.action.failed";
  sequence?: number;
};

export type LocalActionResponseAuditEvents = {
  started?: LocalActionAuditEventRef;
  completed: LocalActionAuditEventRef;
};

export type LocalActionErrorAuditEvents = {
  started?: LocalActionAuditEventRef;
  failed: LocalActionAuditEventRef;
};

export type LocalFilesystemReadInput = {
  path: string;
  encoding?: "utf8" | "base64";
  range?: {
    start?: number;
    length?: number;
  };
};

export type LocalFilesystemListInput = {
  path: string;
  recursive?: boolean;
  include_hidden?: boolean;
  max_depth?: number;
};

export type LocalFilesystemWriteInput = {
  path: string;
  content: string;
  encoding?: "utf8" | "base64";
  mode: "create" | "overwrite";
  create_parents: boolean;
  expected_base_hash?: string;
};

export type LocalFilesystemPatchInput = {
  path: string;
  expected_base_hash: string;
  patch: {
    format: "unified_diff";
    content: string;
  };
  create_if_missing?: boolean;
};

export type LocalGitStatusInput = {
  porcelain_version: "v1" | "v2";
  include_branch?: boolean;
};

export type LocalGitDiffInput = {
  paths?: string[];
  staged?: boolean;
  base_ref?: string;
};

export type LocalShellExecInput = {
  executable: string;
  argv: string[];
  cwd: string;
  use_shell: boolean;
  env?: Record<string, string>;
  stdin?: string;
};

export type LocalDevServerStartInput = {
  server_id: string;
  executable: string;
  argv: string[];
  cwd: string;
  host: "127.0.0.1" | "localhost";
  port: number;
  use_shell: boolean;
  env?: Record<string, string>;
  readiness?: {
    url?: string;
    timeout_ms: number;
  };
};

export type LocalDevServerStopInput = {
  server_id: string;
  signal?: "SIGTERM" | "SIGKILL";
  timeout_ms?: number;
};

export type LocalActionRequestBase<TAction extends LocalActionType, TInput> = {
  request_id: string;
  action: TAction;
  issued_at: string;
  attribution: LocalActionAttribution;
  lease: LocalActionLeaseBinding;
  sandbox: LocalActionSandboxRequirements;
  approval: LocalActionApprovalBinding;
  output_limits: LocalActionOutputLimits;
  cancellation: LocalActionCancellation;
  audit: LocalActionAuditMapping;
  input: TInput;
};

export type LocalFilesystemReadRequestPayload = LocalActionRequestBase<"local.filesystem.read", LocalFilesystemReadInput>;
export type LocalFilesystemListRequestPayload = LocalActionRequestBase<"local.filesystem.list", LocalFilesystemListInput>;
export type LocalFilesystemWriteRequestPayload = LocalActionRequestBase<"local.filesystem.write", LocalFilesystemWriteInput>;
export type LocalFilesystemPatchRequestPayload = LocalActionRequestBase<"local.filesystem.patch", LocalFilesystemPatchInput>;
export type LocalGitStatusRequestPayload = LocalActionRequestBase<"local.git.status", LocalGitStatusInput>;
export type LocalGitDiffRequestPayload = LocalActionRequestBase<"local.git.diff", LocalGitDiffInput>;
export type LocalShellExecRequestPayload = LocalActionRequestBase<"local.shell.exec", LocalShellExecInput>;
export type LocalDevServerStartRequestPayload = LocalActionRequestBase<"local.dev_server.start", LocalDevServerStartInput>;
export type LocalDevServerStopRequestPayload = LocalActionRequestBase<"local.dev_server.stop", LocalDevServerStopInput>;

export type LocalActionRequestPayload =
  | LocalFilesystemReadRequestPayload
  | LocalFilesystemListRequestPayload
  | LocalFilesystemWriteRequestPayload
  | LocalFilesystemPatchRequestPayload
  | LocalGitStatusRequestPayload
  | LocalGitDiffRequestPayload
  | LocalShellExecRequestPayload
  | LocalDevServerStartRequestPayload
  | LocalDevServerStopRequestPayload;

export type LocalFilesystemReadOutput = {
  path: string;
  content: string;
  encoding: "utf8" | "base64";
  hash: string;
  truncated?: boolean;
};

export type LocalFilesystemListOutput = {
  path: string;
  entries: Array<{
    name: string;
    type: "file" | "directory" | "other";
  }>;
  truncated?: boolean;
};

export type LocalFilesystemWriteOutput = {
  path: string;
  bytes_written: number;
  new_hash: string;
};

export type LocalFilesystemPatchOutput = {
  path: string;
  changed: boolean;
  new_hash: string;
};

export type LocalGitStatusOutput = {
  porcelain: string;
  branch?: string;
  truncated?: boolean;
};

export type LocalGitDiffOutput = {
  diff: string;
  truncated?: boolean;
};

export type LocalShellExecOutput = {
  executable: string;
  argv: string[];
  cwd: string;
  exit_code: number | null;
  signal?: string | null;
  stdout: string;
  stderr: string;
  timed_out: boolean;
  stdout_truncated?: boolean;
  stderr_truncated?: boolean;
};

export type LocalDevServerStartOutput = {
  server_id: string;
  pid: number;
  host: string;
  port: number;
  cwd: string;
  started_at: string;
  url?: string;
};

export type LocalDevServerStopOutput = {
  server_id: string;
  stopped_at: string;
};

export type LocalActionResponseBase<TAction extends LocalActionType, TOutput> = {
  request_id: string;
  action: TAction;
  status: "completed";
  completed_at: string;
  attribution: LocalActionAttribution;
  lease: LocalActionLeaseBinding;
  output: TOutput;
  audit_events: LocalActionResponseAuditEvents;
};

export type LocalActionResponsePayload =
  | LocalActionResponseBase<"local.filesystem.read", LocalFilesystemReadOutput>
  | LocalActionResponseBase<"local.filesystem.list", LocalFilesystemListOutput>
  | LocalActionResponseBase<"local.filesystem.write", LocalFilesystemWriteOutput>
  | LocalActionResponseBase<"local.filesystem.patch", LocalFilesystemPatchOutput>
  | LocalActionResponseBase<"local.git.status", LocalGitStatusOutput>
  | LocalActionResponseBase<"local.git.diff", LocalGitDiffOutput>
  | LocalActionResponseBase<"local.shell.exec", LocalShellExecOutput>
  | LocalActionResponseBase<"local.dev_server.start", LocalDevServerStartOutput>
  | LocalActionResponseBase<"local.dev_server.stop", LocalDevServerStopOutput>;

export type LocalActionErrorCode =
  | "local_capability_lease_missing"
  | "local_capability_lease_expired"
  | "local_capability_lease_revoked"
  | "local_capability_session_mismatch"
  | "local_capability_workspace_mismatch"
  | "local_capability_provider_mismatch"
  | "local_capability_scope_not_granted"
  | "local_capability_sandbox_denied"
  | "local_capability_approval_required"
  | "local_capability_approval_mismatch"
  | "local_capability_path_denied"
  | "local_capability_expected_hash_mismatch"
  | "local_capability_output_limit_exceeded"
  | "local_capability_timeout"
  | "local_capability_cancelled"
  | "local_capability_command_denied"
  | "local_capability_process_failed"
  | "local_capability_dev_server_exists"
  | "local_capability_dev_server_not_found"
  | "local_capability_action_failed";

export type LocalActionError = {
  code: LocalActionErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
};

export type LocalActionErrorPayload = {
  request_id: string;
  action: LocalActionType;
  status: "failed" | "cancelled" | "timed_out";
  failed_at: string;
  attribution: LocalActionAttribution;
  lease?: LocalActionLeaseBinding;
  error: LocalActionError;
  audit_events: LocalActionErrorAuditEvents;
};

export type HarnessUsageSnapshot = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cost_usd?: number;
};

export type HarnessTurnFinalOutput = {
  final_text?: string;
  structured_output?: unknown;
  diff_summary?: string;
  changed_files?: Array<{
    path: string;
    change_type: "added" | "modified" | "deleted" | "renamed";
  }>;
  artifact_refs?: Array<{
    id: string;
    kind: "diff" | "file" | "log" | "image" | "other";
    label?: string;
    size_bytes?: number;
  }>;
  usage?: HarnessUsageSnapshot;
  exit_reason?: string;
};

export type HcpExtensionEventData = {
  summary?: string;
  fields?: Record<string, unknown>;
};

export type HcpKnownEventData = Record<string, unknown>;

export type HcpRawDiagnosticPayload = {
  source: string;
  payload: Record<string, unknown>;
};

export type HcpHarnessEventPayload = {
  session_id: string;
  turn_id?: string;
  sequence: number;
  event_type: HcpEventType;
  created_at: string;
  data: HcpKnownEventData | HcpExtensionEventData;
  raw?: HcpRawDiagnosticPayload;
};

type HcpSessionSnapshotBase = {
  command_id: string;
  session_id: string;
  generated_at: string;
  from_sequence: number;
  through_sequence: number;
  events: HcpHarnessEventPayload[];
  tombstones: Array<{
    entity_type: "session" | "turn" | "item";
    entity_id: string;
    deleted_at: string;
  }>;
};

export type HcpSessionSnapshotPayload =
  | (HcpSessionSnapshotBase & {
      completeness: "complete";
      omission_semantics: "replace";
      from_sequence: 1;
    })
  | (HcpSessionSnapshotBase & {
      completeness: "partial";
      omission_semantics: "preserve";
      reason: "retention_gap" | "size_limit";
    });

const nonEmptyStringSchema = z.string().min(1);
const timestampSchema = z.string().datetime({ offset: true });
const metadataSchema = z.record(z.string(), z.unknown());
const unknownRecordSchema = z.record(z.string(), z.unknown());
const stringRecordSchema = z.record(z.string(), z.string());
const harnessOptionValueSchema = z.union([z.string(), z.boolean(), z.number()]);
const streamableHttpUrlSchema = z.string().url().refine(
  (value: string): boolean => {
    try {
      const url: URL = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch (error: unknown) {
      if (error instanceof TypeError) {
        return false;
      }
      throw error;
    }
  },
  { message: "Streamable HTTP MCP attachment URLs must use http or https." },
);

export const hcpVersionSchema = z.literal(HCP_VERSION);

export const hcpErrorSchema = z
  .object({
    code: nonEmptyStringSchema,
    message: nonEmptyStringSchema,
    retryable: z.boolean(),
    details: unknownRecordSchema.optional(),
  })
  .strict();

export const hcpCommandAckPayloadSchema = z
  .object({
    command_id: nonEmptyStringSchema,
    accepted_at: timestampSchema,
    duplicate: z.boolean(),
  })
  .strict();

export const hcpCommandNackPayloadSchema = z
  .object({
    command_id: nonEmptyStringSchema,
    rejected_at: timestampSchema,
    error: hcpErrorSchema,
  })
  .strict();

export const hcpAckPayloadSchema = hcpCommandAckPayloadSchema;
export const hcpNackPayloadSchema = hcpCommandNackPayloadSchema;

export const hcpHostResumeCursorSchema = z
  .object({
    sessions: z
      .array(
        z
          .object({
            session_id: nonEmptyStringSchema,
            last_event_sequence: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export const hcpHostRetainedEventRangesSchema = z
  .object({
    sessions: z
      .array(
        z
          .object({
            session_id: nonEmptyStringSchema,
            first_event_sequence: z.number().int().positive(),
            last_event_sequence: z.number().int().positive(),
          })
          .strict()
          .refine((range): boolean => range.first_event_sequence <= range.last_event_sequence, {
            message: "Retained event range must not end before it starts.",
          }),
      )
      .default([]),
  })
  .strict();

export const hcpHostHelloPayloadSchema = z
  .object({
    runner_id: nonEmptyStringSchema,
    host_id: nonEmptyStringSchema,
    runner_version: nonEmptyStringSchema,
    supported_protocol_versions: z.array(hcpVersionSchema).min(1),
    capabilities: z.array(nonEmptyStringSchema),
    retained_events: hcpHostRetainedEventRangesSchema.optional(),
  })
  .strict();

export const hcpHostAcceptedPayloadSchema = z
  .object({
    protocol_version: hcpVersionSchema,
    heartbeat_interval_seconds: z.number().int().positive(),
    resume: hcpHostResumeCursorSchema.optional(),
  })
  .strict();

export const hcpHostRejectedPayloadSchema = z
  .object({
    reason: nonEmptyStringSchema,
    supported_protocol_versions: z.array(hcpVersionSchema).optional(),
  })
  .strict();

export const hcpHostHeartbeatPayloadSchema = z
  .object({
    host_id: nonEmptyStringSchema,
    status: z.enum(["online", "degraded", "draining"]),
    active_sessions: z.number().int().nonnegative(),
  })
  .strict();

export const localCapabilitySnapshotSchema = z
  .object({
    id: nonEmptyStringSchema,
    status: z.enum(["available", "unavailable", "disabled", "unknown"]),
    scopes: z.array(nonEmptyStringSchema),
    approval_required: z.boolean(),
    message: nonEmptyStringSchema.optional(),
  })
  .strict();

export const providerAuthSnapshotSchema = z
  .object({
    status: z.enum(["authenticated", "unauthenticated", "unknown"]),
    type: nonEmptyStringSchema.optional(),
    label: nonEmptyStringSchema.optional(),
    email: nonEmptyStringSchema.optional(),
  })
  .strict();

export const harnessOptionDescriptorSchema = z
  .object({
    id: nonEmptyStringSchema,
    label: nonEmptyStringSchema,
    type: z.enum(["select", "boolean", "number", "string"]),
    values: z
      .array(
        z
          .object({
            value: z.string(),
            label: nonEmptyStringSchema,
          })
          .strict(),
      )
      .optional(),
    default_value: harnessOptionValueSchema.optional(),
    current_value: harnessOptionValueSchema.optional(),
    prompt_injected_values: z.array(z.string()).optional(),
  })
  .strict();

export const harnessModelSchema = z
  .object({
    id: nonEmptyStringSchema,
    label: nonEmptyStringSchema,
    is_default: z.boolean().optional(),
    capabilities: z
      .object({
        option_descriptors: z.array(harnessOptionDescriptorSchema),
      })
      .strict(),
  })
  .strict();

export const harnessProviderSnapshotSchema = z
  .object({
    execution_capabilities: z.object({
      streaming: z.boolean(),
      multi_turn: z.boolean(),
      session_continuation: z.boolean(),
      sandbox_modes: z.array(z.enum(["read_only", "workspace_write", "danger_full_access"])),
      approval_policies: z.array(z.enum(["ask", "auto_edits", "full_access"])),
    }).strict().optional(),
    provider_instance_id: nonEmptyStringSchema,
    driver_kind: nonEmptyStringSchema,
    display_name: nonEmptyStringSchema.optional(),
    accent_color: nonEmptyStringSchema.optional(),
    enabled: z.boolean(),
    installed: z.boolean(),
    version: nonEmptyStringSchema.optional(),
    status: z.enum(["ready", "unavailable", "unauthenticated", "disabled", "error", "unknown"]),
    availability: z.enum(["available", "unavailable"]),
    message: nonEmptyStringSchema.optional(),
    checked_at: timestampSchema.optional(),
    continuation_group_key: nonEmptyStringSchema.optional(),
    auth: providerAuthSnapshotSchema.optional(),
    models: z.array(harnessModelSchema),
    hidden_models: z.array(z.string()).optional(),
    model_order: z.array(z.string()).optional(),
    favorite_models: z.array(z.string()).optional(),
    local_capabilities: z.array(nonEmptyStringSchema).optional(),
    version_advisory: z
      .object({
        level: z.enum(["info", "warning", "blocking"]),
        message: nonEmptyStringSchema,
      })
      .strict()
      .nullable()
      .optional(),
    update_state: z
      .object({
        available: z.boolean(),
        latest_version: nonEmptyStringSchema.optional(),
        command: nonEmptyStringSchema.optional(),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();

export const hcpWorkspaceSchema = z
  .object({
    id: nonEmptyStringSchema,
    path: nonEmptyStringSchema,
    git_remote: nonEmptyStringSchema.optional(),
    display_name: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

export const hcpMcpStdioProfileSnapshotSchema = z
  .object({
    id: nonEmptyStringSchema,
    provider_instance_ids: z.array(nonEmptyStringSchema),
    allowed_tools: z.array(nonEmptyStringSchema).optional(),
    denied_tools: z.array(nonEmptyStringSchema).optional(),
  })
  .strict();

export const hcpWorkspaceManagementSchema = z.object({
  revision: z.string().min(1).max(100),
  allowed_roots: z.array(z.string().min(1).max(4096)).max(32),
}).strict();
export type HcpWorkspaceManagement = z.infer<typeof hcpWorkspaceManagementSchema>;
export const hcpWorkspaceOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("list") }).strict(),
  z.object({ kind: z.literal("add"), path: z.string().min(1).max(4096), display_name: z.string().trim().min(1).max(100) }).strict(),
  z.object({ kind: z.literal("rename"), id: z.string().min(1).max(200), display_name: z.string().trim().min(1).max(100) }).strict(),
  z.object({ kind: z.literal("remove"), id: z.string().min(1).max(200) }).strict(),
]);
export type HcpWorkspaceOperation = z.infer<typeof hcpWorkspaceOperationSchema>;
export const hcpWorkspacesRequestPayloadSchema = z.object({
  expected_revision: z.string().min(1).max(100),
  expires_at: timestampSchema,
  operation: hcpWorkspaceOperationSchema,
}).strict();
export type HcpWorkspacesRequestPayload = z.infer<typeof hcpWorkspacesRequestPayloadSchema>;
export const hcpWorkspacesResultPayloadSchema = z.object({
  request_id: nonEmptyStringSchema,
  outcome: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("success") }).strict(),
    z.object({ kind: z.literal("error"), message: z.string().min(1).max(1000) }).strict(),
  ]),
  management: hcpWorkspaceManagementSchema,
  workspaces: z.array(hcpWorkspaceSchema).max(128),
}).strict();
export type HcpWorkspacesResultPayload = z.infer<typeof hcpWorkspacesResultPayloadSchema>;

export const hcpHostCapabilitiesUpdatedPayloadSchema = z
  .object({
    providers: z.array(harnessProviderSnapshotSchema),
    local_capabilities: z.array(localCapabilitySnapshotSchema),
    workspaces: z.array(hcpWorkspaceSchema),
    workspace_management: hcpWorkspaceManagementSchema.optional(),
    mcp_stdio_profiles: z.array(hcpMcpStdioProfileSnapshotSchema).optional(),
  })
  .strict();

export const hcpHostReplayUnavailablePayloadSchema = z
  .object({
    session_id: nonEmptyStringSchema,
    requested_after_sequence: z.number().int().nonnegative(),
    reason: z.enum(["no_retained_events", "cursor_outside_retention"]),
    retained_range: z
      .object({
        first_event_sequence: z.number().int().positive(),
        last_event_sequence: z.number().int().positive(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const harnessProviderReferenceSchema = z
  .object({
    execution_host_id: nonEmptyStringSchema,
    provider_instance_id: nonEmptyStringSchema,
    driver_kind: nonEmptyStringSchema,
    continuation_group_key: nonEmptyStringSchema.optional(),
  })
  .strict();

export const harnessModelSelectionSchema = z
  .object({
    model: nonEmptyStringSchema,
    options: z
      .array(
        z
          .object({
            id: nonEmptyStringSchema,
            value: harnessOptionValueSchema,
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

export const workspacePreflightSchema = z
  .object({
    workspace_id: nonEmptyStringSchema,
    expected_git_remote: nonEmptyStringSchema.optional(),
    expected_branch: nonEmptyStringSchema.optional(),
    allow_dirty_worktree: z.boolean().optional(),
    required_paths: z.array(nonEmptyStringSchema).optional(),
  })
  .strict();

export const workspacePreflightCompletedSchema = z
  .object({
    workspace_id: nonEmptyStringSchema,
    cwd: nonEmptyStringSchema,
    branch: nonEmptyStringSchema.optional(),
    commit: nonEmptyStringSchema.optional(),
    dirty: z.boolean().optional(),
    remote: nonEmptyStringSchema.optional(),
    result: z.enum(["passed", "failed", "warning"]),
    message: nonEmptyStringSchema.optional(),
  })
  .strict();

export const commandPolicySchema = z
  .object({
    allowed_executables: z.array(nonEmptyStringSchema).optional(),
    denied_executables: z.array(nonEmptyStringSchema).optional(),
    argv_patterns: z.array(nonEmptyStringSchema).optional(),
    cwd_policy: z.literal("selected_workspace_only"),
    env_policy: z.enum(["minimal", "allowlisted"]),
    allow_shell: z.boolean(),
    timeout_seconds: z.number().int().positive(),
    network_policy: z.enum(["inherit", "disabled", "allowlisted"]),
  })
  .strict();

export const localCapabilityGrantSchema = z
  .object({
    id: nonEmptyStringSchema,
    scopes: z.array(nonEmptyStringSchema),
    approval_policy: z.enum(["ask", "auto_edits", "full_access"]).optional(),
    command_policy: commandPolicySchema.optional(),
    max_calls: z.number().int().positive().optional(),
  })
  .strict();

export const localCapabilityLeaseSchema = z
  .object({
    lease_id: nonEmptyStringSchema,
    org_id: nonEmptyStringSchema,
    actor_id: nonEmptyStringSchema.optional(),
    workflow_id: nonEmptyStringSchema,
    run_id: nonEmptyStringSchema,
    node_id: nonEmptyStringSchema,
    hcp_session_id: nonEmptyStringSchema,
    execution_host_id: nonEmptyStringSchema,
    provider_instance_id: nonEmptyStringSchema,
    workspace_id: nonEmptyStringSchema,
    issued_at: timestampSchema,
    expires_at: timestampSchema,
    policy_version: nonEmptyStringSchema,
    capabilities: z.array(localCapabilityGrantSchema),
  })
  .strict();

export const mcpProofOfPossessionSchema = z
  .object({
    scheme: z.literal("runner_signed_request"),
    key_id: nonEmptyStringSchema,
    required_headers: z.array(nonEmptyStringSchema).min(1),
  })
  .strict();

export const streamableHttpMcpServerAttachmentSchema = z
  .object({
    name: nonEmptyStringSchema,
    transport: z.literal("streamable_http"),
    url: streamableHttpUrlSchema,
    headers: stringRecordSchema,
    lease_id: nonEmptyStringSchema,
    proof_of_possession: mcpProofOfPossessionSchema,
    expires_at: timestampSchema.optional(),
    allowed_tools: z.array(nonEmptyStringSchema).optional(),
    denied_tools: z.array(nonEmptyStringSchema).optional(),
  })
  .strict();

export const runnerStdioMcpProfileAttachmentSchema = z
  .object({
    name: nonEmptyStringSchema,
    transport: z.literal("runner_stdio_profile"),
    profile_id: nonEmptyStringSchema,
    allowed_tools: z.array(nonEmptyStringSchema).optional(),
    denied_tools: z.array(nonEmptyStringSchema).optional(),
  })
  .strict();

export const mcpServerAttachmentSchema = z.discriminatedUnion("transport", [
  streamableHttpMcpServerAttachmentSchema,
  runnerStdioMcpProfileAttachmentSchema,
]);

export const hcpSessionStartPayloadSchema = z
  .object({
    session_id: nonEmptyStringSchema,
    workspace_id: nonEmptyStringSchema,
    provider_instance_id: nonEmptyStringSchema,
    driver_kind: nonEmptyStringSchema,
    continuation_group_key: nonEmptyStringSchema.optional(),
    cwd: nonEmptyStringSchema,
    sandbox_mode: z.enum(["read_only", "workspace_write", "danger_full_access"]),
    approval_policy: z.enum(["ask", "auto_edits", "full_access"]),
    continue_session: z.boolean(),
    model_selection: harnessModelSelectionSchema,
    workspace_preflight: workspacePreflightSchema.optional(),
    local_capability_lease: localCapabilityLeaseSchema.optional(),
    mcp_servers: z.array(mcpServerAttachmentSchema),
  })
  .strict();

export const hcpSessionSnapshotRequestPayloadSchema = z
  .object({
    session_id: nonEmptyStringSchema,
  })
  .strict();

export const hcpTurnSendPayloadSchema = z
  .object({
    session_id: nonEmptyStringSchema,
    turn_id: nonEmptyStringSchema,
    input: z.string(),
    model_selection: harnessModelSelectionSchema.optional(),
  })
  .strict();

export const hcpTurnCancelPayloadSchema = z
  .object({
    session_id: nonEmptyStringSchema,
    turn_id: nonEmptyStringSchema,
    reason: nonEmptyStringSchema.optional(),
  })
  .strict();

export const hcpSessionStopPayloadSchema = z
  .object({
    session_id: nonEmptyStringSchema,
    reason: nonEmptyStringSchema.optional(),
  })
  .strict();

export const hcpApprovalResponsePayloadSchema = z
  .object({
    request_id: nonEmptyStringSchema,
    session_id: nonEmptyStringSchema,
    turn_id: nonEmptyStringSchema,
    action_hash: nonEmptyStringSchema,
    decision: z.enum(["accept", "accept_for_session", "decline", "cancel"]),
    actor_id: nonEmptyStringSchema,
  })
  .strict();

export const hcpInputResponsePayloadSchema = z
  .object({
    request_id: nonEmptyStringSchema,
    session_id: nonEmptyStringSchema,
    turn_id: nonEmptyStringSchema,
    actor_id: nonEmptyStringSchema,
    value: z.unknown().optional(),
    cancelled: z.boolean().optional(),
  })
  .strict();

export const toolServersDetachPayloadSchema = z
  .object({
    session_id: nonEmptyStringSchema,
    names: z.array(nonEmptyStringSchema).min(1),
    reason: nonEmptyStringSchema.optional(),
  })
  .strict();

const localActionProtocolCapabilityIdSchema = z.enum(["filesystem", "git", "shell", "dev_server"]);
const localActionTypeSchema = z.enum(LOCAL_ACTION_TYPES);
const localActionErrorCodeSchema = z.enum([
  "local_capability_lease_missing",
  "local_capability_lease_expired",
  "local_capability_lease_revoked",
  "local_capability_session_mismatch",
  "local_capability_workspace_mismatch",
  "local_capability_provider_mismatch",
  "local_capability_scope_not_granted",
  "local_capability_sandbox_denied",
  "local_capability_approval_required",
  "local_capability_approval_mismatch",
  "local_capability_path_denied",
  "local_capability_expected_hash_mismatch",
  "local_capability_output_limit_exceeded",
  "local_capability_timeout",
  "local_capability_cancelled",
  "local_capability_command_denied",
  "local_capability_process_failed",
  "local_capability_dev_server_exists",
  "local_capability_dev_server_not_found",
  "local_capability_action_failed",
]);

const localActionAttributionSchema = z
  .object({
    session_id: nonEmptyStringSchema,
    turn_id: nonEmptyStringSchema,
    workspace_id: nonEmptyStringSchema,
    provider_instance_id: nonEmptyStringSchema,
    run_id: nonEmptyStringSchema,
  })
  .strict();

const localActionLeaseBindingSchema = z
  .object({
    lease_id: nonEmptyStringSchema,
    capability_id: localActionProtocolCapabilityIdSchema,
    scope: nonEmptyStringSchema,
    run_id: nonEmptyStringSchema,
    hcp_session_id: nonEmptyStringSchema,
    execution_host_id: nonEmptyStringSchema,
    provider_instance_id: nonEmptyStringSchema,
    workspace_id: nonEmptyStringSchema,
    expires_at: timestampSchema.optional(),
  })
  .strict();

const localFilesystemReadLeaseBindingSchema = localActionLeaseBindingSchema.extend({
  capability_id: z.literal("filesystem"),
  scope: z.literal("workspace_read"),
});
const localFilesystemWriteLeaseBindingSchema = localActionLeaseBindingSchema.extend({
  capability_id: z.literal("filesystem"),
  scope: z.literal("workspace_write"),
});
const localGitReadLeaseBindingSchema = localActionLeaseBindingSchema.extend({
  capability_id: z.literal("git"),
  scope: z.literal("workspace_read"),
});
const localShellLeaseBindingSchema = localActionLeaseBindingSchema.extend({
  capability_id: z.literal("shell"),
  scope: z.literal("workspace"),
});
const localDevServerLeaseBindingSchema = localActionLeaseBindingSchema.extend({
  capability_id: z.literal("dev_server"),
  scope: z.literal("workspace"),
});

const localActionSandboxRequirementsSchema = z
  .object({
    mode: z.enum(["read_only", "workspace_write", "danger_full_access"]),
    workspace_root: nonEmptyStringSchema,
    cwd: nonEmptyStringSchema,
    requires_workspace_containment: z.literal(true),
  })
  .strict();

const localActionOutputLimitsSchema = z
  .object({
    content_bytes: z.number().int().positive().optional(),
    entries: z.number().int().positive().optional(),
    status_bytes: z.number().int().positive().optional(),
    diff_bytes: z.number().int().positive().optional(),
    stdout_bytes: z.number().int().positive().optional(),
    stderr_bytes: z.number().int().positive().optional(),
  })
  .strict();

const localFilesystemReadOutputLimitsSchema = localActionOutputLimitsSchema.extend({
  content_bytes: z.number().int().positive(),
});
const localFilesystemListOutputLimitsSchema = localActionOutputLimitsSchema.extend({
  entries: z.number().int().positive(),
});
const localGitStatusOutputLimitsSchema = localActionOutputLimitsSchema.extend({
  status_bytes: z.number().int().positive(),
});
const localGitDiffOutputLimitsSchema = localActionOutputLimitsSchema.extend({
  diff_bytes: z.number().int().positive(),
});
const localShellOutputLimitsSchema = localActionOutputLimitsSchema.extend({
  stdout_bytes: z.number().int().positive(),
  stderr_bytes: z.number().int().positive(),
});

const localActionCancellationSchema = z
  .object({
    cancellable: z.boolean(),
    timeout_ms: z.number().int().positive().optional(),
    token: nonEmptyStringSchema.optional(),
  })
  .strict();

const localActionApprovalBindingSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("not_required"),
    })
    .strict(),
  z
    .object({
      status: z.literal("approved"),
      request_id: nonEmptyStringSchema,
      action_hash: nonEmptyStringSchema,
      decision: z.enum(["accept", "accept_for_session"]),
      actor_id: nonEmptyStringSchema,
      approved_at: timestampSchema,
    })
    .strict(),
]);

const localActionApprovedBindingSchema = z
  .object({
    status: z.literal("approved"),
    request_id: nonEmptyStringSchema,
    action_hash: nonEmptyStringSchema,
    decision: z.enum(["accept", "accept_for_session"]),
    actor_id: nonEmptyStringSchema,
    approved_at: timestampSchema,
  })
  .strict();

const localActionAuditMappingSchema = z
  .object({
    started_event_type: z.literal("local_capability.action.started"),
    completed_event_type: z.literal("local_capability.action.completed"),
    failed_event_type: z.literal("local_capability.action.failed"),
  })
  .strict();

const localActionAuditEventRefSchema = z
  .object({
    event_type: z.enum([
      "local_capability.action.started",
      "local_capability.action.completed",
      "local_capability.action.failed",
    ]),
    sequence: z.number().int().positive().optional(),
  })
  .strict();

const localActionStartedAuditEventRefSchema = localActionAuditEventRefSchema.extend({
  event_type: z.literal("local_capability.action.started"),
});
const localActionCompletedAuditEventRefSchema = localActionAuditEventRefSchema.extend({
  event_type: z.literal("local_capability.action.completed"),
});
const localActionFailedAuditEventRefSchema = localActionAuditEventRefSchema.extend({
  event_type: z.literal("local_capability.action.failed"),
});

const localActionResponseAuditEventsSchema = z
  .object({
    started: localActionStartedAuditEventRefSchema.optional(),
    completed: localActionCompletedAuditEventRefSchema,
  })
  .strict();

const localActionErrorAuditEventsSchema = z
  .object({
    started: localActionStartedAuditEventRefSchema.optional(),
    failed: localActionFailedAuditEventRefSchema,
  })
  .strict();

const localFilesystemReadInputSchema = z
  .object({
    path: nonEmptyStringSchema,
    encoding: z.enum(["utf8", "base64"]).optional(),
    range: z
      .object({
        start: z.number().int().nonnegative().optional(),
        length: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const localFilesystemListInputSchema = z
  .object({
    path: nonEmptyStringSchema,
    recursive: z.boolean().optional(),
    include_hidden: z.boolean().optional(),
    max_depth: z.number().int().positive().optional(),
  })
  .strict();

const localFilesystemWriteInputSchema = z
  .object({
    path: nonEmptyStringSchema,
    content: z.string(),
    encoding: z.enum(["utf8", "base64"]).optional(),
    mode: z.enum(["create", "overwrite"]),
    create_parents: z.boolean(),
    expected_base_hash: nonEmptyStringSchema.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.mode === "overwrite" && input.expected_base_hash === undefined) {
      context.addIssue({
        code: "custom",
        path: ["expected_base_hash"],
        message: "Filesystem overwrite requests must bind an expected base hash.",
      });
    }
  });

const localFilesystemPatchInputSchema = z
  .object({
    path: nonEmptyStringSchema,
    expected_base_hash: nonEmptyStringSchema,
    patch: z
      .object({
        format: z.literal("unified_diff"),
        content: nonEmptyStringSchema,
      })
      .strict(),
    create_if_missing: z.boolean().optional(),
  })
  .strict();

const localGitStatusInputSchema = z
  .object({
    porcelain_version: z.enum(["v1", "v2"]),
    include_branch: z.boolean().optional(),
  })
  .strict();

const localGitDiffInputSchema = z
  .object({
    paths: z.array(nonEmptyStringSchema).optional(),
    staged: z.boolean().optional(),
    base_ref: nonEmptyStringSchema.optional(),
  })
  .strict();

const localShellExecInputSchema = z
  .object({
    executable: nonEmptyStringSchema,
    argv: z.array(z.string()),
    cwd: nonEmptyStringSchema,
    use_shell: z.boolean(),
    env: stringRecordSchema.optional(),
    stdin: z.string().optional(),
  })
  .strict();

const localDevServerStartInputSchema = z
  .object({
    server_id: nonEmptyStringSchema,
    executable: nonEmptyStringSchema,
    argv: z.array(z.string()),
    cwd: nonEmptyStringSchema,
    host: z.enum(["127.0.0.1", "localhost"]),
    port: z.number().int().min(1).max(65_535),
    use_shell: z.boolean(),
    env: stringRecordSchema.optional(),
    readiness: z
      .object({
        url: nonEmptyStringSchema.optional(),
        timeout_ms: z.number().int().positive(),
      })
      .strict()
      .optional(),
  })
  .strict();

const localDevServerStopInputSchema = z
  .object({
    server_id: nonEmptyStringSchema,
    signal: z.enum(["SIGTERM", "SIGKILL"]).optional(),
    timeout_ms: z.number().int().positive().optional(),
  })
  .strict();

const localActionRequestSharedShape = {
  request_id: nonEmptyStringSchema,
  issued_at: timestampSchema,
  attribution: localActionAttributionSchema,
  lease: localActionLeaseBindingSchema,
  sandbox: localActionSandboxRequirementsSchema,
  approval: localActionApprovalBindingSchema,
  output_limits: localActionOutputLimitsSchema,
  cancellation: localActionCancellationSchema,
  audit: localActionAuditMappingSchema,
};

export const localFilesystemReadRequestPayloadSchema = z
  .object({
    ...localActionRequestSharedShape,
    action: z.literal("local.filesystem.read"),
    lease: localFilesystemReadLeaseBindingSchema,
    output_limits: localFilesystemReadOutputLimitsSchema,
    input: localFilesystemReadInputSchema,
  })
  .strict();
export const localFilesystemListRequestPayloadSchema = z
  .object({
    ...localActionRequestSharedShape,
    action: z.literal("local.filesystem.list"),
    lease: localFilesystemReadLeaseBindingSchema,
    output_limits: localFilesystemListOutputLimitsSchema,
    input: localFilesystemListInputSchema,
  })
  .strict();
export const localFilesystemWriteRequestPayloadSchema = z
  .object({
    ...localActionRequestSharedShape,
    action: z.literal("local.filesystem.write"),
    lease: localFilesystemWriteLeaseBindingSchema,
    input: localFilesystemWriteInputSchema,
  })
  .strict();
export const localFilesystemPatchRequestPayloadSchema = z
  .object({
    ...localActionRequestSharedShape,
    action: z.literal("local.filesystem.patch"),
    lease: localFilesystemWriteLeaseBindingSchema,
    input: localFilesystemPatchInputSchema,
  })
  .strict();
export const localGitStatusRequestPayloadSchema = z
  .object({
    ...localActionRequestSharedShape,
    action: z.literal("local.git.status"),
    lease: localGitReadLeaseBindingSchema,
    output_limits: localGitStatusOutputLimitsSchema,
    input: localGitStatusInputSchema,
  })
  .strict();
export const localGitDiffRequestPayloadSchema = z
  .object({
    ...localActionRequestSharedShape,
    action: z.literal("local.git.diff"),
    lease: localGitReadLeaseBindingSchema,
    output_limits: localGitDiffOutputLimitsSchema,
    input: localGitDiffInputSchema,
  })
  .strict();
export const localShellExecRequestPayloadSchema = z
  .object({
    ...localActionRequestSharedShape,
    action: z.literal("local.shell.exec"),
    lease: localShellLeaseBindingSchema,
    approval: localActionApprovedBindingSchema,
    output_limits: localShellOutputLimitsSchema,
    input: localShellExecInputSchema,
  })
  .strict();
export const localDevServerStartRequestPayloadSchema = z
  .object({
    ...localActionRequestSharedShape,
    action: z.literal("local.dev_server.start"),
    lease: localDevServerLeaseBindingSchema,
    approval: localActionApprovedBindingSchema,
    input: localDevServerStartInputSchema,
  })
  .strict();
export const localDevServerStopRequestPayloadSchema = z
  .object({
    ...localActionRequestSharedShape,
    action: z.literal("local.dev_server.stop"),
    lease: localDevServerLeaseBindingSchema,
    input: localDevServerStopInputSchema,
  })
  .strict();

export const localActionRequestPayloadSchema = z
  .discriminatedUnion("action", [
    localFilesystemReadRequestPayloadSchema,
    localFilesystemListRequestPayloadSchema,
    localFilesystemWriteRequestPayloadSchema,
    localFilesystemPatchRequestPayloadSchema,
    localGitStatusRequestPayloadSchema,
    localGitDiffRequestPayloadSchema,
    localShellExecRequestPayloadSchema,
    localDevServerStartRequestPayloadSchema,
    localDevServerStopRequestPayloadSchema,
  ])
  .superRefine(refineLocalActionContract);

const localFilesystemReadOutputSchema = z
  .object({
    path: nonEmptyStringSchema,
    content: z.string(),
    encoding: z.enum(["utf8", "base64"]),
    hash: nonEmptyStringSchema,
    truncated: z.boolean().optional(),
  })
  .strict();

const localFilesystemListOutputSchema = z
  .object({
    path: nonEmptyStringSchema,
    entries: z.array(
      z
        .object({
          name: nonEmptyStringSchema,
          type: z.enum(["file", "directory", "other"]),
        })
        .strict(),
    ),
    truncated: z.boolean().optional(),
  })
  .strict();

const localFilesystemWriteOutputSchema = z
  .object({
    path: nonEmptyStringSchema,
    bytes_written: z.number().int().nonnegative(),
    new_hash: nonEmptyStringSchema,
  })
  .strict();

const localFilesystemPatchOutputSchema = z
  .object({
    path: nonEmptyStringSchema,
    changed: z.boolean(),
    new_hash: nonEmptyStringSchema,
  })
  .strict();

const localGitStatusOutputSchema = z
  .object({
    porcelain: z.string(),
    branch: nonEmptyStringSchema.optional(),
    truncated: z.boolean().optional(),
  })
  .strict();

const localGitDiffOutputSchema = z
  .object({
    diff: z.string(),
    truncated: z.boolean().optional(),
  })
  .strict();

const localShellExecOutputSchema = z
  .object({
    executable: nonEmptyStringSchema,
    argv: z.array(z.string()),
    cwd: nonEmptyStringSchema,
    exit_code: z.number().int().nullable(),
    signal: z.string().nullable().optional(),
    stdout: z.string(),
    stderr: z.string(),
    timed_out: z.boolean(),
    stdout_truncated: z.boolean().optional(),
    stderr_truncated: z.boolean().optional(),
  })
  .strict();

const localDevServerStartOutputSchema = z
  .object({
    server_id: nonEmptyStringSchema,
    pid: z.number().int().positive(),
    host: nonEmptyStringSchema,
    port: z.number().int().min(1).max(65_535),
    cwd: nonEmptyStringSchema,
    started_at: timestampSchema,
    url: nonEmptyStringSchema.optional(),
  })
  .strict();

const localDevServerStopOutputSchema = z
  .object({
    server_id: nonEmptyStringSchema,
    stopped_at: timestampSchema,
  })
  .strict();

const localActionResponseSharedShape = {
  request_id: nonEmptyStringSchema,
  status: z.literal("completed"),
  completed_at: timestampSchema,
  attribution: localActionAttributionSchema,
  lease: localActionLeaseBindingSchema,
  audit_events: localActionResponseAuditEventsSchema,
};

export const localActionResponsePayloadSchema = z
  .discriminatedUnion("action", [
    z
      .object({
        ...localActionResponseSharedShape,
        action: z.literal("local.filesystem.read"),
        lease: localFilesystemReadLeaseBindingSchema,
        output: localFilesystemReadOutputSchema,
      })
      .strict(),
    z
      .object({
        ...localActionResponseSharedShape,
        action: z.literal("local.filesystem.list"),
        lease: localFilesystemReadLeaseBindingSchema,
        output: localFilesystemListOutputSchema,
      })
      .strict(),
    z
      .object({
        ...localActionResponseSharedShape,
        action: z.literal("local.filesystem.write"),
        lease: localFilesystemWriteLeaseBindingSchema,
        output: localFilesystemWriteOutputSchema,
      })
      .strict(),
    z
      .object({
        ...localActionResponseSharedShape,
        action: z.literal("local.filesystem.patch"),
        lease: localFilesystemWriteLeaseBindingSchema,
        output: localFilesystemPatchOutputSchema,
      })
      .strict(),
    z
      .object({
        ...localActionResponseSharedShape,
        action: z.literal("local.git.status"),
        lease: localGitReadLeaseBindingSchema,
        output: localGitStatusOutputSchema,
      })
      .strict(),
    z
      .object({
        ...localActionResponseSharedShape,
        action: z.literal("local.git.diff"),
        lease: localGitReadLeaseBindingSchema,
        output: localGitDiffOutputSchema,
      })
      .strict(),
    z
      .object({
        ...localActionResponseSharedShape,
        action: z.literal("local.shell.exec"),
        lease: localShellLeaseBindingSchema,
        output: localShellExecOutputSchema,
      })
      .strict(),
    z
      .object({
        ...localActionResponseSharedShape,
        action: z.literal("local.dev_server.start"),
        lease: localDevServerLeaseBindingSchema,
        output: localDevServerStartOutputSchema,
      })
      .strict(),
    z
      .object({
        ...localActionResponseSharedShape,
        action: z.literal("local.dev_server.stop"),
        lease: localDevServerLeaseBindingSchema,
        output: localDevServerStopOutputSchema,
      })
      .strict(),
  ])
  .superRefine(refineLocalActionContract);

export const localActionErrorSchema = z
  .object({
    code: localActionErrorCodeSchema,
    message: nonEmptyStringSchema,
    retryable: z.boolean(),
    details: unknownRecordSchema.optional(),
  })
  .strict();

export const localActionErrorPayloadSchema = z
  .object({
    request_id: nonEmptyStringSchema,
    action: localActionTypeSchema,
    status: z.enum(["failed", "cancelled", "timed_out"]),
    failed_at: timestampSchema,
    attribution: localActionAttributionSchema,
    lease: localActionLeaseBindingSchema.optional(),
    error: localActionErrorSchema,
    audit_events: localActionErrorAuditEventsSchema,
  })
  .strict()
  .superRefine(refineLocalActionErrorContract);

type LocalActionContractPayload = {
  action: LocalActionType;
  attribution: z.output<typeof localActionAttributionSchema>;
  lease: z.output<typeof localActionLeaseBindingSchema>;
  sandbox?: z.output<typeof localActionSandboxRequirementsSchema>;
  approval?: z.output<typeof localActionApprovalBindingSchema>;
  output_limits?: z.output<typeof localActionOutputLimitsSchema>;
};

type LocalActionErrorContractPayload = {
  action: LocalActionType;
  attribution: z.output<typeof localActionAttributionSchema>;
  lease?: z.output<typeof localActionLeaseBindingSchema> | undefined;
  error: z.output<typeof localActionErrorSchema>;
};

function refineLocalActionContract(payload: LocalActionContractPayload, context: z.RefinementCtx): void {
  if (payload.attribution.session_id !== payload.lease.hcp_session_id) {
    addLocalActionIssue(context, ["lease", "hcp_session_id"], "Local action lease session must match request attribution.");
  }
  if (payload.attribution.workspace_id !== payload.lease.workspace_id) {
    addLocalActionIssue(context, ["lease", "workspace_id"], "Local action lease workspace must match request attribution.");
  }
  if (payload.attribution.provider_instance_id !== payload.lease.provider_instance_id) {
    addLocalActionIssue(context, ["lease", "provider_instance_id"], "Local action lease provider must match request attribution.");
  }
  if (payload.attribution.run_id !== payload.lease.run_id) {
    addLocalActionIssue(context, ["lease", "run_id"], "Local action lease run must match request attribution.");
  }

  const expectedBinding: { capabilityId: LocalActionProtocolCapabilityId; scope: string } =
    localActionExpectedBinding(payload.action);
  if (payload.lease.capability_id !== expectedBinding.capabilityId) {
    addLocalActionIssue(context, ["lease", "capability_id"], `Action '${payload.action}' must use the ${expectedBinding.capabilityId} capability.`);
  }
  if (payload.lease.scope !== expectedBinding.scope) {
    addLocalActionIssue(context, ["lease", "scope"], `Action '${payload.action}' must use the ${expectedBinding.scope} scope.`);
  }

  if (payload.sandbox !== undefined && !payload.sandbox.requires_workspace_containment) {
    addLocalActionIssue(context, ["sandbox", "requires_workspace_containment"], "Local actions must require workspace containment.");
  }
  if (payload.approval !== undefined && localActionRequiresApproval(payload.action) && payload.approval.status !== "approved") {
    addLocalActionIssue(context, ["approval"], `Action '${payload.action}' requires an approved action hash binding.`);
  }
  if (payload.output_limits !== undefined) {
    refineLocalActionOutputLimits(payload.action, payload.output_limits, context);
  }
}

function refineLocalActionErrorContract(payload: LocalActionErrorContractPayload, context: z.RefinementCtx): void {
  if (localActionErrorMayHaveRejectedBinding(payload.error.code)) {
    return;
  }
  if (payload.lease === undefined) {
    addLocalActionIssue(context, ["lease"], `Error code '${payload.error.code}' requires a validated lease binding.`);
    return;
  }
  refineLocalActionContract(
    {
      action: payload.action,
      attribution: payload.attribution,
      lease: payload.lease,
    },
    context,
  );
}

function addLocalActionIssue(context: z.RefinementCtx, path: Array<string | number>, message: string): void {
  context.addIssue({
    code: "custom",
    path,
    message,
  });
}

function localActionErrorMayHaveRejectedBinding(code: LocalActionErrorCode): boolean {
  switch (code) {
    case "local_capability_lease_missing":
    case "local_capability_lease_expired":
    case "local_capability_lease_revoked":
    case "local_capability_session_mismatch":
    case "local_capability_workspace_mismatch":
    case "local_capability_provider_mismatch":
    case "local_capability_scope_not_granted":
      return true;
    case "local_capability_sandbox_denied":
    case "local_capability_approval_required":
    case "local_capability_approval_mismatch":
    case "local_capability_path_denied":
    case "local_capability_expected_hash_mismatch":
    case "local_capability_output_limit_exceeded":
    case "local_capability_timeout":
    case "local_capability_cancelled":
    case "local_capability_command_denied":
    case "local_capability_process_failed":
    case "local_capability_dev_server_exists":
    case "local_capability_dev_server_not_found":
    case "local_capability_action_failed":
      return false;
  }
}

function localActionExpectedBinding(action: LocalActionType): { capabilityId: LocalActionProtocolCapabilityId; scope: string } {
  switch (action) {
    case "local.filesystem.read":
    case "local.filesystem.list":
      return { capabilityId: "filesystem", scope: "workspace_read" };
    case "local.filesystem.write":
    case "local.filesystem.patch":
      return { capabilityId: "filesystem", scope: "workspace_write" };
    case "local.git.status":
    case "local.git.diff":
      return { capabilityId: "git", scope: "workspace_read" };
    case "local.shell.exec":
      return { capabilityId: "shell", scope: "workspace" };
    case "local.dev_server.start":
    case "local.dev_server.stop":
      return { capabilityId: "dev_server", scope: "workspace" };
  }
}

function localActionRequiresApproval(action: LocalActionType): boolean {
  return action === "local.shell.exec" || action === "local.dev_server.start";
}

function refineLocalActionOutputLimits(
  action: LocalActionType,
  outputLimits: z.output<typeof localActionOutputLimitsSchema>,
  context: z.RefinementCtx,
): void {
  switch (action) {
    case "local.filesystem.read":
      requireLocalActionOutputLimit(outputLimits.content_bytes, "content_bytes", action, context);
      return;
    case "local.filesystem.list":
      requireLocalActionOutputLimit(outputLimits.entries, "entries", action, context);
      return;
    case "local.git.diff":
      requireLocalActionOutputLimit(outputLimits.diff_bytes, "diff_bytes", action, context);
      return;
    case "local.git.status":
      requireLocalActionOutputLimit(outputLimits.status_bytes, "status_bytes", action, context);
      return;
    case "local.shell.exec":
      requireLocalActionOutputLimit(outputLimits.stdout_bytes, "stdout_bytes", action, context);
      requireLocalActionOutputLimit(outputLimits.stderr_bytes, "stderr_bytes", action, context);
      return;
    case "local.filesystem.write":
    case "local.filesystem.patch":
    case "local.dev_server.start":
    case "local.dev_server.stop":
      return;
  }
}

function requireLocalActionOutputLimit(
  value: number | undefined,
  field: keyof z.output<typeof localActionOutputLimitsSchema>,
  action: LocalActionType,
  context: z.RefinementCtx,
): void {
  if (value === undefined) {
    addLocalActionIssue(context, ["output_limits", field], `Action '${action}' requires output limit '${field}'.`);
  }
}

export const harnessUsageSnapshotSchema = z
  .object({
    input_tokens: z.number().int().nonnegative().optional(),
    output_tokens: z.number().int().nonnegative().optional(),
    total_tokens: z.number().int().nonnegative().optional(),
    cost_usd: z.number().nonnegative().optional(),
  })
  .strict();

export const harnessTurnFinalOutputSchema = z
  .object({
    final_text: z.string().optional(),
    structured_output: z.unknown().optional(),
    diff_summary: z.string().optional(),
    changed_files: z
      .array(
        z
          .object({
            path: nonEmptyStringSchema,
            change_type: z.enum(["added", "modified", "deleted", "renamed"]),
          })
          .strict(),
      )
      .optional(),
    artifact_refs: z
      .array(
        z
          .object({
            id: nonEmptyStringSchema,
            kind: z.enum(["diff", "file", "log", "image", "other"]),
            label: nonEmptyStringSchema.optional(),
            size_bytes: z.number().int().nonnegative().optional(),
          })
          .strict(),
      )
      .optional(),
    usage: harnessUsageSnapshotSchema.optional(),
    exit_reason: nonEmptyStringSchema.optional(),
  })
  .strict();

export const hcpExtensionEventDataSchema = z
  .object({
    summary: z.string().optional(),
    fields: unknownRecordSchema.optional(),
  })
  .strict();

export const hcpKnownEventDataSchema = z
  .object({
    summary: z.string().optional(),
    message: z.string().optional(),
    details: unknownRecordSchema.optional(),
  })
  .strict();

export const hcpRawDiagnosticPayloadSchema = z
  .object({
    source: nonEmptyStringSchema,
    payload: unknownRecordSchema,
  })
  .strict();

const sessionEventDataSchema = z
  .object({
    provider_instance_id: nonEmptyStringSchema.optional(),
    driver_kind: nonEmptyStringSchema.optional(),
    workspace_id: nonEmptyStringSchema.optional(),
    cwd: nonEmptyStringSchema.optional(),
    sandbox_mode: z.enum(["read_only", "workspace_write", "danger_full_access"]).optional(),
    state: nonEmptyStringSchema.optional(),
    reason: z.string().optional(),
    exit_code: z.number().int().optional(),
    model_selection: harnessModelSelectionSchema.optional(),
    mcp_server_count: z.number().int().nonnegative().optional(),
    local_capabilities: z.array(nonEmptyStringSchema).optional(),
    message: z.string().optional(),
  })
  .strict();

const threadEventDataSchema = z
  .object({
    thread_id: nonEmptyStringSchema.optional(),
    state: nonEmptyStringSchema.optional(),
    metadata: unknownRecordSchema.optional(),
    usage: harnessUsageSnapshotSchema.optional(),
    item: z.unknown().optional(),
    audio_delta: z.string().optional(),
    error: hcpErrorSchema.optional(),
  })
  .strict();

const accountEventDataSchema = z
  .object({
    provider_instance_id: nonEmptyStringSchema.optional(),
    status: nonEmptyStringSchema.optional(),
    auth: providerAuthSnapshotSchema.optional(),
    account: unknownRecordSchema.optional(),
    rate_limits: unknownRecordSchema.optional(),
    message: z.string().optional(),
  })
  .strict();

const turnLifecycleEventDataSchema = z
  .object({
    turn_id: nonEmptyStringSchema.optional(),
    provider_instance_id: nonEmptyStringSchema.optional(),
    input_length: z.number().int().nonnegative().optional(),
    model_selection: harnessModelSelectionSchema.optional(),
    status: nonEmptyStringSchema.optional(),
    plan: z.unknown().optional(),
    delta: z.string().optional(),
    diff_summary: z.string().optional(),
    error: hcpErrorSchema.optional(),
  })
  .strict();

const itemEventDataSchema = z
  .object({
    item_id: nonEmptyStringSchema.optional(),
    item_type: nonEmptyStringSchema.optional(),
    status: nonEmptyStringSchema.optional(),
    content: z.unknown().optional(),
    summary: z.string().optional(),
  })
  .strict();

const textDeltaEventDataSchema = z
  .object({
    stream_kind: nonEmptyStringSchema.optional(),
    delta: z.string(),
  })
  .strict();

const commandEventDataSchema = z
  .object({
    command_id: nonEmptyStringSchema.optional(),
    command: z.string().optional(),
    argv: z.array(z.string()).optional(),
    cwd: nonEmptyStringSchema.optional(),
    status: nonEmptyStringSchema.optional(),
    exit_code: z.number().int().optional(),
    duration_ms: z.number().nonnegative().optional(),
    output: z.unknown().optional(),
    error: hcpErrorSchema.optional(),
  })
  .strict();

const localCapabilityLeaseEventDataSchema = z
  .object({
    lease_id: nonEmptyStringSchema,
    workspace_id: nonEmptyStringSchema,
    provider_instance_id: nonEmptyStringSchema,
    status: z.enum(["created", "started", "revoked", "expired"]),
    capability_ids: z.array(nonEmptyStringSchema).optional(),
    reason: z.string().optional(),
  })
  .strict();

const localCapabilityActionEventDataSchema = z
  .object({
    lease_id: nonEmptyStringSchema,
    run_id: nonEmptyStringSchema,
    workspace_id: nonEmptyStringSchema,
    provider_instance_id: nonEmptyStringSchema,
    capability_id: nonEmptyStringSchema,
    action: nonEmptyStringSchema,
    status: z.enum(["started", "completed", "failed"]),
    duration_ms: z.number().nonnegative().optional(),
    input: z.unknown().optional(),
    output: z.unknown().optional(),
    error: hcpErrorSchema.optional(),
  })
  .strict();

const mcpToolEventDataSchema = z
  .object({
    server_name: nonEmptyStringSchema.optional(),
    attachment: nonEmptyStringSchema.optional(),
    tool_name: nonEmptyStringSchema,
    status: z.enum(["started", "completed", "failed"]).optional(),
    input_summary: z.unknown().optional(),
    output_summary: z.unknown().optional(),
    arguments: z.unknown().optional(),
    result: z.unknown().optional(),
    duration_ms: z.number().nonnegative().optional(),
    error: hcpErrorSchema.optional(),
  })
  .strict();

const mcpStatusEventDataSchema = z
  .object({
    server_name: nonEmptyStringSchema.optional(),
    attachment: nonEmptyStringSchema.optional(),
    status: nonEmptyStringSchema.optional(),
    message: z.string().optional(),
    oauth_state: nonEmptyStringSchema.optional(),
  })
  .strict();

const approvalRequestedEventDataSchema = z
  .object({
    request_id: nonEmptyStringSchema,
    session_id: nonEmptyStringSchema,
    turn_id: nonEmptyStringSchema,
    workspace_id: nonEmptyStringSchema,
    provider_instance_id: nonEmptyStringSchema,
    driver_kind: nonEmptyStringSchema,
    request_type: z.enum(["command", "file_read", "file_change", "mcp_tool", "other"]),
    risk_class: z.enum(["low", "medium", "high"]),
    action: z.unknown(),
    action_hash: nonEmptyStringSchema,
    allowed_decisions: z.array(z.enum(["accept", "accept_for_session", "decline", "cancel"])).min(1),
    expires_at: timestampSchema,
    display: z
      .object({
        title: nonEmptyStringSchema,
        detail: z.string().optional(),
      })
      .strict(),
  })
  .strict();

const approvalResolvedEventDataSchema = z
  .object({
    request_id: nonEmptyStringSchema,
    session_id: nonEmptyStringSchema,
    turn_id: nonEmptyStringSchema,
    action_hash: nonEmptyStringSchema,
    decision: z.enum(["accept", "accept_for_session", "decline", "cancel"]),
    actor_id: nonEmptyStringSchema,
    resolved_at: timestampSchema.optional(),
  })
  .strict();

const inputRequestedEventDataSchema = z
  .object({
    request_id: nonEmptyStringSchema,
    session_id: nonEmptyStringSchema,
    turn_id: nonEmptyStringSchema,
    prompt: z.string(),
    input_kind: z.enum(["text", "choice", "multi_choice", "form"]),
    choices: z
      .array(
        z
          .object({
            id: nonEmptyStringSchema,
            label: nonEmptyStringSchema,
            description: z.string().optional(),
          })
          .strict(),
      )
      .optional(),
    required: z.boolean(),
    expires_at: timestampSchema.optional(),
    redaction: z.enum(["none", "secret"]),
  })
  .strict();

const inputResolvedEventDataSchema = z
  .object({
    request_id: nonEmptyStringSchema,
    session_id: nonEmptyStringSchema,
    turn_id: nonEmptyStringSchema,
    actor_id: nonEmptyStringSchema.optional(),
    cancelled: z.boolean().optional(),
    value: z.unknown().optional(),
    resolved_at: timestampSchema.optional(),
  })
  .strict();

const requestEventDataSchema = z
  .object({
    request_id: nonEmptyStringSchema.optional(),
    session_id: nonEmptyStringSchema.optional(),
    turn_id: nonEmptyStringSchema.optional(),
    request_type: nonEmptyStringSchema.optional(),
    status: nonEmptyStringSchema.optional(),
    summary: z.string().optional(),
    resolved_at: timestampSchema.optional(),
  })
  .strict();

const taskEventDataSchema = z
  .object({
    task_id: nonEmptyStringSchema.optional(),
    status: nonEmptyStringSchema.optional(),
    summary: z.string().optional(),
    progress: z.number().min(0).max(1).optional(),
    output: z.unknown().optional(),
    error: hcpErrorSchema.optional(),
  })
  .strict();

const hookEventDataSchema = z
  .object({
    hook_id: nonEmptyStringSchema.optional(),
    name: nonEmptyStringSchema.optional(),
    status: nonEmptyStringSchema.optional(),
    summary: z.string().optional(),
    progress: z.number().min(0).max(1).optional(),
    output: z.unknown().optional(),
    error: hcpErrorSchema.optional(),
  })
  .strict();

const toolEventDataSchema = z
  .object({
    tool_name: nonEmptyStringSchema.optional(),
    status: nonEmptyStringSchema.optional(),
    summary: z.string().optional(),
    progress: z.number().min(0).max(1).optional(),
  })
  .strict();

const modelReroutedEventDataSchema = z
  .object({
    from_model: nonEmptyStringSchema.optional(),
    to_model: nonEmptyStringSchema.optional(),
    reason: z.string().optional(),
  })
  .strict();

const filesPersistedEventDataSchema = z
  .object({
    artifact_refs: harnessTurnFinalOutputSchema.shape.artifact_refs.optional(),
    changed_files: harnessTurnFinalOutputSchema.shape.changed_files.optional(),
  })
  .strict();

const runtimeDiagnosticEventDataSchema = z
  .object({
    code: nonEmptyStringSchema.optional(),
    message: z.string().optional(),
    summary: z.string().optional(),
    details: unknownRecordSchema.optional(),
    event: nonEmptyStringSchema.optional(),
    attachment: nonEmptyStringSchema.optional(),
    url: nonEmptyStringSchema.optional(),
    headers: stringRecordSchema.optional(),
  })
  .strict();

const turnTerminalEventDataSchema = z
  .object({
    status: nonEmptyStringSchema.optional(),
    final_output: harnessTurnFinalOutputSchema,
    error: hcpErrorSchema.optional(),
  })
  .strict();

function schemaForKnownEventType(eventType: KnownHcpEventType): z.ZodType<unknown> {
  if (eventType.startsWith("local_capability.lease.")) {
    return localCapabilityLeaseEventDataSchema;
  }
  if (eventType.startsWith("local_capability.action.")) {
    return localCapabilityActionEventDataSchema;
  }
  if (eventType.startsWith("mcp_tool.")) {
    return mcpToolEventDataSchema;
  }
  if (eventType.startsWith("mcp.")) {
    return mcpStatusEventDataSchema;
  }
  if (eventType.startsWith("session.")) {
    return sessionEventDataSchema;
  }
  if (eventType.startsWith("thread.")) {
    return threadEventDataSchema;
  }
  if (eventType.startsWith("account.") || eventType === "auth.status") {
    return accountEventDataSchema;
  }
  if (eventType === "workspace.preflight.completed") {
    return workspacePreflightCompletedSchema;
  }
  if (eventType === "runtime.warning" || eventType === "runtime.error") {
    return runtimeDiagnosticEventDataSchema;
  }
  if (
    eventType === "turn.completed" ||
    eventType === "turn.failed" ||
    eventType === "turn.aborted" ||
    eventType === "turn.cancelled"
  ) {
    return turnTerminalEventDataSchema;
  }
  if (eventType.startsWith("turn.")) {
    return turnLifecycleEventDataSchema;
  }
  if (eventType.startsWith("item.")) {
    return itemEventDataSchema;
  }
  if (eventType === "content.delta" || eventType === "reasoning.delta") {
    return textDeltaEventDataSchema;
  }
  if (eventType.startsWith("command.") || eventType.startsWith("file_change.")) {
    return commandEventDataSchema;
  }
  if (eventType === "approval.requested") {
    return approvalRequestedEventDataSchema;
  }
  if (eventType === "approval.resolved") {
    return approvalResolvedEventDataSchema;
  }
  if (eventType === "input.requested" || eventType === "user_input.requested") {
    return inputRequestedEventDataSchema;
  }
  if (eventType === "input.resolved" || eventType === "user_input.resolved") {
    return inputResolvedEventDataSchema;
  }
  if (eventType.startsWith("request.")) {
    return requestEventDataSchema;
  }
  if (eventType.startsWith("task.")) {
    return taskEventDataSchema;
  }
  if (eventType.startsWith("hook.")) {
    return hookEventDataSchema;
  }
  if (eventType.startsWith("tool.")) {
    return toolEventDataSchema;
  }
  if (eventType === "model.rerouted") {
    return modelReroutedEventDataSchema;
  }
  if (eventType === "files.persisted") {
    return filesPersistedEventDataSchema;
  }
  if (eventType === "usage.updated") {
    return harnessUsageSnapshotSchema;
  }
  if (eventType === "config.warning" || eventType === "deprecation.notice") {
    return runtimeDiagnosticEventDataSchema;
  }

  return hcpKnownEventDataSchema;
}

export const knownHcpEventDataSchemas = Object.freeze(
  Object.fromEntries(
    KNOWN_HCP_EVENT_TYPES.map((eventType: KnownHcpEventType): [KnownHcpEventType, z.ZodType<unknown>] => [
      eventType,
      schemaForKnownEventType(eventType),
    ]),
  ),
) as Readonly<Record<KnownHcpEventType, z.ZodType<unknown>>>;

export function isKnownHcpEventType(value: string): value is KnownHcpEventType {
  return (KNOWN_HCP_EVENT_TYPES as readonly string[]).includes(value);
}

export function isHcpEventType(value: string): value is HcpEventType {
  return isKnownHcpEventType(value) || value.startsWith("provider.") || value.startsWith("extension.");
}

function enforceEnvelopeSizeLimits(
  envelope: { payload?: unknown; metadata?: HcpMetadata | undefined },
  context: z.RefinementCtx,
): void {
  const payloadBytes: number = encodedJsonByteLength(envelope.payload);
  if (payloadBytes > HCP_PAYLOAD_MAX_ENCODED_BYTES) {
    context.addIssue({
      code: "custom",
      path: ["payload"],
      message: `HCP payload exceeds ${HCP_PAYLOAD_MAX_ENCODED_BYTES} encoded bytes.`,
    });
  }
  if (envelope.metadata !== undefined) {
    const metadataBytes: number = encodedJsonByteLength(envelope.metadata);
    if (metadataBytes > HCP_METADATA_MAX_ENCODED_BYTES) {
      context.addIssue({
        code: "custom",
        path: ["metadata"],
        message: `HCP metadata exceeds ${HCP_METADATA_MAX_ENCODED_BYTES} encoded bytes.`,
      });
    }
  }
}

function encodedJsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value) ?? "null").byteLength;
}

export const hcpEventTypeSchema = z.string().refine(isHcpEventType, {
  message: "Event type must be a known HCP event, provider.* event, or extension.* event.",
});

export const hcpHarnessEventPayloadSchema = z
  .object({
    session_id: nonEmptyStringSchema,
    turn_id: nonEmptyStringSchema.optional(),
    sequence: z.number().int().positive(),
    event_type: hcpEventTypeSchema,
    created_at: timestampSchema,
    data: z.unknown(),
    raw: hcpRawDiagnosticPayloadSchema.optional(),
  })
  .strict()
  .superRefine((payload, context) => {
    const eventType: string = payload.event_type;
    const dataSchema: z.ZodType<unknown> = isKnownHcpEventType(eventType)
      ? knownHcpEventDataSchemas[eventType]
      : hcpExtensionEventDataSchema;
    const dataResult = dataSchema.safeParse(payload.data);
    if (!dataResult.success) {
      for (const issue of dataResult.error.issues) {
        context.addIssue({
          ...issue,
          path: ["data", ...issue.path],
        });
      }
    }
    if (eventType.startsWith("local_capability.action.") && payload.turn_id === undefined) {
      context.addIssue({
        code: "custom",
        path: ["turn_id"],
        message: "Local capability action events must include turn_id for attribution.",
      });
    }
  });

const hcpSessionSnapshotTombstoneSchema = z
  .object({
    entity_type: z.enum(["session", "turn", "item"]),
    entity_id: nonEmptyStringSchema,
    deleted_at: timestampSchema,
  })
  .strict();

const hcpSessionSnapshotBaseShape = {
  command_id: nonEmptyStringSchema,
  session_id: nonEmptyStringSchema,
  generated_at: timestampSchema,
  through_sequence: z.number().int().positive(),
  events: z.array(hcpHarnessEventPayloadSchema).min(1),
  tombstones: z.array(hcpSessionSnapshotTombstoneSchema),
};

export const hcpSessionSnapshotPayloadSchema = z
  .discriminatedUnion("completeness", [
    z
      .object({
        ...hcpSessionSnapshotBaseShape,
        completeness: z.literal("complete"),
        omission_semantics: z.literal("replace"),
        from_sequence: z.literal(1),
      })
      .strict(),
    z
      .object({
        ...hcpSessionSnapshotBaseShape,
        completeness: z.literal("partial"),
        omission_semantics: z.literal("preserve"),
        reason: z.enum(["retention_gap", "size_limit"]),
        from_sequence: z.number().int().positive(),
      })
      .strict(),
  ])
  .superRefine((snapshot, context) => {
    if (snapshot.through_sequence < snapshot.from_sequence) {
      context.addIssue({
        code: "custom",
        path: ["through_sequence"],
        message: "Snapshot range must not end before it starts.",
      });
    }
    for (let index = 0; index < snapshot.events.length; index += 1) {
      const event = snapshot.events[index];
      const expectedSequence: number = snapshot.from_sequence + index;
      if (event?.session_id !== snapshot.session_id) {
        context.addIssue({
          code: "custom",
          path: ["events", index, "session_id"],
          message: "Snapshot events must belong to the requested session.",
        });
      }
      if (event?.sequence !== expectedSequence) {
        context.addIssue({
          code: "custom",
          path: ["events", index, "sequence"],
          message: "Snapshot events must form one contiguous sequence.",
        });
      }
    }
    if (snapshot.events.at(-1)?.sequence !== snapshot.through_sequence) {
      context.addIssue({
        code: "custom",
        path: ["through_sequence"],
        message: "Snapshot through_sequence must equal the final event sequence.",
      });
    }
  });

export const hcpEnvelopeSchema = z
  .object({
    id: nonEmptyStringSchema,
    type: nonEmptyStringSchema,
    version: hcpVersionSchema,
    sent_at: timestampSchema,
    payload: z.unknown(),
    metadata: metadataSchema.optional(),
  })
  .strict()
  .superRefine(enforceEnvelopeSizeLimits);

export function hcpTypedEnvelopeSchema<TType extends string, TPayload extends z.ZodType>(
  type: TType,
  payloadSchema: TPayload,
) {
  return z
    .object({
      id: nonEmptyStringSchema,
      type: z.literal(type),
      version: hcpVersionSchema,
      sent_at: timestampSchema,
      payload: payloadSchema,
      metadata: metadataSchema.optional(),
    })
    .strict()
    .superRefine(enforceEnvelopeSizeLimits);
}

export const hcpCommandAckMessageSchema = hcpTypedEnvelopeSchema("hcp.command.ack", hcpCommandAckPayloadSchema);
export const hcpCommandNackMessageSchema = hcpTypedEnvelopeSchema("hcp.command.nack", hcpCommandNackPayloadSchema);
export const hcpAckMessageSchema = hcpCommandAckMessageSchema;
export const hcpNackMessageSchema = hcpCommandNackMessageSchema;
export const hcpHostHelloMessageSchema = hcpTypedEnvelopeSchema("host.hello", hcpHostHelloPayloadSchema);
export const hcpHostAcceptedMessageSchema = hcpTypedEnvelopeSchema("host.accepted", hcpHostAcceptedPayloadSchema);
export const hcpHostRejectedMessageSchema = hcpTypedEnvelopeSchema("host.rejected", hcpHostRejectedPayloadSchema);
export const hcpHostHeartbeatMessageSchema = hcpTypedEnvelopeSchema("host.heartbeat", hcpHostHeartbeatPayloadSchema);
export const hcpHostCapabilitiesUpdatedMessageSchema = hcpTypedEnvelopeSchema(
  "host.capabilities.updated",
  hcpHostCapabilitiesUpdatedPayloadSchema,
);
export const hcpHostReplayUnavailableMessageSchema = hcpTypedEnvelopeSchema(
  "host.replay.unavailable",
  hcpHostReplayUnavailablePayloadSchema,
);
export const hcpSessionStartMessageSchema = hcpTypedEnvelopeSchema(
  "harness.session.start",
  hcpSessionStartPayloadSchema,
);
export const hcpSessionSnapshotRequestMessageSchema = hcpTypedEnvelopeSchema(
  "harness.session.snapshot.request",
  hcpSessionSnapshotRequestPayloadSchema,
);
export const hcpSessionSnapshotMessageSchema = hcpTypedEnvelopeSchema(
  "harness.session.snapshot",
  hcpSessionSnapshotPayloadSchema,
);
export const hcpTurnSendMessageSchema = hcpTypedEnvelopeSchema("harness.turn.send", hcpTurnSendPayloadSchema);
export const hcpTurnCancelMessageSchema = hcpTypedEnvelopeSchema("harness.turn.cancel", hcpTurnCancelPayloadSchema);
export const hcpSessionStopMessageSchema = hcpTypedEnvelopeSchema("harness.session.stop", hcpSessionStopPayloadSchema);
export const hcpApprovalRespondMessageSchema = hcpTypedEnvelopeSchema(
  "harness.approval.respond",
  hcpApprovalResponsePayloadSchema,
);
export const hcpInputRespondMessageSchema = hcpTypedEnvelopeSchema(
  "harness.input.respond",
  hcpInputResponsePayloadSchema,
);
export const toolServersDetachMessageSchema = hcpTypedEnvelopeSchema(
  "tool_servers.detach",
  toolServersDetachPayloadSchema,
);
export const localActionRequestMessageSchema = hcpTypedEnvelopeSchema(
  "local.action.request",
  localActionRequestPayloadSchema,
);
export const localActionResponseMessageSchema = hcpTypedEnvelopeSchema(
  "local.action.response",
  localActionResponsePayloadSchema,
);
export const localActionErrorMessageSchema = hcpTypedEnvelopeSchema(
  "local.action.error",
  localActionErrorPayloadSchema,
);
export const hcpHarnessEventMessageSchema = hcpTypedEnvelopeSchema("harness.event", hcpHarnessEventPayloadSchema);

export const hcpWorkspacesRequestMessageSchema = hcpTypedEnvelopeSchema("host.workspaces.request", hcpWorkspacesRequestPayloadSchema);
export const hcpWorkspacesResultMessageSchema = hcpTypedEnvelopeSchema("host.workspaces.result", hcpWorkspacesResultPayloadSchema);

export const hcpMessageSchema = z.discriminatedUnion("type", [
  hcpWorkspacesRequestMessageSchema,
  hcpWorkspacesResultMessageSchema,
  hcpCommandAckMessageSchema,
  hcpCommandNackMessageSchema,
  hcpHostHelloMessageSchema,
  hcpHostAcceptedMessageSchema,
  hcpHostRejectedMessageSchema,
  hcpHostHeartbeatMessageSchema,
  hcpHostCapabilitiesUpdatedMessageSchema,
  hcpHostReplayUnavailableMessageSchema,
  hcpSessionStartMessageSchema,
  hcpSessionSnapshotRequestMessageSchema,
  hcpSessionSnapshotMessageSchema,
  hcpTurnSendMessageSchema,
  hcpTurnCancelMessageSchema,
  hcpSessionStopMessageSchema,
  hcpApprovalRespondMessageSchema,
  hcpInputRespondMessageSchema,
  toolServersDetachMessageSchema,
  localActionRequestMessageSchema,
  localActionResponseMessageSchema,
  localActionErrorMessageSchema,
  hcpHarnessEventMessageSchema,
]);

export type HcpCommandAckMessage = HcpEnvelope<"hcp.command.ack", HcpCommandAckPayload>;
export type HcpCommandNackMessage = HcpEnvelope<"hcp.command.nack", HcpCommandNackPayload>;
export type HcpAckMessage = HcpCommandAckMessage;
export type HcpNackMessage = HcpCommandNackMessage;
export type HcpHostHelloMessage = HcpEnvelope<"host.hello", HcpHostHelloPayload>;
export type HcpHostAcceptedMessage = HcpEnvelope<"host.accepted", HcpHostAcceptedPayload>;
export type HcpHostRejectedMessage = HcpEnvelope<"host.rejected", HcpHostRejectedPayload>;
export type HcpHostHeartbeatMessage = HcpEnvelope<"host.heartbeat", HcpHostHeartbeatPayload>;
export type HcpHostCapabilitiesUpdatedMessage = HcpEnvelope<
  "host.capabilities.updated",
  HcpHostCapabilitiesUpdatedPayload
>;
export type HcpHostReplayUnavailableMessage = HcpEnvelope<
  "host.replay.unavailable",
  HcpHostReplayUnavailablePayload
>;
export type HcpSessionStartMessage = HcpEnvelope<"harness.session.start", HcpSessionStartPayload>;
export type HcpSessionSnapshotRequestMessage = HcpEnvelope<
  "harness.session.snapshot.request",
  HcpSessionSnapshotRequestPayload
>;
export type HcpSessionSnapshotMessage = HcpEnvelope<"harness.session.snapshot", HcpSessionSnapshotPayload>;
export type HcpTurnSendMessage = HcpEnvelope<"harness.turn.send", HcpTurnSendPayload>;
export type HcpTurnCancelMessage = HcpEnvelope<"harness.turn.cancel", HcpTurnCancelPayload>;
export type HcpSessionStopMessage = HcpEnvelope<"harness.session.stop", HcpSessionStopPayload>;
export type HcpApprovalRespondMessage = HcpEnvelope<"harness.approval.respond", HcpApprovalResponsePayload>;
export type HcpInputRespondMessage = HcpEnvelope<"harness.input.respond", HcpInputResponsePayload>;
export type ToolServersDetachMessage = HcpEnvelope<"tool_servers.detach", ToolServersDetachPayload>;
export type LocalActionRequestMessage = HcpEnvelope<"local.action.request", LocalActionRequestPayload>;
export type LocalActionResponseMessage = HcpEnvelope<"local.action.response", LocalActionResponsePayload>;
export type LocalActionErrorMessage = HcpEnvelope<"local.action.error", LocalActionErrorPayload>;
export type HcpHarnessEventMessage = HcpEnvelope<"harness.event", HcpHarnessEventPayload>;

export type HcpMessage =
  | HcpEnvelope<"host.workspaces.request", HcpWorkspacesRequestPayload>
  | HcpEnvelope<"host.workspaces.result", HcpWorkspacesResultPayload>
  | HcpCommandAckMessage
  | HcpCommandNackMessage
  | HcpHostHelloMessage
  | HcpHostAcceptedMessage
  | HcpHostRejectedMessage
  | HcpHostHeartbeatMessage
  | HcpHostCapabilitiesUpdatedMessage
  | HcpHostReplayUnavailableMessage
  | HcpSessionStartMessage
  | HcpSessionSnapshotRequestMessage
  | HcpSessionSnapshotMessage
  | HcpTurnSendMessage
  | HcpTurnCancelMessage
  | HcpSessionStopMessage
  | HcpApprovalRespondMessage
  | HcpInputRespondMessage
  | ToolServersDetachMessage
  | LocalActionRequestMessage
  | LocalActionResponseMessage
  | LocalActionErrorMessage
  | HcpHarnessEventMessage;

export type HcpKnownMessageType = HcpMessage["type"];

export function parseHcpEnvelope(input: unknown): HcpEnvelope<string, unknown> {
  return hcpEnvelopeSchema.parse(input) as HcpEnvelope<string, unknown>;
}

export function parseHcpMessage(input: unknown): HcpMessage {
  return hcpMessageSchema.parse(input) as HcpMessage;
}

export function parseJsonHcpMessage(input: string): HcpMessage {
  const parsed: unknown = JSON.parse(input);
  return parseHcpMessage(parsed);
}

export function createHcpEnvelope<TType extends HcpKnownMessageType, TPayload>(
  type: TType,
  payload: TPayload,
  metadata?: HcpMetadata,
): HcpEnvelope<TType, TPayload> {
  return {
    id: crypto.randomUUID(),
    type,
    version: HCP_VERSION,
    sent_at: new Date().toISOString(),
    payload,
    ...(metadata ? { metadata } : {}),
  };
}

export function parseHcpHostHelloPayload(input: unknown): HcpHostHelloPayload {
  return hcpHostHelloPayloadSchema.parse(input) as HcpHostHelloPayload;
}

export function parseHcpHostAcceptedPayload(input: unknown): HcpHostAcceptedPayload {
  return hcpHostAcceptedPayloadSchema.parse(input) as HcpHostAcceptedPayload;
}

export function parseHcpHostRejectedPayload(input: unknown): HcpHostRejectedPayload {
  return hcpHostRejectedPayloadSchema.parse(input) as HcpHostRejectedPayload;
}

export function parseHcpHostHeartbeatPayload(input: unknown): HcpHostHeartbeatPayload {
  return hcpHostHeartbeatPayloadSchema.parse(input) as HcpHostHeartbeatPayload;
}

export function parseHcpHostCapabilitiesUpdatedPayload(input: unknown): HcpHostCapabilitiesUpdatedPayload {
  return hcpHostCapabilitiesUpdatedPayloadSchema.parse(input) as HcpHostCapabilitiesUpdatedPayload;
}

export function parseHcpHostReplayUnavailablePayload(input: unknown): HcpHostReplayUnavailablePayload {
  return hcpHostReplayUnavailablePayloadSchema.parse(input) as HcpHostReplayUnavailablePayload;
}

export function parseHarnessProviderSnapshot(input: unknown): HarnessProviderSnapshot {
  return harnessProviderSnapshotSchema.parse(input) as HarnessProviderSnapshot;
}

export function parseLocalCapabilityLease(input: unknown): LocalCapabilityLease {
  return localCapabilityLeaseSchema.parse(input) as LocalCapabilityLease;
}

export function parseMcpServerAttachment(input: unknown): McpServerAttachment {
  return mcpServerAttachmentSchema.parse(input) as McpServerAttachment;
}

export function parseHcpSessionStartPayload(input: unknown): HcpSessionStartPayload {
  return hcpSessionStartPayloadSchema.parse(input) as HcpSessionStartPayload;
}

export function parseHcpSessionSnapshotRequestPayload(input: unknown): HcpSessionSnapshotRequestPayload {
  return hcpSessionSnapshotRequestPayloadSchema.parse(input) as HcpSessionSnapshotRequestPayload;
}

export function parseHcpSessionSnapshotPayload(input: unknown): HcpSessionSnapshotPayload {
  return hcpSessionSnapshotPayloadSchema.parse(input) as HcpSessionSnapshotPayload;
}

export function parseHcpTurnSendPayload(input: unknown): HcpTurnSendPayload {
  return hcpTurnSendPayloadSchema.parse(input) as HcpTurnSendPayload;
}

export function parseLocalActionRequestPayload(input: unknown): LocalActionRequestPayload {
  return localActionRequestPayloadSchema.parse(input) as LocalActionRequestPayload;
}

export function parseLocalActionResponsePayload(input: unknown): LocalActionResponsePayload {
  return localActionResponsePayloadSchema.parse(input) as LocalActionResponsePayload;
}

export function parseLocalActionErrorPayload(input: unknown): LocalActionErrorPayload {
  return localActionErrorPayloadSchema.parse(input) as LocalActionErrorPayload;
}

export function parseHcpHarnessEventPayload(input: unknown): HcpHarnessEventPayload {
  return hcpHarnessEventPayloadSchema.parse(input) as HcpHarnessEventPayload;
}

export {
  HcpSessionEventReducer,
  type HcpEventApplyResult,
  type HcpSnapshotApplyResult,
} from "./session-reducer.js";

export * from "./pairing.js";
