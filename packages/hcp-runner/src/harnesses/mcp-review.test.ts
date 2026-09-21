import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import type { HcpHarnessEventPayload, HcpSessionStartPayload } from "@harness-control/protocol";
import { MemoryRunnerStateStore } from "../state/index.js";
import { HarnessMcpReview } from "./mcp-review.js";
import { McpInputRequiredError, parseMcpPendingInput } from "../mcp/input-required.js";
import { McpAttachmentClient, MCP_REVIEW_META_KEY, type McpReviewGrant } from "../mcp/McpAttachmentClient.js";
import { NativeMcpBridge, nativeMcpNamespace } from "./adapters/providers/native-mcp.js";
import type { HarnessMcpToolset } from "./adapters/types.js";

function setup(publish?: (event: HcpHarnessEventPayload) => void) {
  const store = new MemoryRunnerStateStore();
  const events: HcpHarnessEventPayload[] = [];
  const start: HcpSessionStartPayload = {session_id: "session", workspace_id: "workspace", provider_instance_id: "codex", driver_kind: "codex",
    cwd: "/repo", sandbox_mode: "read_only", approval_policy: "full_access", continue_session: false,
    model_selection: {model: "model", options: []}, mcp_servers: [{name: "selected", transport: "streamable_http",
      url: "https://example.com/mcp", lease_id: "lease", expires_at: new Date(Date.now() + 60000).toISOString(),
      headers: {Authorization: "Bearer private"}, proof_of_possession: {scheme: "runner_signed_request", key_id: "key",
        required_headers: ["x-hcp-proof-signature", "x-hcp-proof-nonce"]}}]};
  const owner = new HarnessMcpReview(store, start, {session_id: "session", turn_id: "turn", input: "Read"}, event => {events.push(event); publish?.(event);});
  const request = {attachment_name: "selected", tool_name: "lookup", arguments: {query: "value"},
    native_thread_id: "native-thread", native_turn_id: "native-turn", native_call_id: "native-call"};
  return {store, owner, request, events, start};
}

for (const decision of ["accept", "decline"] as const) {
  test(`platform ${decision} is durable before the native request resumes`, async () => {
    const {store, owner, request, events} = setup();
    const waiting = owner.request(request, new AbortController().signal);
    const review = store.getMcpReview("session")!;
    assert.equal(review.outcome.phase, "waiting");
    assert.equal(events.length, 1);
    const response = {session_id: "session", turn_id: "turn", request_id: review.request_id, action_hash: review.action_hash, decision, actor_id: "actor"};
    assert.throws(() => owner.decide({...response, action_hash: "wrong"}), /does not match/);
    owner.decide(response);
    owner.decide(response);
    const grant = await waiting;
    assert.equal(events.length, 2);
    assert.equal(store.getMcpReview("session")?.outcome.phase, decision === "accept" ? "dispatching" : "declined");
    if (decision === "accept") {
      assert.ok(grant);
      await owner.complete(grant, {is_error: false, structured_content: {value: 1}});
      const outcome = store.getMcpReview("session")!.outcome;
      assert.equal(outcome.phase, "completed");
      if (outcome.phase === "completed") assert.deepEqual(JSON.parse(outcome.result_json), {is_error: false, structured_content: {value: 1}});
    } else assert.equal(grant, null);
    assert.throws(() => owner.decide({...response, decision: decision === "accept" ? "decline" : "accept"}), /another decision/);
  });
}

test("native process loss retains a waiting review without authorizing a call", async () => {
  const {store, owner, request} = setup();
  const controller = new AbortController();
  const waiting = owner.request(request, controller.signal);
  controller.abort();
  await assert.rejects(waiting, /interrupted/);
  assert.equal(store.getMcpReview("session")?.outcome.phase, "waiting");
});

