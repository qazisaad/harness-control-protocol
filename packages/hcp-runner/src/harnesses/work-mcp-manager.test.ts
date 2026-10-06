import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtemp, rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import type {HcpHarnessEventPayload, HcpSessionStartPayload} from "@harness-control/protocol";
import {HarnessSessionManager, HarnessAdapterRegistry, type HarnessAdapter, type HarnessAdapterEvent} from "./index.js";
import type {HarnessAdapterTurnInput} from "./adapters/types.js";
import {RunnerConfigSchema} from "../config/index.js";
import {JsonRunnerStateStore} from "../state/index.js";

test("a child MCP request keeps its original owner across root completion, new roots and restart", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "hcp-work-mcp-"));
  const path = join(cwd, "state.json");
  const store = new JsonRunnerStateStore(path);
  let emit!: (event: HarnessAdapterEvent) => void;
  let first!: HarnessAdapterTurnInput;
  const adapter: HarnessAdapter = {driverKind: "example", durableMcpContinuation: true, nativeWork: true, sessionEvents: true,
    async probe() {return {driver_kind: "example", installed: true, available: true, models: []};}, async validateStart() {},
    async startSession(input) {emit = input.emitSessionEvent!; return {adapter_session_id: "native"};},
    async sendTurn(input) {
      if (input.payload.turn_id === "first") {
        first = input;
        emit({event_type: "native.work.updated", data: {work: {work_id: "child", native_reference: "native-child", origin_turn_id: "first",
          kind: "task", background: true, status: "running", supports_cancel: false}}});
      }
      return [{event_type: "turn.completed", data: {final_output: {final_text: "done"}}}];
    }, async cancelTurn() {return [];}, async stopSession() {
      emit({event_type: "native.work.updated", data: {work: {work_id: "child", native_reference: "native-child", origin_turn_id: "first",
        kind: "task", background: true, status: "completed", supports_cancel: false}}});
      return [];
    },
  };
  const config = RunnerConfigSchema.parse({runner_id: "runner", control_plane_url: "ws://localhost:1",
    workspaces: [{id: "workspace", path: cwd}], provider_instances: [{id: "provider", driver_kind: "example"}]});
  const options = {adapterRegistry: new HarnessAdapterRegistry([adapter]), mcpClientFactory: () => ({async connect() {}, async close() {},
    async listTools() {return [{name: "read", input_schema: {type: "object"}}];}, async callTool() {return {is_error: false};}})};
  const manager = new HarnessSessionManager(config, {...options, stateStore: store});
  const start: HcpSessionStartPayload = {session_id: "session", workspace_id: "workspace", cwd, provider_instance_id: "provider", driver_kind: "example",
    model_selection: {model: "example"}, sandbox_mode: "read_only", approval_policy: "ask", continue_session: false,
    mcp_servers: [{name: "tools", transport: "streamable_http", url: "https://example.com/mcp", lease_id: "lease",
      expires_at: new Date(Date.now() + 60000).toISOString(), headers: {}, proof_of_possession: {scheme: "runner_signed_request",
        key_id: "key", required_headers: ["x-hcp-proof-signature"]}}]};
  const events: HcpHarnessEventPayload[] = [];
  manager.subscribeEvents(event => events.push(event));
  try {
    await manager.startSession(start);
    await manager.sendTurn({session_id: "session", turn_id: "first", input: "spawn"});
    await manager.sendTurn({session_id: "session", turn_id: "second", input: "follow up"});
    const reviewer = first.reviewNativeWorkMcp!("child");
    assert.throws(() => first.reviewNativeWorkMcp!("unknown"), /confirmed live work/);
    const request = {attachment_name: "tools", tool_name: "read", arguments: {}, native_thread_id: "native-child", native_turn_id: "child-turn", native_call_id: "call"};
    const controller = new AbortController();
    const pending = reviewer.request(request, controller.signal);
    const approval = store.getMcpReview("session")!;
    assert.equal(approval.native_work_id, "child");
    assert.equal(approval.turn.turn_id, "first");
    assert.ok(events.some(event => event.event_type === "approval.requested" && event.turn_id === "first" &&
      (event.data as Record<string, unknown>).native_work_id === "child"));
    await assert.rejects(manager.respondToMcpReview({session_id: "session", turn_id: "second", request_id: approval.request_id,
      actor_id: "user", decision: "accept", action_hash: approval.action_hash}, () => {}), /does not match/);
    assert.deepEqual(await manager.respondToMcpReview({session_id: "session", turn_id: "first", request_id: approval.request_id,
      actor_id: "user", decision: "accept", action_hash: approval.action_hash}, () => {}), {kind: "live"});
    const grant = await pending;
    assert.ok(grant);
    await reviewer.complete(grant, {is_error: false});
    const waiting = reviewer.request({...request, native_call_id: "lost-call"}, controller.signal);
    const rejection = assert.rejects(waiting, /interrupted/);
    const lost = store.getMcpReview("session")!;
    emit({event_type: "native.work.owner_lost", data: {reason: "transport_lost"}});
    await rejection;
    await assert.rejects(manager.respondToMcpReview({session_id: "session", turn_id: "first", request_id: lost.request_id,
      actor_id: "user", decision: "accept", action_hash: lost.action_hash}, () => {}), /cannot be resumed through a root/);
    const restarted = new HarnessSessionManager(config, {...options, stateStore: new JsonRunnerStateStore(path)});
    const recovered: HcpHarnessEventPayload[] = [];
    await restarted.recoverMcpReviews(event => recovered.push(event), () => assert.fail("lost child callback resumed through a root"));
    assert.ok(recovered.some(event => event.event_type === "native.request.lost" && event.turn_id === "first" &&
      (event.data as Record<string, unknown>).native_work_id === "child"));
    assert.equal(new JsonRunnerStateStore(path).getMcpReview("session")?.request_id, lost.request_id);
  } finally {await manager.stopSession("session", "test complete"); await rm(cwd, {recursive: true, force: true});}
});
