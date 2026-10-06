import assert from "node:assert/strict";
import {createServer} from "node:http";
import {mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {Server} from "@modelcontextprotocol/sdk/server/index.js";
import {StreamableHTTPServerTransport} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest} from "@modelcontextprotocol/sdk/types.js";
import {HarnessSessionManager} from "@harness-control/runner/harnesses";
import {RunnerConfigSchema} from "@harness-control/runner/config";
import {JsonRunnerStateStore} from "@harness-control/runner/state";
import {McpProxyServer, McpInputRequiredError, parseMcpPendingInput} from "@harness-control/runner/mcp";

if (process.env.HCP_NATIVE_LIVE !== "1") throw new Error("Set HCP_NATIVE_LIVE=1 for authenticated native acceptance.");
const cwd = await mkdtemp(join(tmpdir(), "hcp-live-claude-elicitation-"));
const connections = new Map();
const servers = new Set();
const nativeReplies = [];
const marker = randomUUID();
const tool = {name: "ask_marker", description: "Ask a safe local acceptance question and return its answer.",
  inputSchema: {type: "object", properties: {scenario: {type: "string", enum: ["accept", "cancel", "lost"]}}, required: ["scenario"], additionalProperties: false}};
function createSession() {
  const server = new Server({name: "hcp-acceptance-elicitation", version: "1.0.0"}, {capabilities: {tools: {}}});
  server.setRequestHandler(ListToolsRequestSchema, async () => ({tools: [tool]}));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    assert.equal(request.params.name, "ask_marker");
    const scenario = request.params.arguments.scenario;
    const reply = await server.elicitInput({mode: "form", message: `Safe local acceptance question: ${scenario}`,
      requestedSchema: {type: "object", properties: {answer: {type: "string", minLength: 1, maxLength: 128}}, required: ["answer"]}});
    nativeReplies.push({scenario, action: reply.action});
    const value = reply.action === "accept" ? reply.content.answer : "cancelled";
    return {content: [{type: "text", text: value}], structuredContent: {answer: value}};
  });
  const transport = new StreamableHTTPServerTransport({sessionIdGenerator: () => randomUUID(), onsessioninitialized: id => {connections.set(id, transport);}});
  transport.onclose = () => {if (transport.sessionId) connections.delete(transport.sessionId);};
  servers.add(server);
  return {server, transport};
}
const http = createServer(async (request, response) => {
  try {
    if (request.url !== "/mcp") {response.writeHead(404).end(); return;}
    let body;
    if (request.method === "POST") {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString());
    }
    const id = request.headers["mcp-session-id"];
    let transport = typeof id === "string" ? connections.get(id) : undefined;
    if (!transport && request.method === "POST" && isInitializeRequest(body)) {
      const created = createSession(); transport = created.transport; await created.server.connect(transport);
    }
    if (!transport) {response.writeHead(400).end(); return;}
    await transport.handleRequest(request, response, body);
  } catch {if (!response.headersSent) response.writeHead(500); response.end();}
});
let proxy, url;
if (process.env.HCP_LIVE_MCP_PROXY === "1") {
  proxy = new McpProxyServer({attachment: {name: "selected"}, upstream: {
    async connect() {}, async close() {},
    async listTools() {return [{name: tool.name, description: tool.description, input_schema: tool.inputSchema}];},
    async callTool(name, args, _grant, continuation) {
      assert.equal(name, tool.name); const scenario = args.scenario;
      assert.ok(["accept", "cancel", "lost"].includes(scenario));
      if (!continuation) throw new McpInputRequiredError(parseMcpPendingInput({requestState: scenario, inputRequests: {
        question: {method: "elicitation/create", params: {mode: "form", message: `Safe local acceptance question: ${scenario}`,
          requestedSchema: {type: "object", properties: {answer: {type: "string", minLength: 1, maxLength: 128}}, required: ["answer"]}}}}}));
      assert.equal(continuation.pending.requestState, scenario);
      const reply = continuation.responses.question; nativeReplies.push({scenario, action: reply.action});
      const value = reply.action === "accept" ? reply.content.answer : "cancelled";
      return {is_error: false, content: [{type: "text", text: value}], structured_content: {answer: value}};
    },
  }});
  await proxy.connect(); url = proxy.adapterAttachment.url;
} else {
  await new Promise(resolve => http.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${http.address().port}/mcp`;
}
const config = RunnerConfigSchema.parse({runner_id: "elicitation-acceptance", control_plane_url: "ws://localhost:1",
  workspaces: [{id: "workspace", path: cwd}], provider_instances: [{id: "claude", driver_kind: "claude"}]});
// An explicit local fixture connector exercises native MCP and HCP callback routing without external service effects.
const manager = new HarnessSessionManager(config, {stateStore: new JsonRunnerStateStore(join(cwd, "state.json")),
  mcpClientFactory: () => ({adapterAttachment: {name: "selected", transport: "streamable_http", url, headers: {}},
    async connect() {}, async listTools() {return [{name: tool.name, description: tool.description, input_schema: tool.inputSchema}];},
    async callTool() {throw new Error("Claude must invoke the actual native MCP transport");}, async close() {}})});
const events = [];
const responses = [];
const failures = [];
let scenario = "accept";
const unsubscribe = manager.subscribeEvents(event => {
  events.push(event);
  if (event.event_type !== "user_input.requested") return;
  if (scenario === "lost") return;
  const response = (async () => {
    assert.equal(event.turn_id, undefined); assert.equal(event.data.request_scope, "session");
    await assert.rejects(manager.respondToMcpInput({session_id: "session", turn_id: scenario, request_id: event.data.request_id,
      actor_id: "fixture", value: {answer: marker}}, () => {}));
    const resolution = await manager.respondToMcpInput({session_id: "session", request_scope: "session", request_id: event.data.request_id,
      actor_id: "fixture", ...(scenario === "cancel" ? {cancelled: true} : {value: {answer: marker}})}, () => {});
    assert.equal(resolution.kind, "live");
  })(); responses.push(response); void response.catch(error => failures.push(error));
});
const passed = [];
try {
  await manager.startSession({session_id: "session", workspace_id: "workspace", provider_instance_id: "claude", driver_kind: "claude", cwd,
    execution_profile: "interactive", continuation_group_key: "elicitation", sandbox_mode: "danger_full_access", approval_policy: "full_access",
    continue_session: false, model_selection: {model: process.env.HCP_LIVE_CLAUDE_MODEL ?? "sonnet"},
    mcp_servers: [{name: "selected", transport: "streamable_http", url, headers: {}, lease_id: "local-fixture",
      proof_of_possession: {scheme: "runner_signed_request", key_id: "local-fixture", required_headers: ["x-hcp-session-id", "x-hcp-host-id", "x-hcp-proof-signature", "x-hcp-proof-nonce"]}}]});
  for (scenario of ["accept", "cancel"]) {
    const result = await manager.sendTurn({session_id: "session", turn_id: scenario,
      input: `Call the selected MCP server's ask_marker tool exactly once with scenario ${scenario}. Reply only with the tool's answer. Use no other tools.`});
    await Promise.all(responses); if (failures.length) throw failures[0];
    const terminal = result.findLast(event => ["turn.completed", "turn.failed", "turn.cancelled"].includes(event.event_type));
    assert.equal(terminal?.event_type, "turn.completed");
    assert.ok(JSON.stringify(terminal.data).includes(scenario === "accept" ? marker : "cancelled"));
    assert.ok(nativeReplies.some(reply => reply.scenario === scenario && reply.action === scenario));
    passed.push(`native-form-${scenario}`, `${scenario}-session-scope`, `${scenario}-wrong-root-refused`);
  }
  assert.equal(events.filter(event => event.event_type === "user_input.requested").length, 2);
  assert.equal(events.filter(event => event.event_type === "user_input.resolved").length, 2);
  passed.push("native-form-lifecycle");
  scenario = "lost";
  const running = manager.sendTurn({session_id: "session", turn_id: "lost", input:
    "Call the selected MCP server's ask_marker tool exactly once with scenario lost. Wait for its answer. Use no other tools."});
  void running.catch(() => {});
  const deadline = Date.now() + 45_000;
  while (events.filter(event => event.event_type === "user_input.requested").length < 3) {
    if (Date.now() >= deadline) throw new Error("The native lost-callback question did not arrive");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const request = events.findLast(event => event.event_type === "user_input.requested");
  await manager.stopSession("session", "elicitation-owner-close");
  await running;
  assert.ok(events.some(event => event.event_type === "native.request.lost" && event.data.request_id === request.data.request_id && event.data.request_scope === "session"));
  assert.equal(events.some(event => event.event_type === "user_input.resolved" && event.data.request_id === request.data.request_id), false);
  await assert.rejects(manager.respondToMcpInput({session_id: "session", request_scope: "session", request_id: request.data.request_id,
    actor_id: "fixture", value: {answer: marker}}, () => {}));
  passed.push("native-form-callback-lost-on-unload", "lost-form-not-reported-as-user-cancellation", "stale-form-reply-refused");
} finally {
  try {await manager.stopSession("session", "cleanup");} catch (error) {if (error?.code !== "session_not_found") throw error;}
  unsubscribe();
  for (const server of servers) await server.close();
  await proxy?.close();
  if (http.listening) {http.closeAllConnections(); await new Promise(resolve => http.close(resolve));}
}
console.log(JSON.stringify({driver: "claude", proxy: !!proxy, passed, cwd}));
