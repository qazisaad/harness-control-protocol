import { z } from "zod";

export const HCP_VERSION = "hcp.v0" as const;

export type HcpVersion = typeof HCP_VERSION;

export const HOST_LIFECYCLE_MESSAGE_TYPES = [
  "host.hello",
  "host.accepted",
  "host.rejected",
  "host.heartbeat",
  "host.capabilities.updated",
] as const;

export const CONTROL_PLANE_COMMAND_MESSAGE_TYPES = [
  "harness.session.start",
  "harness.turn.send",
  "harness.turn.cancel",
  "harness.session.stop",
  "harness.approval.respond",
  "harness.input.respond",
  "tool_servers.detach",
] as const;

export const COMMAND_ACK_MESSAGE_TYPES = ["hcp.command.ack", "hcp.command.nack"] as const;

export const RUNTIME_EVENT_MESSAGE_TYPES = ["harness.event"] as const;

export const KNOWN_HCP_EVENT_TYPES = [
  "session.started",
  "session.configured",
  "session.state.changed",
  "session.exited",
  "session.replay_unavailable",
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
export type RuntimeEventMessageType = (typeof RUNTIME_EVENT_MESSAGE_TYPES)[number];
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

export type HcpHostHelloPayload = {
  runner_id: string;
  host_id: string;
  runner_version: string;
  supported_protocol_versions: HcpVersion[];
  capabilities: string[];
  resume?: HostResumeCursor;
};

export type HcpHostAcceptedPayload = {
  protocol_version: HcpVersion;
  heartbeat_interval_seconds: number;
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

export type HarnessProviderSnapshot = {
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
  id: string;
  path: string;
  git_remote?: string;
};

export type HcpHostCapabilitiesUpdatedPayload = {
  providers: HarnessProviderSnapshot[];
  local_capabilities: LocalCapabilitySnapshot[];
  workspaces: HcpWorkspaceSnapshot[];
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

export type McpServerAttachment = {
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

export const hcpHostHelloPayloadSchema = z
  .object({
    runner_id: nonEmptyStringSchema,
    host_id: nonEmptyStringSchema,
    runner_version: nonEmptyStringSchema,
    supported_protocol_versions: z.array(hcpVersionSchema).min(1),
    capabilities: z.array(nonEmptyStringSchema),
    resume: hcpHostResumeCursorSchema.optional(),
  })
  .strict();

export const hcpHostAcceptedPayloadSchema = z
  .object({
    protocol_version: hcpVersionSchema,
    heartbeat_interval_seconds: z.number().int().positive(),
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
  })
  .strict();

export const hcpHostCapabilitiesUpdatedPayloadSchema = z
  .object({
    providers: z.array(harnessProviderSnapshotSchema),
    local_capabilities: z.array(localCapabilitySnapshotSchema),
    workspaces: z.array(hcpWorkspaceSchema),
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

export const mcpServerAttachmentSchema = z
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

export const hcpEnvelopeSchema = z
  .object({
    id: nonEmptyStringSchema,
    type: nonEmptyStringSchema,
    version: hcpVersionSchema,
    sent_at: timestampSchema,
    payload: z.unknown(),
    metadata: metadataSchema.optional(),
  })
  .strict();

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
    .strict();
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
export const hcpSessionStartMessageSchema = hcpTypedEnvelopeSchema(
  "harness.session.start",
  hcpSessionStartPayloadSchema,
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
export const hcpHarnessEventMessageSchema = hcpTypedEnvelopeSchema("harness.event", hcpHarnessEventPayloadSchema);

export const hcpMessageSchema = z.discriminatedUnion("type", [
  hcpCommandAckMessageSchema,
  hcpCommandNackMessageSchema,
  hcpHostHelloMessageSchema,
  hcpHostAcceptedMessageSchema,
  hcpHostRejectedMessageSchema,
  hcpHostHeartbeatMessageSchema,
  hcpHostCapabilitiesUpdatedMessageSchema,
  hcpSessionStartMessageSchema,
  hcpTurnSendMessageSchema,
  hcpTurnCancelMessageSchema,
  hcpSessionStopMessageSchema,
  hcpApprovalRespondMessageSchema,
  hcpInputRespondMessageSchema,
  toolServersDetachMessageSchema,
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
export type HcpSessionStartMessage = HcpEnvelope<"harness.session.start", HcpSessionStartPayload>;
export type HcpTurnSendMessage = HcpEnvelope<"harness.turn.send", HcpTurnSendPayload>;
export type HcpTurnCancelMessage = HcpEnvelope<"harness.turn.cancel", HcpTurnCancelPayload>;
export type HcpSessionStopMessage = HcpEnvelope<"harness.session.stop", HcpSessionStopPayload>;
export type HcpApprovalRespondMessage = HcpEnvelope<"harness.approval.respond", HcpApprovalResponsePayload>;
export type HcpInputRespondMessage = HcpEnvelope<"harness.input.respond", HcpInputResponsePayload>;
export type ToolServersDetachMessage = HcpEnvelope<"tool_servers.detach", ToolServersDetachPayload>;
export type HcpHarnessEventMessage = HcpEnvelope<"harness.event", HcpHarnessEventPayload>;

export type HcpMessage =
  | HcpCommandAckMessage
  | HcpCommandNackMessage
  | HcpHostHelloMessage
  | HcpHostAcceptedMessage
  | HcpHostRejectedMessage
  | HcpHostHeartbeatMessage
  | HcpHostCapabilitiesUpdatedMessage
  | HcpSessionStartMessage
  | HcpTurnSendMessage
  | HcpTurnCancelMessage
  | HcpSessionStopMessage
  | HcpApprovalRespondMessage
  | HcpInputRespondMessage
  | ToolServersDetachMessage
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

export function parseHcpTurnSendPayload(input: unknown): HcpTurnSendPayload {
  return hcpTurnSendPayloadSchema.parse(input) as HcpTurnSendPayload;
}

export function parseHcpHarnessEventPayload(input: unknown): HcpHarnessEventPayload {
  return hcpHarnessEventPayloadSchema.parse(input) as HcpHarnessEventPayload;
}
