import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ZodError } from "zod";

import {
  HCP_VERSION,
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
  last_event_sequence: 12,
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
          },
        ],
        workspaces: [{ id: "workspace-1", path: "/tmp/workspace" }],
      }).providers[0]?.provider_instance_id,
      "provider-1",
    );

    assert.equal(
      parseHcpSessionStartPayload({
        session_id: "session-1",
        provider_instance_id: "provider-1",
        driver_kind: "mock",
        cwd: "/tmp/workspace",
        runtime_mode: "approval_required",
        sandbox_mode: "workspace_write",
        approval_policy: "ask",
        continue_session: false,
        model_selection: { model: "model-a" },
        mcp_servers: [
          {
            name: "tools",
            transport: "streamable_http",
            url: "https://example.com/mcp",
            headers: { authorization: "Bearer redacted" },
            expires_at: sentAt,
            allowed_tools: ["read_status"],
          },
        ],
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

    assert.equal(
      parseMcpServerAttachment({
        name: "tools",
        transport: "streamable_http",
        url: "https://example.com/mcp",
      }).transport,
      "streamable_http",
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
  });
});
