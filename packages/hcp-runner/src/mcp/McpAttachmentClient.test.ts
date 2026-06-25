import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerAttachment } from "@hcp-runner/protocol";

import {
  McpAttachmentClient,
  McpAttachmentExpiredError,
  McpProofBindingError,
  McpToolPolicyError,
  type McpAttachmentEvent,
  type McpToolDescriptor,
} from "./McpAttachmentClient.js";
import { redactHeaders, redactValue } from "./redaction.js";

const tools: Tool[] = [
  { name: "read_file", inputSchema: { type: "object" } },
  { name: "write_file", inputSchema: { type: "object" } },
  { name: "shell", inputSchema: { type: "object" } },
];

describe("McpAttachmentClient", () => {
  it("filters discovered tools through allowed and denied policy", async () => {
    const client: McpAttachmentClient = createTestClient({
      allowed_tools: ["read_file", "write_file"],
      denied_tools: ["write_file"],
    });

    await client.connect();
    const visibleTools: McpToolDescriptor[] = await client.listTools();

    assert.deepEqual(
      visibleTools.map((tool: McpToolDescriptor): string => tool.name),
      ["read_file"],
    );
  });

  it("blocks denied tool calls before they reach the SDK client", async () => {
    const calls: string[] = [];
    const client: McpAttachmentClient = createTestClient(
      {
        allowed_tools: ["read_file", "shell"],
        denied_tools: ["shell"],
      },
      calls,
    );

    await client.connect();

    await assert.rejects((): Promise<unknown> => client.callTool("shell", { command: "date" }), McpToolPolicyError);
    assert.deepEqual(calls, []);
  });

  it("emits redacted headers, arguments, results, and errors", async () => {
    const events: McpAttachmentEvent[] = [];
    const client: McpAttachmentClient = createTestClient(
      {
        headers: {
          Authorization: "Bearer secret-token",
          "X-Request-Id": "request-123",
        },
      },
      [],
      events,
    );

    await client.connect();
    await client.callTool("read_file", {
      path: "/tmp/example.txt",
      access_token: "tool-token",
      nested: {
        password: "secret-password",
        query: "api_key=abc123",
      },
    });

    assert.deepEqual(events[0]?.data["headers"], {
      Authorization: "[redacted]",
      "X-Request-Id": "request-123",
    });
    assert.deepEqual(events[2]?.data["arguments"], {
      path: "/tmp/example.txt",
      access_token: "[redacted]",
      nested: {
        password: "[redacted]",
        query: "api_key=[redacted]",
      },
    });
    assert.deepEqual(events[3]?.data["result"], {
      content: [{ type: "text", text: "Bearer [redacted]" }],
      is_error: false,
    });
  });

  it("rejects expired attachments before connecting or calling tools", async () => {
    const client: McpAttachmentClient = createTestClient({
      expires_at: "2026-01-01T00:00:00.000Z",
    });

    await assert.rejects((): Promise<void> => client.connect(), McpAttachmentExpiredError);

    const now = new Date("2026-05-24T12:00:00.000Z");
    const connectedClient: McpAttachmentClient = createTestClient(
      {
        expires_at: "2026-05-24T12:00:01.000Z",
      },
      [],
      [],
      () => now,
    );
    await connectedClient.connect();
    now.setSeconds(now.getSeconds() + 2);
    await assert.rejects((): Promise<unknown> => connectedClient.callTool("read_file"), McpAttachmentExpiredError);
  });

  it("requires proof context before connecting platform attachments", async () => {
    const attachment: McpServerAttachment = makeAttachment({});
    const client = new McpAttachmentClient(attachment, {
      proofSigner: () => "test-signature",
      sdkFactory: createNoopSdkFactory(),
    });

    await assert.rejects((): Promise<void> => client.connect(), McpProofBindingError);
  });

  it("requires a proof signer before connecting platform attachments", async () => {
    const client = new McpAttachmentClient(makeAttachment({}), {
      proofContext: proofContext(),
      sdkFactory: createNoopSdkFactory(),
    });

    await assert.rejects((): Promise<void> => client.connect(), McpProofBindingError);
  });

  it("adds proof headers to streamable HTTP requests", async () => {
    let proofFetch: ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => ReturnType<typeof fetch>) | undefined;
    const client = new McpAttachmentClient(makeAttachment({}), {
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      proofContext: proofContext(),
      proofSigner: () => "test-signature",
      sdkFactory: {
        createClient() {
          return {
            async connect(): Promise<void> {},
            async listTools(): Promise<{ tools: Tool[] }> {
              return { tools: [] };
            },
            async callTool(): Promise<{ content: [] }> {
              return { content: [] };
            },
            async close(): Promise<void> {},
          };
        },
        createStreamableHttpTransport(_attachment, options): unknown {
          proofFetch = options.fetch;
          return {};
        },
      },
    });
    const originalFetch = globalThis.fetch;
    const requests: Headers[] = [];
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      requests.push(new Headers(init?.headers));
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    try {
      await client.connect();
      assert.ok(proofFetch);
      await proofFetch("https://example.com/mcp", { method: "POST", body: "{}" });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const headers = requests[0];
    assert.equal(headers?.get("x-hcp-session-id"), "session-1");
    assert.equal(headers?.get("x-hcp-host-id"), "host-1");
    assert.equal(headers?.get("x-hcp-proof-signature"), "test-signature");
    assert.equal(headers?.get("x-hcp-lease-id"), "mcp_lease_test");
  });
});

