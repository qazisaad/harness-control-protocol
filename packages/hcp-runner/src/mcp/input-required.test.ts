import assert from "node:assert/strict";
import { it } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { ManagedMcpSdkClient, McpInputRequiredError, mcpInputExpiresAt, mcpInputResponseParams, mcpPendingInputSchema, parseMcpPendingInput } from "./input-required.js";

const question = {method: "elicitation/create", params: {
  message: "Choose a name", requestedSchema: {type: "object", properties: {name: {type: "string"}}},
}};

it("concurrent SDK responses retain their own metadata even with identical input and state", async () => {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    let result: object;
    if (rpc.method === "server/discover") {
      result = {resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: {tools: {}}};
    } else if (rpc.method === "tools/list") {
      result = {resultType: "complete", tools: ["first", "second", "missing", "invalid"].map(name => ({name,
        inputSchema: {type: "object", properties: {}}}))};
    } else {
      assert.equal(rpc.method, "tools/call");
      const name: string = rpc.params.name;
      if (name === "first") await new Promise(resolve => setTimeout(resolve, 20));
      result = {resultType: "input_required", inputRequests: {question}, requestState: "same-state",
        ...(name === "missing" ? {} : {_meta: name === "invalid" ? "invalid" : {"example.org/operation": name}})};
    }
    response.writeHead(200, {"Content-Type": "application/json"}).end(JSON.stringify({jsonrpc: "2.0", id: rpc.id, result}));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = new ManagedMcpSdkClient({name: "metadata-test", version: "1"},
    {inputRequired: {autoFulfill: false}, versionNegotiation: {mode: "auto"}});
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)));
    await Promise.all(["first", "second", "missing"].map(async name => {
      await assert.rejects(client.callTool({name}), error => {
        assert.ok(error instanceof McpInputRequiredError);
        const persisted = mcpPendingInputSchema.parse(JSON.parse(JSON.stringify(error.pending)));
        assert.deepEqual(persisted._meta, name === "missing" ? undefined : {"example.org/operation": name});
        assert.equal(persisted.requestState, "same-state");
        return true;
      });
    }));
    await assert.rejects(client.callTool({name: "invalid"}), error => {
      assert.ok(error instanceof Error && !(error instanceof McpInputRequiredError));
      return true;
    });
  } finally {
    await client.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

it("input deadlines survive persistence and can only shorten caller authority", () => {
  const expiry = "2026-09-21T15:00:00.000Z";
  const pending = (hint: unknown) => parseMcpPendingInput({inputRequests: {question},
    _meta: {"com.prompt2agent/input-deadline": hint}});
  const earlier = "2026-09-21T14:00:00.000Z";
  assert.equal(mcpInputExpiresAt(JSON.parse(JSON.stringify(pending(earlier))), expiry), earlier);
  assert.equal(mcpInputExpiresAt(mcpPendingInputSchema.parse(JSON.parse(JSON.stringify(pending(earlier)))), expiry), earlier);
  assert.equal(mcpInputExpiresAt(pending("2026-09-21T16:00:00+00:00"), expiry), expiry);
  assert.equal(mcpInputExpiresAt(parseMcpPendingInput({inputRequests: {question}}), expiry), expiry);
  assert.throws(() => mcpInputExpiresAt(pending("tomorrow"), expiry));
  assert.throws(() => parseMcpPendingInput({requestState: "opaque", _meta: "invalid"}));
  assert.throws(() => parseMcpPendingInput({requestState: "opaque", _meta: {large: "x".repeat(1024 * 1024)}}), /persistence limit/);
});

for (const legacy of [false, true]) it(`URL elicitation replies never carry form values (legacy=${legacy})`, () => {
  const pending = parseMcpPendingInput({inputRequests: {question: {method: "elicitation/create",
    params: {mode: "url", message: "Authorize", url: "https://auth.example/consent", ...(legacy ? {elicitationId: "question"} : {})}}}});
  const persisted = mcpPendingInputSchema.parse(JSON.parse(JSON.stringify(pending)));
  assert.equal("elicitationId" in persisted.inputRequests!.question!.params!, legacy);
  for (const action of ["accept", "decline", "cancel"] as const) {
    assert.doesNotThrow(() => mcpInputResponseParams({pending, responses: {question: {action}}}));
    assert.throws(() => mcpInputResponseParams({pending, responses: {question: {action, content: {}}}}), /URL elicitation/);
  }
  for (const url of ["javascript:alert(1)", "file:///secret", "not a URL"]) {
    assert.throws(() => parseMcpPendingInput({inputRequests: {question: {method: "elicitation/create",
      params: {mode: "url", message: "Authorize", url, ...(legacy ? {elicitationId: "question"} : {})}}}}));
  }
});

it("retains opaque state and validates exact input IDs and response categories", () => {
  const pending = parseMcpPendingInput({requestState: "opaque", inputRequests: {question}});
  for (const action of ["accept", "decline", "cancel"] as const) {
    const responses = {question: {action, ...(action === "accept" ? {content: {name: "Ada"}} : {})}};
    assert.deepEqual(mcpInputResponseParams({pending, responses}), {requestState: "opaque", inputResponses: responses});
  }
  assert.throws(() => mcpInputResponseParams({pending, responses: {}}), /request IDs/);
  assert.throws(() => mcpInputResponseParams({pending, responses: {other: {action: "cancel"}}}), /request IDs/);
  assert.throws(() => mcpInputResponseParams({pending, responses: {question: {roots: []}}}), /request type/);
});

it("uses SDK request guards and bounds retained state", () => {
  assert.throws(() => parseMcpPendingInput({}), /no requests/);
  assert.throws(() => parseMcpPendingInput({inputRequests: {q: {method: "tools/call"}}}), /unsupported or invalid/);
  assert.throws(() => parseMcpPendingInput({inputRequests: {q: {method: "elicitation/create", params: {}}}}), /unsupported or invalid/);
  assert.throws(() => parseMcpPendingInput({requestState: "x".repeat(1024 * 1024)}), /persistence limit/);
  assert.deepEqual(mcpInputResponseParams({pending: parseMcpPendingInput({requestState: "opaque"}), responses: {}}),
    {requestState: "opaque", inputResponses: {}});
});

it("keeps arbitrary request IDs as own properties without mutable aliases", () => {
  const source = JSON.parse(JSON.stringify({inputRequests: {constructor: question}}));
  Object.defineProperty(source.inputRequests, "__proto__", {value: question, enumerable: true});
  const pending = parseMcpPendingInput(source);
  source.inputRequests.constructor.params.message = "changed";
  assert.deepEqual(Object.keys(pending.inputRequests!).sort(), ["__proto__", "constructor"]);
  assert.deepEqual(pending.inputRequests!.constructor, {...question, params: {...question.params, message: "Choose a name"}});
  const responses = Object.fromEntries(["__proto__", "constructor"].map(key => [key, {action: "cancel" as const}]));
  const params = mcpInputResponseParams({pending, responses});
  responses["__proto__"] = {action: "cancel"};
  assert.deepEqual(Object.keys(params.inputResponses).sort(), ["__proto__", "constructor"]);
});
