import assert from "node:assert/strict";
import { test } from "node:test";
import { NativeMcpBridge, nativeMcpResult } from "./native-mcp.js";
import type { McpReviewGrant, McpReviewPolicy } from "../../../mcp/McpAttachmentClient.js";

const tool = {name: "lookup", input_schema: {type: "object", properties: {query: {type: "string"}}}};
const binding = {threadId: "thread", turnId: "turn"};
const signal = new AbortController().signal;

for (const policy of [{kind: "always"}, {kind: "argument", argument: "name", values: ["lookup"]}] satisfies McpReviewPolicy[]) {
  for (const accepted of [true, false]) {
    test(`review ${policy.kind} waits before dispatch and handles accepted=${accepted}`, async () => {
      const grant = {request_id: "review-1", action_json: "exact-action"};
      let decide!: (value: McpReviewGrant | null) => void;
      const decision = new Promise<McpReviewGrant | null>(resolve => {decide = resolve;});
      const requests: unknown[] = [];
      const calls: unknown[] = [];
      const bridge = new NativeMcpBridge([{name: "selected", tools: [{...tool, review_policy: policy}],
        async callTool(name, args, proof) {calls.push({name, args, proof}); return {is_error: false};},
      }], {async request(request) {requests.push(request); return decision;}, async complete() {}});
      const args = {name: "lookup", query: "unchanged"};
      const pending = bridge.call({...binding, namespace: bridge.definitions[0]!.name, tool: "lookup", callId: "call", arguments: args}, binding, signal);
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(calls, []);
      assert.deepEqual(requests, [{attachment_name: "selected", tool_name: "lookup", arguments: args,
        native_thread_id: "thread", native_turn_id: "turn", native_call_id: "call"}]);
      decide(accepted ? grant : null);
      const result = await pending;
      assert.equal(result.success, accepted);
      assert.deepEqual(calls, accepted ? [{name: "lookup", args, proof: grant}] : []);
    });
  }
}

test("review hints fail closed when no platform review owner exists", async () => {
  let calls = 0;
  const bridge = new NativeMcpBridge([{name: "selected", tools: [{...tool, review_policy: {kind: "always"}}],
    async callTool() {calls++; return {is_error: false};}}]);
  await assert.rejects(bridge.call({...binding, namespace: bridge.definitions[0]!.name, tool: "lookup", callId: "call", arguments: {}}, binding, signal), /requires platform review/);
  assert.equal(calls, 0);
});

test("catalog mutation cannot change the admitted native tool scope or schema", async () => {
  const selected = structuredClone(tool);
  const tools = [selected];
  const calls: string[] = [];
  const bridge = new NativeMcpBridge([{name: "selected", tools, async callTool(name) {calls.push(name); return {is_error: false};}}]);
  selected.input_schema.properties.query.type = "number";
  tools.splice(0, 1, {...selected, name: "unselected"});
  assert.deepEqual(bridge.definitions[0]!.tools[0]!.inputSchema, tool.input_schema);
  const call = {...binding, namespace: bridge.definitions[0]!.name, arguments: {query: "query"}};
  await assert.rejects(bridge.call({...call, tool: "unselected", callId: "outside"}, binding, signal), /outside/);
  await bridge.call({...call, tool: "lookup", callId: "selected"}, binding, signal);
  assert.deepEqual(calls, ["lookup"]);
});

test("same-name tools retain distinct attachments and exact arguments", async () => {
  const calls: unknown[] = [];
  const bridge = new NativeMcpBridge(["first", "second"].map(name => ({name, tools: [tool],
    async callTool(toolName: string, args: Record<string, unknown>) {
      calls.push([name, toolName, args]); return {is_error: false, structured_content: {source: name}};
    },
  })));
  assert.notEqual(bridge.definitions[0]!.name, bridge.definitions[1]!.name);
  const result = await bridge.call({...binding, namespace: bridge.definitions[1]!.name, tool: "lookup", callId: "call", arguments: {query: "exact"}}, binding, signal);
  assert.deepEqual(calls, [["second", "lookup", {query: "exact"}]]);
  assert.deepEqual(result, {success: true, contentItems: [{type: "inputText", text: '{"source":"second"}'}]});
});

test("foreign calls and repeated call identities cannot execute", async () => {
  let count = 0;
  const bridge = new NativeMcpBridge([{name: "selected", tools: [tool], async callTool() {count++; return {is_error: false};}}]);
  const call = {...binding, namespace: bridge.definitions[0]!.name, tool: "lookup", callId: "call", arguments: {}};
  for (const change of [{threadId: "foreign"}, {turnId: "foreign"}, {tool: "other"}, {namespace: "unknown"}]) {
    await assert.rejects(bridge.call({...call, ...change}, binding, signal), /outside/);
  }
  await bridge.call(call, binding, signal);
  await assert.rejects(bridge.call(call, binding, signal), /repeated/);
  assert.equal(count, 1);
});

test("aborting queued calls prevents dispatch after the current operation", async () => {
  const controller = new AbortController();
  let finish!: () => void;
  const pending = new Promise<void>(resolve => {finish = resolve;});
  let count = 0;
  const bridge = new NativeMcpBridge([{name: "selected", tools: [tool], async callTool() {count++; await pending; return {is_error: false};}}]);
  const call = {...binding, namespace: bridge.definitions[0]!.name, tool: "lookup", arguments: {}};
  const first = bridge.call({...call, callId: "first"}, binding, controller.signal);
  const second = bridge.call({...call, callId: "second"}, binding, controller.signal);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(count, 1);
  controller.abort(); finish();
  const outcomes = await Promise.allSettled([first, second]);
  assert.ok(outcomes.every(outcome => outcome.status === "rejected"));
  assert.equal(count, 1);
});

test("native results preserve media, structured data and MCP error status", () => {
  assert.deepEqual(nativeMcpResult({is_error: true, structured_content: {code: "denied"}, content: [
    {type: "text", text: "Denied"}, {type: "image", mimeType: "image/png", data: "aA=="},
    {type: "audio", mimeType: "audio/wav", data: "aA=="},
  ]}), {success: false, contentItems: [
    {type: "inputText", text: '{"code":"denied"}'}, {type: "inputText", text: "Denied"},
    {type: "inputImage", imageUrl: "data:image/png;base64,aA=="}, {type: "inputAudio", audioUrl: "data:audio/wav;base64,aA=="},
  ]});
});