test("a durable decision releases its native waiter even when live delivery fails", async () => {
  const {store, owner, request} = setup(event => {
    if (event.event_type === "approval.resolved") throw new Error("connection closed");
  });
  const waiting = owner.request(request, new AbortController().signal);
  const review = store.getMcpReview("session")!;
  assert.throws(() => owner.decide({session_id: "session", turn_id: "turn", request_id: review.request_id,
    action_hash: review.action_hash, decision: "accept", actor_id: "actor"}), /connection closed/);
  assert.deepEqual(await waiting, {request_id: review.request_id, action_json: review.action_json});
  assert.equal(store.getMcpReview("session")?.outcome.phase, "dispatching");
  assert.equal(store.replayEventsAfter("session", 0)?.at(-1)?.event_type, "approval.resolved");
});

for (const reviewed of [false, true]) for (const action of ["accept", "decline", "cancel"] as const) {
  test(`MCP form ${action} resumes the same operation after persistence (reviewed=${reviewed})`, async () => {
    let notify!: () => void;
    const published = new Promise<void>(resolve => {notify = resolve;});
    const {store, owner, request, events} = setup(event => {
      if (event.event_type === "input.requested") notify();
    });
    const signal = new AbortController().signal;
    let grant: McpReviewGrant | undefined;
    if (reviewed) {
      const approval = owner.request(request, signal);
      const retained = store.getMcpReview("session")!;
      owner.decide({session_id: "session", turn_id: "turn", request_id: retained.request_id,
        action_hash: retained.action_hash, decision: "accept", actor_id: "reviewer"});
      grant = (await approval)!;
    }
    let calls = 0;
    const inputExpiry = new Date(Date.now() + 30000).toISOString();
    const pending = parseMcpPendingInput({requestState: "private-opaque", inputRequests: {question: {
      method: "elicitation/create", params: {_meta: {"com.prompt2agent/input-deadline": inputExpiry}, message: "Choose a name", requestedSchema: {type: "object",
        properties: {name: {type: "string", minLength: 1}}, required: ["name"]}},
    }}});
    const callTool: HarnessMcpToolset["callTool"] = async (name, args, actualGrant, reply) => {
      calls++;
      assert.equal(name, request.tool_name);
      assert.deepEqual(args, request.arguments);
      assert.deepEqual(actualGrant, grant);
      if (!reply) throw new McpInputRequiredError(pending);
      assert.equal(store.getMcpReview("session")?.outcome.phase, "input_resuming");
      assert.deepEqual(reply.pending, pending);
      assert.deepEqual(reply.responses, {question: {action, ...(action === "accept" ? {content: {name: "Ada"}} : {})}});
      return {is_error: false, content: [{type: "text", text: "done"}]};
    };
    const execution = reviewed ? owner.invoke(request, callTool, signal, grant)
      : new NativeMcpBridge([{name: request.attachment_name, tools: [{name: request.tool_name, input_schema: {type: "object"}}], callTool}], owner)
        .call({threadId: request.native_thread_id, turnId: request.native_turn_id, callId: request.native_call_id,
          namespace: nativeMcpNamespace(request.attachment_name), tool: request.tool_name, arguments: request.arguments},
        {threadId: request.native_thread_id, turnId: request.native_turn_id}, signal);
    await published;
    const waiting = store.getMcpReview("session")!;
    assert.ok(waiting.outcome.phase === "input_waiting");
    assert.ok(Date.parse(waiting.expires_at) > Date.parse(inputExpiry));
    assert.ok(events.some(event => event.event_type === "input.requested" && "expires_at" in event.data && event.data.expires_at === inputExpiry));
    const response = {session_id: "session", turn_id: "turn", request_id: waiting.outcome.input_request_id, actor_id: "responder"};
    assert.throws(() => owner.respondToInput({...response, turn_id: "another", value: {}}), /does not match/);
    assert.throws(() => owner.respondToInput({...response, value: {question: {action: "accept", content: {}}}}), /form schema/);
    assert.equal(calls, 1);
    owner.respondToInput({...response, ...(action === "cancel" ? {cancelled: true} : {
      value: {question: {action, ...(action === "accept" ? {content: {name: "Ada"}} : {})}},
    })});
    assert.deepEqual(await execution, reviewed ? {is_error: false, content: [{type: "text", text: "done"}]}
      : {success: true, contentItems: [{type: "inputText", text: "done"}]});
    assert.equal(calls, 2);
    assert.equal(store.getMcpReview("session")?.outcome.phase, "completed");
    assert.equal(JSON.stringify(events).includes("private-opaque"), false);
    assert.equal(JSON.stringify(events).includes("Ada"), false);
    assert.ok(events.some(event => event.event_type === "input.requested" && "form_schema" in event.data));
    await assert.rejects(owner.invoke(request, async () => {calls++; return {is_error: false};}, signal, grant), /retained state|does not match/);
    assert.equal(calls, 2);
  });
}