describe("MCP redaction helpers", () => {
  it("redacts sensitive header names and token-like string assignments", () => {
    const headers: Record<string, string> | undefined = redactHeaders({
      cookie: "session=secret",
      "x-trace-id": "trace token=abc123",
    });

    assert.deepEqual(headers, {
      cookie: "[redacted]",
      "x-trace-id": "trace token=[redacted]",
    });
  });

  it("redacts nested sensitive keys without changing non-sensitive values", () => {
    const value: unknown = redactValue({
      bearer: "Bearer abc123",
      safe: ["plain", { secret_key: "hidden" }],
    });

    assert.deepEqual(value, {
      bearer: "Bearer [redacted]",
      safe: ["plain", { secret_key: "[redacted]" }],
    });
  });
});

function createTestClient(
  attachmentOverrides: Partial<McpServerAttachment>,
  calls: string[] = [],
  events: McpAttachmentEvent[] = [],
  now?: () => Date,
): McpAttachmentClient {
  const attachment: McpServerAttachment = makeAttachment(attachmentOverrides);

  return new McpAttachmentClient(attachment, {
    proofContext: proofContext(),
    proofSigner: () => "test-signature",
    ...(now ? { now } : {}),
    eventSink(event: McpAttachmentEvent): void {
      events.push(event);
    },
    sdkFactory: {
      ...createNoopSdkFactory(),
      createClient() {
        return {
          async connect(): Promise<void> {},
          async listTools(): Promise<{ tools: Tool[] }> {
            return { tools };
          },
          async callTool(params: { name: string }): Promise<{ content: Array<{ type: "text"; text: string }> }> {
            calls.push(params.name);
            return { content: [{ type: "text", text: "Bearer result-token" }] };
          },
          async close(): Promise<void> {},
        };
      },
    },
  });
}

function makeAttachment(attachmentOverrides: Partial<McpServerAttachment>): McpServerAttachment {
  const baseAttachment: McpServerAttachment = {
    name: "local-test-mcp",
    transport: "streamable_http",
    url: "http://127.0.0.1:9999/mcp",
    headers: { Authorization: "Bearer test-lease-token" },
    lease_id: "mcp_lease_test",
    proof_of_possession: {
      scheme: "runner_signed_request",
      key_id: "proof_key_test",
      required_headers: ["x-hcp-proof-signature", "x-hcp-proof-nonce"],
    },
  };

  return {
    ...baseAttachment,
    ...attachmentOverrides,
  };
}

function proofContext() {
  return {
    session_id: "session-1",
    host_id: "host-1",
    provider_instance_id: "provider-1",
    workspace_id: "workspace-1",
    server_id: "local-test-mcp",
  };
}

function createNoopSdkFactory() {
  return {
    createClient() {
      return {
        async connect(): Promise<void> {},
        async listTools(): Promise<{ tools: Tool[] }> {
          return { tools: [] };
        },
        async callTool(): Promise<{ content: [] }> {
          return { content: [] };
        },
        async close(): Promise<void> {},
      };
    },
    createStreamableHttpTransport(): unknown {
      return {};
    },
  };
}
