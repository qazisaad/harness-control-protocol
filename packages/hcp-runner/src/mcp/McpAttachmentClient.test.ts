import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import { type Tool } from "@modelcontextprotocol/client";
import { McpInputRequiredError, type McpInputReply } from "./input-required.js";
import type { StreamableHttpMcpServerAttachment } from "@harness-control/protocol";

import {
  McpAttachmentClient,
  McpAttachmentExpiredError,
  McpProofBindingError,
  McpToolPolicyError,
  toMcpToolDescriptor,
  toMcpToolCallResult,
  mcpToolCallResultSchema,
  MCP_REVIEW_META_KEY,
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
  it("preserves JSON structured results at the client and persistence boundaries", () => {
    for (const value of [null, false, 0, "", [1, "two"], {ok: true}]) {
      const converted = toMcpToolCallResult({content: [], structuredContent: value});
      assert.deepEqual(converted.structured_content, value);
      assert.deepEqual(mcpToolCallResultSchema.parse(JSON.parse(JSON.stringify(converted))), converted);
    }
    assert.equal("structured_content" in toMcpToolCallResult({content: []}), false);
  });

  it("sends the exact review grant through the real SDK in the signed HTTP body", async () => {
    const received: {body: string; hash: string | string[] | undefined}[] = [];
    const server = createServer(async (request, response) => {
      if (request.method !== "POST") {response.writeHead(405).end(); return;}
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString("utf8");
      const rpc = JSON.parse(body);
      received.push({body, hash: request.headers["x-hcp-proof-body-sha256"]});
      if (rpc.id === undefined) {response.writeHead(202).end(); return;}
      const result = rpc.method === "initialize"
        ? {protocolVersion: "2025-06-18", capabilities: {tools: {}}, serverInfo: {name: "fixture", version: "1"}}
        : rpc.method === "tools/list" ? {tools}
        : {content: [{type: "text", text: "done"}], isError: false};
      response.writeHead(200, {"Content-Type": "application/json"}).end(JSON.stringify({jsonrpc: "2.0", id: rpc.id, result}));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const events: McpAttachmentEvent[] = [];
    const client = new McpAttachmentClient(makeAttachment({url: `http://127.0.0.1:${address.port}/mcp`}), {
      proofContext: proofContext(), proofSigner: () => "fixture-signature", eventSink: event => {events.push(event);},
    });
    const args = {query: "e\u0301", include: false};
    const grant = {request_id: "review-1", action_json: JSON.stringify({kind: "mcp_tool", attachment_name: "selected", tool_name: "read_file", arguments: args})};
    try {
      await client.connect();
      await client.callTool("read_file", args, grant);
      const call = received.find(item => JSON.parse(item.body).method === "tools/call");
      assert.ok(call);
      assert.deepEqual(JSON.parse(call.body).params, {name: "read_file", arguments: args, _meta: {[MCP_REVIEW_META_KEY]: grant}});
      assert.equal(call.hash, `sha256:${createHash("sha256").update(call.body).digest("base64url")}`);
      assert.equal(JSON.stringify(events).includes("action_json"), false);
      assert.equal(received.filter(item => JSON.parse(item.body).method === "tools/call").length, 1);
    } finally {
      await client.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it("preserves explicit review hints and validates their closed contract", () => {
    const tool: Tool = {name: "call_tool", inputSchema: {type: "object"}};
    assert.equal(toMcpToolDescriptor(tool).review_policy, undefined);
    for (const policy of [{kind: "always"}, {kind: "argument", argument: "name", values: ["write_file"]}]) {
      assert.deepEqual(toMcpToolDescriptor({...tool, _meta: {[MCP_REVIEW_META_KEY]: policy}}).review_policy, policy);
    }
    for (const policy of [true, {kind: "never"}, {kind: "argument", argument: "name", values: []}, {kind: "always", approved: true}]) {
      assert.throws(() => toMcpToolDescriptor({...tool, _meta: {[MCP_REVIEW_META_KEY]: policy}}));
    }
  });

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
    const attachment: StreamableHttpMcpServerAttachment = makeAttachment({});
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
  attachmentOverrides: Partial<StreamableHttpMcpServerAttachment>,
  calls: string[] = [],
  events: McpAttachmentEvent[] = [],
  now?: () => Date,
): McpAttachmentClient {
  const attachment: StreamableHttpMcpServerAttachment = makeAttachment(attachmentOverrides);

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

function makeAttachment(
  attachmentOverrides: Partial<StreamableHttpMcpServerAttachment>,
): StreamableHttpMcpServerAttachment {
  const baseAttachment: StreamableHttpMcpServerAttachment = {
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


for (const inputRequired of [false, true]) for (const ttlMs of [0, 60000]) {
  it(`uses the stateless protocol without automatic tool replay (inputRequired=${inputRequired}, ttlMs=${ttlMs})`, async () => {
    const methods: string[] = [];
    const events: McpAttachmentEvent[] = [];
    let invalidOutput = false;
    let removed = false;
    const server = createServer(async (request, response) => {
      if (request.method !== "POST") {response.writeHead(405).end(); return;}
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      methods.push(rpc.method);
      let result: object;
      if (rpc.method === "server/discover") {
        result = {resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: {tools: {}},
          ttlMs: 0, cacheScope: "private"};
      } else if (rpc.method === "tools/list") {
        result = {resultType: "complete", tools: (removed ? [] : tools).map(tool => ({...tool,
          outputSchema: {type: "object", properties: {done: {type: "boolean"}}, required: ["done"]},
        })), ttlMs, cacheScope: "private"};
      } else if (rpc.method === "tools/call") {
        assert.equal(rpc.params._meta["io.modelcontextprotocol/protocolVersion"], "2026-07-28");
        if (rpc.params.requestState !== undefined) {
          assert.equal(rpc.params.requestState, "opaque-pending");
          assert.deepEqual(rpc.params.inputResponses, {});
        }
        result = inputRequired && !invalidOutput && rpc.params.requestState === undefined ? {resultType: "input_required", requestState: "opaque-pending"}
          : {resultType: "complete", content: [{type: "text", text: "done"}], structuredContent: {done: invalidOutput ? "wrong type" : true}};
      } else {
        assert.fail(`Unexpected stateful method: ${rpc.method}`);
      }
      response.writeHead(200, {"Content-Type": "application/json"}).end(JSON.stringify({jsonrpc: "2.0", id: rpc.id, result}));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const client = new McpAttachmentClient(makeAttachment({url: `http://127.0.0.1:${address.port}/mcp`}), {
      proofContext: proofContext(), proofSigner: () => "fixture-signature", eventSink: event => {events.push(event);},
    });
    try {
      await client.connect();

      if (inputRequired) {
        let reply: McpInputReply | undefined;
        await assert.rejects(client.callTool("read_file", {}), error => {
          assert.ok(error instanceof McpInputRequiredError);
          reply = {pending: error.pending, responses: {}};
          return true;
        });
        assert.equal(events.filter(event => event.event_type === "mcp_tool.completed").length, 0);
        assert.equal(methods.filter(method => method === "tools/call").length, 1);
        assert.ok(reply);
        await assert.rejects(client.callTool("read_file", {}, undefined, {
          ...reply, responses: {unexpected: {action: "cancel"}},
        }), /match the pending input request IDs/);
        assert.equal(methods.filter(method => method === "tools/call").length, 1);
        assert.equal(JSON.stringify(events).includes("opaque-pending"), false);
        assert.deepEqual(await client.callTool("read_file", {}, undefined, reply),
          {is_error: false, content: [{type: "text", text: "done"}], structured_content: {done: true}});
      } else {
        assert.deepEqual(await client.callTool("read_file", {}), {is_error: false, content: [{type: "text", text: "done"}], structured_content: {done: true}});
      }
      assert.equal(methods.filter(method => method === "tools/call").length, inputRequired ? 2 : 1);
      assert.equal(methods.includes("initialize"), false);
      invalidOutput = true;
      await assert.rejects(client.callTool("read_file", {}), /output|schema|validation/i);
      assert.equal(events.filter(event => event.event_type === "mcp_tool.completed").length, 1);
      if (ttlMs === 0) {
        removed = true;
        const dispatched = methods.filter(method => method === "tools/call").length;
        await assert.rejects(client.callTool("read_file", {}), /no longer advertised/);
        assert.equal(methods.filter(method => method === "tools/call").length, dispatched);
      }
    } finally {
      await client.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
}
