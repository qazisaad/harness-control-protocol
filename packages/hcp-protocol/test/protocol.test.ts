import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ZodError } from "zod";

import {
  HCP_VERSION,
  KNOWN_HCP_EVENT_TYPES,
  knownHcpEventDataSchemas,
  parseHcpEnvelope,
  parseHcpHostAcceptedPayload,
  parseHcpHostCapabilitiesUpdatedPayload,
  parseHcpHostHelloPayload,
  parseHcpHarnessEventPayload,
  parseHcpMessage,
  parseHcpSessionStartPayload,
  parseHcpTurnSendPayload,
  parseLocalActionErrorPayload,
  parseLocalActionRequestPayload,
  parseLocalActionResponsePayload,
  parseMcpServerAttachment,
  type HcpEnvelope,
  type HcpHostHelloPayload,
  type LocalActionRequestPayload,
  type LocalActionResponsePayload,
  type LocalCapabilityLease,
  type McpServerAttachment,
} from "../src/index.js";

const sentAt = "2026-01-01T00:00:00.000Z";

function envelope<TType extends string, TPayload>(
  type: TType,
  payload: TPayload,
): HcpEnvelope<TType, TPayload> {
  return {
    id: `msg-${type}`,
    type,
    version: HCP_VERSION,
    sent_at: sentAt,
    payload,
  };
}

function assertRejected(input: unknown, parse: (value: unknown) => unknown): void {
  assert.throws(() => parse(input), ZodError);
}

const helloPayload: HcpHostHelloPayload = {
  runner_id: "runner-local",
  host_id: "host-local",
  runner_version: "0.0.0",
  supported_protocol_versions: [HCP_VERSION],
  capabilities: ["sessions", "mcp.attachments"],
  retained_events: {
    sessions: [{ session_id: "session-1", first_event_sequence: 1, last_event_sequence: 12 }],
  },
};

const leasePayload: LocalCapabilityLease = {
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
  ],
};

const attachmentPayload: McpServerAttachment = {
  name: "tools",
  transport: "streamable_http",
  url: "https://example.com/mcp",
  headers: { Authorization: "Bearer lease-token" },
  lease_id: "mcp_lease_123",
  proof_of_possession: {
    scheme: "runner_signed_request",
    key_id: "proof_key_123",
    required_headers: ["x-hcp-session-id", "x-hcp-proof-signature"],
  },
  allowed_tools: ["read_status"],
};

const localActionRequestPayload: LocalActionRequestPayload = {
  request_id: "local-action-1",
  action: "local.filesystem.read",
  issued_at: sentAt,
  attribution: {
    session_id: "session-1",
    turn_id: "turn-1",
    workspace_id: "workspace-1",
    provider_instance_id: "provider-1",
    run_id: "run_123",
  },
  lease: {
    lease_id: "local_lease_123",
    capability_id: "filesystem",
    scope: "workspace_read",
    run_id: "run_123",
    hcp_session_id: "session-1",
    execution_host_id: "host-local",
    provider_instance_id: "provider-1",
    workspace_id: "workspace-1",
    expires_at: "2026-01-01T01:00:00.000Z",
  },
  sandbox: {
    mode: "workspace_write",
    workspace_root: "/tmp/workspace",
    cwd: "/tmp/workspace",
    requires_workspace_containment: true,
  },
  approval: { status: "not_required" },
  output_limits: { content_bytes: 65_536 },
  cancellation: { cancellable: false },
  audit: {
    started_event_type: "local_capability.action.started",
    completed_event_type: "local_capability.action.completed",
    failed_event_type: "local_capability.action.failed",
  },
  input: {
    path: "README.md",
    encoding: "utf8",
  },
};

const localActionResponsePayload: LocalActionResponsePayload = {
  request_id: "local-action-1",
  action: "local.filesystem.read",
  status: "completed",
  completed_at: sentAt,
  attribution: localActionRequestPayload.attribution,
  lease: localActionRequestPayload.lease,
  output: {
    path: "README.md",
    content: "hello",
    encoding: "utf8",
    hash: "sha256:abc",
  },
  audit_events: {
    started: { event_type: "local_capability.action.started", sequence: 1 },
    completed: { event_type: "local_capability.action.completed", sequence: 2 },
  },
};

