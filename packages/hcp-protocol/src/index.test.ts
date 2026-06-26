import assert from "node:assert/strict";
import test from "node:test";

import {
  HCP_METADATA_MAX_ENCODED_BYTES,
  HCP_PAYLOAD_MAX_ENCODED_BYTES,
  HCP_VERSION,
  hcpMessageSchema,
  parseHcpMessage,
  parseLocalCapabilityLease,
  type HcpEnvelope,
  type HcpHostHelloPayload,
  type HcpSessionStartPayload,
  type LocalCapabilityLease,
  type McpServerAttachment,
} from "./index.js";

const sentAt = "2026-01-01T00:00:00.000Z";

function createEnvelope<TType extends string, TPayload>(
  type: TType,
  payload: TPayload,
): HcpEnvelope<TType, TPayload> {
  return {
    id: `message-${type}`,
    type,
    version: HCP_VERSION,
    sent_at: sentAt,
    payload,
  };
}

function proofBoundAttachment(overrides: Partial<McpServerAttachment> = {}): McpServerAttachment {
  return {
    name: "linear",
    transport: "streamable_http",
    url: "https://example.com/mcp/linear",
    headers: {
      Authorization: "Bearer lease-token",
    },
    lease_id: "mcp_lease_123",
    proof_of_possession: {
      scheme: "runner_signed_request",
      key_id: "proof_key_123",
      required_headers: [
        "x-hcp-session-id",
        "x-hcp-host-id",
        "x-hcp-proof-signature",
        "x-hcp-proof-nonce",
      ],
    },
    ...overrides,
  };
}

function localLease(overrides: Partial<LocalCapabilityLease> = {}): LocalCapabilityLease {
  return {
    lease_id: "local_lease_123",
    org_id: "org_123",
    actor_id: "user_123",
    workflow_id: "workflow_123",
    run_id: "run_123",
    node_id: "node_harness",
    hcp_session_id: "session-1",
    execution_host_id: "host-local",
    provider_instance_id: "provider-1",
    workspace_id: "workspace-1",
    issued_at: sentAt,
    expires_at: "2026-01-01T01:00:00.000Z",
    policy_version: "policy_2026_01_01",
    capabilities: [
      {
        id: "filesystem",
        scopes: ["workspace_read", "workspace_write"],
      },
      {
        id: "shell",
        scopes: ["workspace"],
        approval_policy: "ask",
        command_policy: {
          allowed_executables: ["npm"],
          denied_executables: ["rm"],
          cwd_policy: "selected_workspace_only",
          env_policy: "minimal",
          allow_shell: false,
          timeout_seconds: 60,
          network_policy: "inherit",
        },
      },
    ],
    ...overrides,
  };
}

test("parses valid host hello envelopes with resume cursors", () => {
  const payload: HcpHostHelloPayload = {
    runner_id: "runner-local",
    host_id: "host-local",
    runner_version: "0.0.0",
    supported_protocol_versions: [HCP_VERSION],
    capabilities: ["providers", "mcp_streamable_http"],
    resume: {
      sessions: [{ session_id: "session-1", last_event_sequence: 12 }],
    },
  };

  const envelope = createEnvelope("host.hello", payload);
  const parsed = parseHcpMessage(envelope);

  assert.equal(parsed.type, "host.hello");
  if (parsed.type === "host.hello") {
    assert.equal(parsed.payload.resume?.sessions[0]?.last_event_sequence, 12);
  }
});

test("rejects unknown envelope types and top-level fields", () => {
  assert.equal(
    hcpMessageSchema.safeParse({
      id: "message-1",
      type: "unknown.message",
      version: HCP_VERSION,
      sent_at: sentAt,
      payload: {},
    }).success,
    false,
  );

  assert.equal(
    hcpMessageSchema.safeParse({
      ...createEnvelope("host.hello", {
        runner_id: "runner-local",
        host_id: "host-local",
        runner_version: "0.0.0",
        supported_protocol_versions: [HCP_VERSION],
        capabilities: [],
      }),
      unexpected: true,
    }).success,
    false,
  );
});

test("rejects oversized metadata and payloads", () => {
  const baseEnvelope = createEnvelope("host.hello", {
    runner_id: "runner-local",
    host_id: "host-local",
    runner_version: "0.0.0",
    supported_protocol_versions: [HCP_VERSION],
    capabilities: [],
  });

  assert.equal(
    hcpMessageSchema.safeParse({
      ...baseEnvelope,
      metadata: { oversized: "x".repeat(HCP_METADATA_MAX_ENCODED_BYTES + 1) },
    }).success,
    false,
  );
  assert.equal(
    hcpMessageSchema.safeParse({
      ...baseEnvelope,
      payload: { oversized: "x".repeat(HCP_PAYLOAD_MAX_ENCODED_BYTES + 1) },
    }).success,
    false,
  );
});

