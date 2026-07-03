import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { describe, it } from "node:test";

import { McpAttachmentClient, createDevelopmentHmacProofSigner } from "@harness-control/runner/mcp";
import type { McpServerAttachment } from "@harness-control/protocol";

import { startSampleMcpServer, type SampleMcpLease } from "./index.js";

const secret = "sample-proof-secret";

function lease(overrides: Partial<SampleMcpLease> = {}): SampleMcpLease {
  return {
    lease_id: "mcp_lease_123",
    key_id: "proof_key_123",
    secret,
    session_id: "session-1",
    host_id: "host-1",
    provider_instance_id: "provider-1",
    workspace_id: "workspace-1",
    server_id: "sample",
    expires_at: "2999-01-01T00:00:00.000Z",
    allowed_tools: ["echo", "server_status"],
    ...overrides,
  };
}

function attachment(url: string, overrides: Partial<McpServerAttachment> = {}): McpServerAttachment {
  return {
    name: "sample",
    transport: "streamable_http",
    url,
    headers: {
      Authorization: "Bearer sample-token",
    },
    lease_id: "mcp_lease_123",
    proof_of_possession: {
      scheme: "runner_signed_request",
      key_id: "proof_key_123",
      required_headers: ["x-hcp-proof-signature", "x-hcp-proof-nonce"],
    },
    ...overrides,
  };
}

describe("sample MCP server proof verification", () => {
  it("accepts runner-signed MCP list and call requests", async () => {
    const server = await startSampleMcpServer({ port: 0, lease: lease() });
    const client = new McpAttachmentClient(attachment(server.url, { allowed_tools: ["echo"] }), {
      proofContext: {
        session_id: "session-1",
        host_id: "host-1",
        provider_instance_id: "provider-1",
        workspace_id: "workspace-1",
        server_id: "sample",
      },
      proofSigner: createDevelopmentHmacProofSigner(secret),
    });

    try {
      await client.connect();
      const tools = await client.listTools();
      assert.deepEqual(tools.map((tool) => tool.name), ["echo"]);
      const result = await client.callTool("echo", { text: "hello" });
      assert.equal(result.is_error, false);
      assert.deepEqual(result.structured_content, { text: "hello" });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("rejects server-side tool scope violations even when the client allows the call", async () => {
    const server = await startSampleMcpServer({ port: 0, lease: lease() });
    const client = new McpAttachmentClient(attachment(server.url), {
      proofContext: {
        session_id: "session-1",
        host_id: "host-1",
        provider_instance_id: "provider-1",
        workspace_id: "workspace-1",
        server_id: "sample",
      },
      proofSigner: createDevelopmentHmacProofSigner(secret),
    });

    try {
      await client.connect();
      await assert.rejects(() => client.callTool("secret_admin", {}));
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("rejects invalid signatures, nonce reuse, stale timestamps, and binding mismatches", async () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const server = await startSampleMcpServer({
      port: 0,
      now: () => now,
      timestampSkewMs: 60_000,
      lease: lease(),
    });
    const rawBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });

    try {
      const invalidSignature = await signedPost(server.url, rawBody, {
        timestamp: now.toISOString(),
        nonce: "nonce-invalid-signature",
        signatureSecret: "wrong-secret",
      });
      assert.equal(invalidSignature.status, 403);
      assert.match(await invalidSignature.text(), /proof_signature_invalid/);

      const stale = await signedPost(server.url, rawBody, {
        timestamp: "2025-12-31T23:00:00.000Z",
        nonce: "nonce-stale",
      });
      assert.equal(stale.status, 403);
      assert.match(await stale.text(), /proof_timestamp_stale/);

      const mismatch = await signedPost(server.url, rawBody, {
        timestamp: now.toISOString(),
        nonce: "nonce-mismatch",
        hostId: "other-host",
      });
      assert.equal(mismatch.status, 403);
      assert.match(await mismatch.text(), /proof_binding_mismatch/);

      const first = await signedPost(server.url, rawBody, {
        timestamp: now.toISOString(),
        nonce: "nonce-reuse",
      });
      assert.notEqual(first.status, 403);
      const replay = await signedPost(server.url, rawBody, {
        timestamp: now.toISOString(),
        nonce: "nonce-reuse",
      });
      assert.equal(replay.status, 403);
      assert.match(await replay.text(), /proof_nonce_reused/);
    } finally {
      await server.close();
    }
  });
});

async function signedPost(
  url: string,
  rawBody: string,
  overrides: {
    timestamp: string;
    nonce: string;
    signatureSecret?: string;
    hostId?: string;
  },
): Promise<Response> {
  const claims = {
    method: "POST",
    url,
    bodyHash: `sha256:${createHash("sha256").update(rawBody).digest("base64url")}`,
    leaseId: "mcp_lease_123",
    sessionId: "session-1",
    hostId: overrides.hostId ?? "host-1",
    providerInstanceId: "provider-1",
    workspaceId: "workspace-1",
    serverId: "sample",
    timestamp: overrides.timestamp,
    nonce: overrides.nonce,
  };
  const signature = `hmac-sha256:${createHmac("sha256", overrides.signatureSecret ?? secret)
    .update(
      [
        claims.method,
        claims.url,
        claims.bodyHash,
        claims.leaseId,
        claims.sessionId,
        claims.hostId,
        claims.providerInstanceId,
        claims.workspaceId,
        claims.serverId,
        "",
        claims.timestamp,
        claims.nonce,
      ].join("\n"),
    )
    .digest("base64url")}`;

  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hcp-proof-key-id": "proof_key_123",
      "x-hcp-lease-id": claims.leaseId,
      "x-hcp-session-id": claims.sessionId,
      "x-hcp-host-id": claims.hostId,
      "x-hcp-provider-instance-id": claims.providerInstanceId,
      "x-hcp-workspace-id": claims.workspaceId,
      "x-hcp-mcp-server-id": claims.serverId,
      "x-hcp-proof-timestamp": claims.timestamp,
      "x-hcp-proof-nonce": claims.nonce,
      "x-hcp-proof-body-sha256": claims.bodyHash,
      "x-hcp-proof-signature": signature,
    },
    body: rawBody,
  });
}