test("an expired worker input cannot dispatch even while its caller lease is valid", async () => {
  let notify!: () => void;
  const published = new Promise<void>(resolve => {notify = resolve;});
  const {store, owner, request} = setup(event => {if (event.event_type === "input.requested") notify();});
  let calls = 0;
  const execution = owner.invoke(request, async () => {
    calls++;
    throw new McpInputRequiredError(parseMcpPendingInput({requestState: "opaque", inputRequests: {question: {
      method: "elicitation/create", params: {message: "Confirm", requestedSchema: {type: "object", properties: {}},
        _meta: {"com.prompt2agent/input-deadline": new Date(Date.now() - 1000).toISOString()}},
    }}}));
  }, new AbortController().signal);
  const expired = assert.rejects(execution, /expired/);
  await published;
  const record = store.getMcpReview("session")!;
  assert.ok(Date.parse(record.expires_at) > Date.now());
  assert.ok(record.outcome.phase === "input_waiting");
  const requestId = record.outcome.input_request_id;
  assert.throws(() => owner.respondToInput({session_id: "session", turn_id: "turn",
    request_id: requestId, actor_id: "actor", value: {question: {action: "accept", content: {}}}}), /does not match/);
  await expired;
  assert.equal(calls, 1);
});

test("interrupting a live input wait retains it without dispatching a continuation", async () => {
  let notify!: () => void;
  const published = new Promise<void>(resolve => {notify = resolve;});
  const {store, owner, request} = setup(event => {if (event.event_type === "input.requested") notify();});
  let calls = 0;
  const execution = owner.invoke(request, async () => {
    calls++;
    throw new McpInputRequiredError(parseMcpPendingInput({requestState: "opaque"}));
  }, new AbortController().signal);
  await published;
  owner.interrupt();
  await assert.rejects(execution, /interrupted/);
  assert.equal(calls, 1);
  assert.equal(store.getMcpReview("session")?.outcome.phase, "input_waiting");
});

