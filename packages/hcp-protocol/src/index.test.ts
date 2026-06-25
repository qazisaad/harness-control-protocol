import assert from "node:assert/strict";
import test from "node:test";

import {
  HCP_VERSION,
  parseHcpMessage,
  hcpMessageSchema,
  type HcpEnvelope,
  type HcpHostHelloPayload,
} from "./index.js";

function createEnvelope<TType extends string, TPayload>(
  type: TType,
  payload: TPayload,
): HcpEnvelope<TType, TPayload> {
  return {
    id: `message-${type}`,
    type,
    version: HCP_VERSION,
    sent_at: new Date().toISOString(),
    payload,
  };
}

test("parses valid host hello envelopes", () => {
  const payload: HcpHostHelloPayload = {
    runner_id: "runner-local",
    host_id: "host-local",
    runner_version: "0.0.0",
    supported_protocol_versions: [HCP_VERSION],
    capabilities: ["providers", "mcp"],
  };

  const envelope = createEnvelope("host.hello", payload);
  const parsed = parseHcpMessage(envelope);

  assert.equal(parsed.type, "host.hello");
  if (parsed.type === "host.hello") {
    assert.equal(parsed.payload.runner_id, "runner-local");
  }
});

test("rejects unknown envelope types", () => {
  const result = hcpMessageSchema.safeParse({
    id: "message-1",
    type: "unknown.message",
    version: HCP_VERSION,
    sent_at: new Date().toISOString(),
    payload: {},
  });

  assert.equal(result.success, false);
});

test("rejects malformed MCP attachments", () => {
  const envelope = createEnvelope("session.start", {
    session_id: "session-1",
    provider_instance_id: "provider-1",
    driver_kind: "mock",
    cwd: "/tmp/project",
    runtime_mode: "approval_required",
    sandbox_mode: "workspace_write",
    approval_policy: "ask",
    continue_session: false,
    model_selection: { model: "mock-model" },
    mcp_servers: [
      {
        name: "bad",
        transport: "stdio",
        url: "not-a-url",
      },
    ],
  });

  const result = hcpMessageSchema.safeParse(envelope);

  assert.equal(result.success, false);
});
