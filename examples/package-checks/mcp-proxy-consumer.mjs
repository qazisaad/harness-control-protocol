import assert from "node:assert/strict";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {ElicitRequestSchema} from "@modelcontextprotocol/sdk/types.js";
import {McpProxyServer, McpInputRequiredError, parseMcpPendingInput} from "@harness-control/runner/mcp";

let requests = 0, answered = 0;
const proxy = new McpProxyServer({attachment: {name: "consumer"}, upstream: {
  async connect() {}, async close() {},
  async listTools() {return [{name: "ask", input_schema: {type: "object"}}];},
  async callTool(name, args, _grant, continuation) {
    assert.equal(name, "ask"); assert.deepEqual(args, {owned: true}); requests++;
    if (!continuation) throw new McpInputRequiredError(parseMcpPendingInput({requestState: "private-upstream-state",
      inputRequests: {question: {method: "elicitation/create", params: {message: "Choose", requestedSchema: {type: "object",
        properties: {answer: {type: "string"}}, required: ["answer"]}}}}}));
    assert.equal(continuation.pending.requestState, "private-upstream-state");
    assert.deepEqual(continuation.responses, {question: {action: "accept", content: {answer: "chosen"}}}); answered++;
    return {is_error: false, content: [{type: "text", text: "chosen"}]};
  },
}});
const client = new Client({name: "public-consumer", version: "1"}, {capabilities: {elicitation: {form: {}}}});
client.setRequestHandler(ElicitRequestSchema, async () => ({action: "accept", content: {answer: "chosen"}}));
try {
  await proxy.connect();
  await client.connect(new StreamableHTTPClientTransport(new URL(proxy.adapterAttachment.url)));
  assert.deepEqual((await client.callTool({name: "ask", arguments: {owned: true}})).content, [{type: "text", text: "chosen"}]);
  assert.equal(requests, 2); assert.equal(answered, 1);
} finally {await client.close(); await proxy.close();}
console.log("Packed public MCP proxy: native form, verified one-use continuation and owned closure passed.");