describe("HCP protocol runtime parsing", () => {
  it("parses a generic envelope without trusting the payload shape", () => {
    const parsed = parseHcpEnvelope(envelope("future.message", { arbitrary: true }));

    assert.equal(parsed.type, "future.message");
    assert.deepEqual(parsed.payload, { arbitrary: true });
  });

  it("parses valid known messages", () => {
    const parsed = parseHcpMessage(envelope("host.hello", helloPayload));

    assert.equal(parsed.type, "host.hello");
    assert.equal(parsed.payload.runner_id, "runner-local");
  });

  it("rejects envelopes with unsupported protocol versions", () => {
    assertRejected(
      {
        ...envelope("host.hello", helloPayload),
        version: "hcp.v9",
      },
      parseHcpEnvelope,
    );
  });

  it("rejects unknown known-message types", () => {
    assertRejected(envelope("future.message", { arbitrary: true }), parseHcpMessage);
  });

  it("rejects invalid payload fields for a known message", () => {
    assertRejected(
      envelope("host.accepted", {
        protocol_version: HCP_VERSION,
        heartbeat_interval_seconds: 0,
      }),
      parseHcpMessage,
    );
  });

  it("rejects extra fields in external messages", () => {
    assertRejected(
      {
        ...envelope("host.hello", helloPayload),
        unexpected: true,
      },
      parseHcpMessage,
    );
  });

  it("parses important standalone payloads", () => {
    assert.equal(parseHcpHostHelloPayload(helloPayload).runner_id, "runner-local");
    assert.equal(
      parseHcpHostAcceptedPayload({
        protocol_version: HCP_VERSION,
        heartbeat_interval_seconds: 30,
      }).heartbeat_interval_seconds,
      30,
    );

    assert.deepEqual(
      parseHcpHostCapabilitiesUpdatedPayload({
        providers: [
          {
            provider_instance_id: "provider-1",
            driver_kind: "mock",
            enabled: true,
            installed: true,
            status: "ready",
            availability: "available",
            checked_at: sentAt,
            models: [
              {
                id: "model-a",
                label: "Model A",
                capabilities: { option_descriptors: [] },
              },
            ],
            local_capabilities: ["filesystem"],
          },
        ],
        local_capabilities: [
          {
            id: "filesystem",
            status: "available",
            scopes: ["workspace_read", "workspace_write"],
            approval_required: false,
          },
        ],
        workspaces: [{ id: "workspace-1", path: "/tmp/workspace" }],
      }).providers[0]?.provider_instance_id,
      "provider-1",
    );

    assert.equal(
      parseHcpSessionStartPayload({
        session_id: "session-1",
        workspace_id: "workspace-1",
        provider_instance_id: "provider-1",
        driver_kind: "mock",
        cwd: "/tmp/workspace",
        sandbox_mode: "workspace_write",
        approval_policy: "ask",
        continue_session: false,
        model_selection: { model: "model-a" },
        local_capability_lease: leasePayload,
        mcp_servers: [attachmentPayload],
      }).mcp_servers[0]?.name,
      "tools",
    );

    assert.equal(
      parseHcpTurnSendPayload({
        session_id: "session-1",
        turn_id: "turn-1",
        input: "Implement the task.",
      }).turn_id,
      "turn-1",
    );

    assert.equal(
      parseHcpHarnessEventPayload({
        session_id: "session-1",
        sequence: 1,
        event_type: "turn.started",
        created_at: sentAt,
        data: { turn_id: "turn-1" },
      }).event_type,
      "turn.started",
    );

    assert.equal(parseMcpServerAttachment(attachmentPayload).transport, "streamable_http");
    assert.equal(parseLocalActionRequestPayload(localActionRequestPayload).action, "local.filesystem.read");
    assert.equal(parseLocalActionResponsePayload(localActionResponsePayload).status, "completed");
    assert.equal(
      parseLocalActionErrorPayload({
        request_id: "local-action-2",
        action: "local.git.diff",
        status: "failed",
        failed_at: sentAt,
        attribution: {
          session_id: "session-1",
          turn_id: "turn-1",
          workspace_id: "workspace-1",
          provider_instance_id: "provider-1",
          run_id: "run_123",
        },
        lease: {
          lease_id: "local_lease_456",
          capability_id: "git",
          scope: "workspace_read",
          run_id: "run_123",
          hcp_session_id: "session-1",
          execution_host_id: "host-local",
          provider_instance_id: "provider-1",
          workspace_id: "workspace-1",
        },
        error: {
          code: "local_capability_expected_hash_mismatch",
          message: "The expected base hash did not match.",
          retryable: false,
        },
        audit_events: { failed: { event_type: "local_capability.action.failed", sequence: 3 } },
      }).error.code,
      "local_capability_expected_hash_mismatch",
    );
    assert.equal(
      parseLocalActionErrorPayload({
        request_id: "local-action-3",
        action: "local.filesystem.read",
        status: "failed",
        failed_at: sentAt,
        attribution: localActionRequestPayload.attribution,
        error: {
          code: "local_capability_lease_missing",
          message: "Local capability lease is missing.",
          retryable: false,
        },
        audit_events: { failed: { event_type: "local_capability.action.failed", sequence: 4 } },
      }).error.code,
      "local_capability_lease_missing",
    );
  });

  it("validates local action lease binding, approvals, and output limits", () => {
    assertRejected(
      {
        ...localActionRequestPayload,
        lease: {
          ...localActionRequestPayload.lease,
          hcp_session_id: "other-session",
        },
      },
      parseLocalActionRequestPayload,
    );

    assertRejected(
      {
        ...localActionRequestPayload,
        output_limits: {},
      },
      parseLocalActionRequestPayload,
    );

    assertRejected(
      {
        ...localActionRequestPayload,
        action: "local.shell.exec",
        lease: {
          ...localActionRequestPayload.lease,
          capability_id: "shell",
          scope: "workspace",
        },
        input: {
          executable: "npm",
          argv: ["test"],
          cwd: "/tmp/workspace",
          use_shell: false,
        },
        output_limits: { stdout_bytes: 65_536, stderr_bytes: 65_536 },
        approval: { status: "not_required" },
      },
      parseLocalActionRequestPayload,
    );
  });

  it("exports one runtime schema per known event type", () => {
    assert.equal(Object.keys(knownHcpEventDataSchemas).length, KNOWN_HCP_EVENT_TYPES.length);
    assert.ok(knownHcpEventDataSchemas["workspace.preflight.completed"]);
    assert.ok(knownHcpEventDataSchemas["local_capability.action.failed"]);
  });

  it("requires terminal turn final outputs and local action attribution", () => {
    assertRejected(
      {
        session_id: "session-1",
        turn_id: "turn-1",
        sequence: 1,
        event_type: "turn.completed",
        created_at: sentAt,
        data: { status: "accepted" },
      },
      parseHcpHarnessEventPayload,
    );

    assertRejected(
      {
        session_id: "session-1",
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
      },
      parseHcpHarnessEventPayload,
    );
  });

  it("accepts provider and extension events but rejects arbitrary event families", () => {
    assert.equal(
      parseHcpHarnessEventPayload({
        session_id: "session-1",
        sequence: 1,
        event_type: "provider.codex.raw",
        created_at: sentAt,
        data: { summary: "Provider event", fields: { native_id: "evt_1" } },
      }).event_type,
      "provider.codex.raw",
    );

    assertRejected(
      {
        session_id: "session-1",
        sequence: 1,
        event_type: "custom.raw",
        created_at: sentAt,
        data: {},
      },
      parseHcpHarnessEventPayload,
    );
  });

  it("rejects invalid MCP attachment policy inputs", () => {
    assertRejected(
      {
        name: "tools",
        transport: "stdio",
        url: "not-a-url",
      },
      parseMcpServerAttachment,
    );

    assertRejected(
      {
        name: "tools",
        transport: "streamable_http",
        url: "ftp://example.com/mcp",
        headers: { Authorization: "Bearer token" },
        lease_id: "lease_123",
        proof_of_possession: {
          scheme: "runner_signed_request",
          key_id: "proof_key_123",
          required_headers: ["x-hcp-proof-signature"],
        },
      },
      parseMcpServerAttachment,
    );

    assertRejected(
      {
        name: "tools",
        transport: "streamable_http",
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer token" },
        lease_id: "lease_123",
      },
      parseMcpServerAttachment,
    );
  });
});