test("parses v0 harness session starts with MCP and local capability leases", () => {
  const payload: HcpSessionStartPayload = {
    session_id: "session-1",
    workspace_id: "workspace-1",
    provider_instance_id: "provider-1",
    driver_kind: "codex",
    cwd: "/tmp/workspace",
    sandbox_mode: "workspace_write",
    approval_policy: "ask",
    continue_session: false,
    model_selection: { model: "gpt-5.3-codex" },
    workspace_preflight: {
      workspace_id: "workspace-1",
      expected_branch: "main",
      allow_dirty_worktree: true,
    },
    local_capability_lease: localLease(),
    mcp_servers: [proofBoundAttachment()],
  };

  const parsed = parseHcpMessage(createEnvelope("harness.session.start", payload));

  assert.equal(parsed.type, "harness.session.start");
  if (parsed.type === "harness.session.start") {
    assert.equal(parsed.payload.mcp_servers[0]?.proof_of_possession.scheme, "runner_signed_request");
    assert.equal(parsed.payload.local_capability_lease?.capabilities[1]?.id, "shell");
  }
});

test("rejects MCP attachments without proof-bound lease claims", () => {
  const result = hcpMessageSchema.safeParse(
    createEnvelope("harness.session.start", {
      session_id: "session-1",
      workspace_id: "workspace-1",
      provider_instance_id: "provider-1",
      driver_kind: "codex",
      cwd: "/tmp/workspace",
      sandbox_mode: "workspace_write",
      approval_policy: "ask",
      continue_session: false,
      model_selection: { model: "gpt-5.3-codex" },
      mcp_servers: [
        {
          name: "bad",
          transport: "streamable_http",
          url: "https://example.com/mcp",
          headers: { Authorization: "Bearer token" },
          lease_id: "mcp_lease_123",
        },
      ],
    }),
  );

  assert.equal(result.success, false);
});

test("rejects backend-supplied stdio MCP attachments and executable config fields", () => {
  const result = hcpMessageSchema.safeParse(
    createEnvelope("harness.session.start", {
      session_id: "session-1",
      workspace_id: "workspace-1",
      provider_instance_id: "provider-1",
      driver_kind: "codex",
      cwd: "/tmp/workspace",
      sandbox_mode: "workspace_write",
      approval_policy: "ask",
      continue_session: false,
      model_selection: { model: "gpt-5.3-codex" },
      executable_path: "/usr/bin/codex",
      mcp_servers: [
        {
          name: "bad",
          transport: "stdio",
          command: "node",
          args: ["server.js"],
        },
      ],
    }),
  );

  assert.equal(result.success, false);
});

test("parses command ack and nack messages with duplicate state", () => {
  const ack = parseHcpMessage(
    createEnvelope("hcp.command.ack", {
      command_id: "command-1",
      accepted_at: sentAt,
      duplicate: true,
    }),
  );
  const nack = parseHcpMessage(
    createEnvelope("hcp.command.nack", {
      command_id: "command-2",
      rejected_at: sentAt,
      error: {
        code: "duplicate_command_payload_mismatch",
        message: "Command id was reused with a different payload.",
        retryable: false,
      },
    }),
  );

  assert.equal(ack.type, "hcp.command.ack");
  assert.equal(nack.type, "hcp.command.nack");
});

test("accepts provider and extension event payloads through the extension schema", () => {
  const providerEvent = parseHcpMessage(
    createEnvelope("harness.event", {
      session_id: "session-1",
      sequence: 1,
      event_type: "provider.codex.native_event",
      created_at: sentAt,
      data: {
        summary: "Native event",
        fields: { provider_event_id: "evt_123" },
      },
    }),
  );
  const extensionEvent = parseHcpMessage(
    createEnvelope("harness.event", {
      session_id: "session-1",
      sequence: 2,
      event_type: "extension.example.timeline",
      created_at: sentAt,
      data: {
        summary: "Extension timeline event",
      },
    }),
  );

  assert.equal(providerEvent.type, "harness.event");
  assert.equal(extensionEvent.type, "harness.event");
});

test("requires final output on terminal turn events", () => {
  const result = hcpMessageSchema.safeParse(
    createEnvelope("harness.event", {
      session_id: "session-1",
      turn_id: "turn-1",
      sequence: 1,
      event_type: "turn.completed",
      created_at: sentAt,
      data: {
        status: "accepted",
      },
    }),
  );

  assert.equal(result.success, false);
});

test("requires attribution for local capability action events", () => {
  const missingAttribution = hcpMessageSchema.safeParse(
    createEnvelope("harness.event", {
      session_id: "session-1",
      sequence: 1,
      event_type: "local_capability.action.started",
      created_at: sentAt,
      data: {},
    }),
  );
  const validAction = parseHcpMessage(
    createEnvelope("harness.event", {
      session_id: "session-1",
      turn_id: "turn-1",
      sequence: 1,
      event_type: "local_capability.action.started",
      created_at: sentAt,
      data: {
        lease_id: "local_lease_123",
        run_id: "run_123",
        workspace_id: "workspace-1",
        provider_instance_id: "provider-1",
        capability_id: "filesystem",
        action: "read_file",
        status: "started",
      },
    }),
  );

  assert.equal(missingAttribution.success, false);
  assert.equal(validAction.type, "harness.event");
});

test("rejects malformed local capability lease policy", () => {
  assert.throws(() =>
    parseLocalCapabilityLease(
      localLease({
        capabilities: [
          {
            id: "shell",
            scopes: ["workspace"],
            command_policy: {
              cwd_policy: "selected_workspace_only",
              env_policy: "minimal",
              allow_shell: false,
              timeout_seconds: 0,
              network_policy: "inherit",
            },
          },
        ],
      }),
    ),
  );
});
