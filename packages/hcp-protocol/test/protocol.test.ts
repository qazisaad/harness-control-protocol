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
  parseMcpServerAttachment,
  type HcpEnvelope,
  type HcpHostHelloPayload,
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
  resume: {
    sessions: [{ session_id: "session-1", last_event_sequence: 12 }],
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
