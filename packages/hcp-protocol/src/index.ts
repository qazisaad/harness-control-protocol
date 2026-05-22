export const HCP_VERSION = "hcp.v0" as const;

export type HcpVersion = typeof HCP_VERSION;

export type HcpEnvelope<TType extends string, TPayload> = {
  id: string;
  type: TType;
  version: HcpVersion;
  sent_at: string;
  payload: TPayload;
  metadata?: Record<string, unknown>;
};

export type HcpAckPayload = {
  received_message_id: string;
  status: "ack";
};

export type HcpNackPayload = {
  received_message_id: string;
  status: "nack";
  error: HcpError;
};

export type HcpError = {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
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

export type HcpHostHelloPayload = {
  runner_id: string;
  host_id: string;
  runner_version: string;
  supported_protocol_versions: HcpVersion[];
  capabilities: string[];
  last_event_sequence?: number;
};

export type HcpHostAcceptedPayload = {
  protocol_version: HcpVersion;
  heartbeat_interval_seconds: number;
};

export type HcpHostCapabilitiesUpdatedPayload = {
  providers: HarnessProviderSnapshot[];
  workspaces: Array<{
    id: string;
    path: string;
    git_remote?: string;
  }>;
};

export type McpServerAttachment = {
  name: string;
  transport: "streamable_http";
  url: string;
  headers?: Record<string, string>;
  expires_at?: string;
  allowed_tools?: string[];
  denied_tools?: string[];
};

export type HarnessModelSelection = {
  model: string;
  options?: Array<{
    id: string;
    value: string | boolean | number;
  }>;
};

export type HcpSessionStartPayload = {
  session_id: string;
  provider_instance_id: string;
  driver_kind: string;
  continuation_group_key?: string;
  cwd: string;
  runtime_mode: "approval_required" | "non_interactive";
  sandbox_mode: "read_only" | "workspace_write" | "danger_full_access";
  approval_policy: "ask" | "auto_edits" | "full_access";
  continue_session: boolean;
  model_selection: HarnessModelSelection;
  mcp_servers: McpServerAttachment[];
};

export type HcpTurnSendPayload = {
  session_id: string;
  turn_id: string;
  input: string;
  model_selection?: HarnessModelSelection;
};

export type HcpEventType =
  | "session.started"
  | "session.configured"
  | "session.exited"
  | "session.replay_unavailable"
  | "auth.status"
  | "account.updated"
  | "account.rate_limits.updated"
  | "turn.started"
  | "turn.completed"
  | "turn.failed"
  | "turn.cancelled"
  | "content.delta"
  | "reasoning.delta"
  | "command.started"
  | "command.completed"
  | "file_change.started"
  | "file_change.completed"
  | "mcp_tool.started"
  | "mcp_tool.completed"
  | "mcp.oauth.completed"
  | "approval.requested"
  | "approval.resolved"
  | "input.requested"
  | "input.resolved"
  | "model.rerouted"
  | "config.warning"
  | "deprecation.notice"
  | "files.persisted"
  | "workspace.preflight.completed"
  | "usage.updated"
  | "runtime.warning"
  | "runtime.error";

export type HcpHarnessEventPayload = {
  session_id: string;
  turn_id?: string;
  sequence: number;
  event_type: HcpEventType;
  created_at: string;
  data: Record<string, unknown>;
};

