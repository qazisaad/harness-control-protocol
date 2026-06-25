import { z } from "zod";

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

export type HcpHostHeartbeatPayload = {
  runner_id: string;
  sequence: number;
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

const nonEmptyStringSchema = z.string().min(1);
const timestampSchema = z.string().datetime({ offset: true });
const unknownRecordSchema = z.record(z.string(), z.unknown());
const stringRecordSchema = z.record(z.string(), z.string());

export const hcpVersionSchema = z.literal(HCP_VERSION);

export const hcpErrorSchema = z
  .object({
    code: nonEmptyStringSchema,
    message: nonEmptyStringSchema,
    retryable: z.boolean(),
    details: unknownRecordSchema.optional(),
  })
  .strict();

export const hcpAckPayloadSchema = z
  .object({
    received_message_id: nonEmptyStringSchema,
    status: z.literal("ack"),
  })
  .strict();

export const hcpNackPayloadSchema = z
  .object({
    received_message_id: nonEmptyStringSchema,
    status: z.literal("nack"),
    error: hcpErrorSchema,
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

const harnessOptionValueSchema = z.union([z.string(), z.boolean(), z.number()]);

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

export const hcpHostHelloPayloadSchema = z
  .object({
    runner_id: nonEmptyStringSchema,
    host_id: nonEmptyStringSchema,
    runner_version: nonEmptyStringSchema,
    supported_protocol_versions: z.array(hcpVersionSchema).min(1),
    capabilities: z.array(z.string()),
    last_event_sequence: z.number().int().nonnegative().optional(),
  })
  .strict();

export const hcpHostAcceptedPayloadSchema = z
  .object({
    protocol_version: hcpVersionSchema,
    heartbeat_interval_seconds: z.number().int().positive(),
  })
  .strict();

export const hcpHostHeartbeatPayloadSchema = z
  .object({
    runner_id: nonEmptyStringSchema,
    sequence: z.number().int().nonnegative(),
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
    workspaces: z.array(hcpWorkspaceSchema),
  })
  .strict();

export const mcpServerAttachmentSchema = z
  .object({
    name: nonEmptyStringSchema,
    transport: z.literal("streamable_http"),
    url: z.string().url(),
    headers: stringRecordSchema.optional(),
    expires_at: timestampSchema.optional(),
    allowed_tools: z.array(z.string()).optional(),
    denied_tools: z.array(z.string()).optional(),
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

export const hcpSessionStartPayloadSchema = z
  .object({
    session_id: nonEmptyStringSchema,
    provider_instance_id: nonEmptyStringSchema,
    driver_kind: nonEmptyStringSchema,
    continuation_group_key: nonEmptyStringSchema.optional(),
    cwd: nonEmptyStringSchema,
    runtime_mode: z.enum(["approval_required", "non_interactive"]),
    sandbox_mode: z.enum(["read_only", "workspace_write", "danger_full_access"]),
    approval_policy: z.enum(["ask", "auto_edits", "full_access"]),
    continue_session: z.boolean(),
    model_selection: harnessModelSelectionSchema,
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

export const hcpEventTypeSchema = z.enum([
  "session.started",
  "session.configured",
  "session.exited",
  "session.replay_unavailable",
  "auth.status",
  "account.updated",
  "account.rate_limits.updated",
  "turn.started",
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  "content.delta",
  "reasoning.delta",
  "command.started",
  "command.completed",
  "file_change.started",
  "file_change.completed",
  "mcp_tool.started",
  "mcp_tool.completed",
  "mcp.oauth.completed",
  "approval.requested",
  "approval.resolved",
  "input.requested",
  "input.resolved",
  "model.rerouted",
  "config.warning",
  "deprecation.notice",
  "files.persisted",
  "workspace.preflight.completed",
  "usage.updated",
  "runtime.warning",
  "runtime.error",
]);

export const hcpHarnessEventPayloadSchema = z
  .object({
    session_id: nonEmptyStringSchema,
    turn_id: nonEmptyStringSchema.optional(),
    sequence: z.number().int().nonnegative(),
    event_type: hcpEventTypeSchema,
    created_at: timestampSchema,
    data: unknownRecordSchema,
  })
  .strict();

export const hcpEnvelopeSchema = z
  .object({
    id: nonEmptyStringSchema,
    type: nonEmptyStringSchema,
    version: hcpVersionSchema,
    sent_at: timestampSchema,
    payload: z.unknown(),
    metadata: unknownRecordSchema.optional(),
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
      metadata: unknownRecordSchema.optional(),
    })
    .strict();
}

export const hcpAckMessageSchema = hcpTypedEnvelopeSchema("ack", hcpAckPayloadSchema);
export const hcpNackMessageSchema = hcpTypedEnvelopeSchema("nack", hcpNackPayloadSchema);
export const hcpHostHelloMessageSchema = hcpTypedEnvelopeSchema(
  "host.hello",
  hcpHostHelloPayloadSchema,
);
export const hcpHostAcceptedMessageSchema = hcpTypedEnvelopeSchema(
  "host.accepted",
  hcpHostAcceptedPayloadSchema,
);
export const hcpHostHeartbeatMessageSchema = hcpTypedEnvelopeSchema(
  "host.heartbeat",
  hcpHostHeartbeatPayloadSchema,
);
export const hcpHostCapabilitiesUpdatedMessageSchema = hcpTypedEnvelopeSchema(
  "host.capabilities.updated",
  hcpHostCapabilitiesUpdatedPayloadSchema,
);
export const hcpSessionStartMessageSchema = hcpTypedEnvelopeSchema(
  "session.start",
  hcpSessionStartPayloadSchema,
);
export const hcpTurnSendMessageSchema = hcpTypedEnvelopeSchema("turn.send", hcpTurnSendPayloadSchema);
export const hcpHarnessEventMessageSchema = hcpTypedEnvelopeSchema(
  "harness.event",
  hcpHarnessEventPayloadSchema,
);

export const hcpMessageSchema = z.discriminatedUnion("type", [
  hcpAckMessageSchema,
  hcpNackMessageSchema,
  hcpHostHelloMessageSchema,
  hcpHostAcceptedMessageSchema,
  hcpHostHeartbeatMessageSchema,
  hcpHostCapabilitiesUpdatedMessageSchema,
  hcpSessionStartMessageSchema,
  hcpTurnSendMessageSchema,
  hcpHarnessEventMessageSchema,
]);

export type HcpAckMessage = HcpEnvelope<"ack", HcpAckPayload>;
export type HcpNackMessage = HcpEnvelope<"nack", HcpNackPayload>;
export type HcpHostHelloMessage = HcpEnvelope<"host.hello", HcpHostHelloPayload>;
export type HcpHostAcceptedMessage = HcpEnvelope<"host.accepted", HcpHostAcceptedPayload>;
export type HcpHostHeartbeatMessage = HcpEnvelope<"host.heartbeat", HcpHostHeartbeatPayload>;
export type HcpHostCapabilitiesUpdatedMessage = HcpEnvelope<
  "host.capabilities.updated",
  HcpHostCapabilitiesUpdatedPayload
>;
export type HcpSessionStartMessage = HcpEnvelope<"session.start", HcpSessionStartPayload>;
export type HcpTurnSendMessage = HcpEnvelope<"turn.send", HcpTurnSendPayload>;
export type HcpHarnessEventMessage = HcpEnvelope<"harness.event", HcpHarnessEventPayload>;

export type HcpMessage =
  | HcpAckMessage
  | HcpNackMessage
  | HcpHostHelloMessage
  | HcpHostAcceptedMessage
  | HcpHostHeartbeatMessage
  | HcpHostCapabilitiesUpdatedMessage
  | HcpSessionStartMessage
  | HcpTurnSendMessage
  | HcpHarnessEventMessage;

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

export function createHcpEnvelope<TType extends HcpMessage["type"], TPayload>(
  type: TType,
  payload: TPayload,
  metadata?: Record<string, unknown>,
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

export function parseHcpHostHeartbeatPayload(input: unknown): HcpHostHeartbeatPayload {
  return hcpHostHeartbeatPayloadSchema.parse(input) as HcpHostHeartbeatPayload;
}

export function parseHcpHostCapabilitiesUpdatedPayload(
  input: unknown,
): HcpHostCapabilitiesUpdatedPayload {
  return hcpHostCapabilitiesUpdatedPayloadSchema.parse(input) as HcpHostCapabilitiesUpdatedPayload;
}

export function parseHarnessProviderSnapshot(input: unknown): HarnessProviderSnapshot {
  return harnessProviderSnapshotSchema.parse(input) as HarnessProviderSnapshot;
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