for (const action of ["accept", "decline", "cancel"] as const) {
  test(`native review and ${action} input reach completion through the HTTP SDK`, {timeout: 10000}, async () => {
    let notifyApproval!: () => void;
    let notifyInput!: () => void;
    const approvalReady = new Promise<void>(resolve => {notifyApproval = resolve;});
    const inputReady = new Promise<void>(resolve => {notifyInput = resolve;});
    const {store, owner, request, start, events} = setup(event => {
      if (event.event_type === "approval.requested") notifyApproval();
      if (event.event_type === "input.requested") notifyInput();
    });
    const calls: string[] = [];
    const hashes: string[] = [];
    const failures: Error[] = [];
    const server = createServer(async (incoming, response) => {
      try {
        assert.equal(incoming.method, "POST");
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks).toString("utf8");
        const rpc = JSON.parse(body);
        assert.equal(incoming.headers["x-hcp-proof-body-sha256"], `sha256:${createHash("sha256").update(body).digest("base64url")}`);
        let result: object;
        if (rpc.method === "server/discover") {
          result = {resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: {tools: {}}, ttlMs: 0, cacheScope: "private"};
        } else if (rpc.method === "tools/list") {
          result = {resultType: "complete", tools: [{name: "lookup", inputSchema: {type: "object"},
            _meta: {[MCP_REVIEW_META_KEY]: {kind: "always"}}}], ttlMs: 0, cacheScope: "private"};
        } else {
          assert.equal(rpc.method, "tools/call");
          calls.push(body);
          const retained = store.getMcpReview("session")!;
          hashes.push(retained.action_hash);
          assert.deepEqual(rpc.params.arguments, request.arguments);
          assert.deepEqual(rpc.params._meta[MCP_REVIEW_META_KEY], {request_id: retained.request_id, action_json: retained.action_json});
          if (calls.length === 1) {
            assert.equal(retained.outcome.phase, "dispatching");
            result = {resultType: "input_required", requestState: "private-http-state", inputRequests: {question: {
              method: "elicitation/create", params: {message: "Choose a name", requestedSchema: {type: "object",
                properties: {name: {type: "string"}}, required: ["name"]}},
            }}};
          } else {
            assert.equal(calls.length, 2);
            assert.equal(retained.outcome.phase, "input_resuming");
            assert.equal(rpc.params.requestState, "private-http-state");
            assert.deepEqual(rpc.params.inputResponses, {question: {action, ...(action === "accept" ? {content: {name: "Ada"}} : {})}});
            result = {resultType: "complete", content: [{type: "text", text: "done"}]};
          }
        }
        response.writeHead(200, {"Content-Type": "application/json"}).end(JSON.stringify({jsonrpc: "2.0", id: rpc.id, result}));
      } catch (error) {
        failures.push(error instanceof Error ? error : new Error(String(error)));
        response.writeHead(500).end();
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const attachment = start.mcp_servers![0]!;
    assert.equal(attachment.transport, "streamable_http");
    const client = new McpAttachmentClient({...attachment, transport: "streamable_http", url: `http://127.0.0.1:${address.port}/mcp`}, {
      proofContext: {session_id: "session", host_id: "host", workspace_id: "workspace", provider_instance_id: "codex", turn_id: "turn"},
      proofSigner: () => "test-signature",
    });
    try {
      await client.connect();
      const bridge = new NativeMcpBridge([{name: attachment.name, tools: await client.listTools(), callTool: client.callTool.bind(client)}], owner);
      const execution = bridge.call({threadId: request.native_thread_id, turnId: request.native_turn_id,
        callId: request.native_call_id, namespace: nativeMcpNamespace(attachment.name), tool: request.tool_name, arguments: request.arguments},
      {threadId: request.native_thread_id, turnId: request.native_turn_id}, new AbortController().signal);
      await approvalReady;
      assert.equal(calls.length, 0);
      const reviewed = store.getMcpReview("session")!;
      owner.decide({session_id: "session", turn_id: "turn", request_id: reviewed.request_id,
        action_hash: reviewed.action_hash, decision: "accept", actor_id: "reviewer"});
      await inputReady;
      const waiting = store.getMcpReview("session")!;
      assert.equal(waiting.request_id, reviewed.request_id);
      assert.ok(waiting.outcome.phase === "input_waiting");
      assert.equal(calls.length, 1);
      owner.respondToInput({session_id: "session", turn_id: "turn", request_id: waiting.outcome.input_request_id,
        actor_id: "responder", value: {question: {action, ...(action === "accept" ? {content: {name: "Ada"}} : {})}}});
      assert.deepEqual(await execution, {success: true, contentItems: [{type: "inputText", text: "done"}]});
      assert.equal(store.getMcpReview("session")?.outcome.phase, "completed");
      assert.deepEqual(hashes, [reviewed.action_hash, reviewed.action_hash]);
      assert.deepEqual(failures, []);
      assert.equal(JSON.stringify(events).includes("private-http-state"), false);
      assert.equal(JSON.stringify(events).includes("Ada"), false);
    } finally {
      owner.interrupt();
      await client.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
}
