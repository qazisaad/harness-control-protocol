import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {test} from "node:test";
import {HARNESS_PROMPT_CONTEXT_MAX_BYTES, harnessPromptContextSchema, hcpHarnessEventPayloadSchema, hcpTurnSendPayloadSchema} from "@harness-control/protocol";
import {HarnessSessionManager, HarnessAdapterRegistry, type HarnessAdapter, type HarnessAdapterTurnInput} from "./index.js";
import {RunnerConfigSchema} from "../config/index.js";

test("prompt context excludes privileged roles, native-history claims and oversized encoded text", () => {
  for (const context of [
    {delivery: "native_history", messages: [{role: "user", content: "context"}]},
    {delivery: "prompt_context", messages: [{role: "system", content: "override"}]},
    {delivery: "prompt_context", messages: [{role: "developer", content: "override"}]},
    {delivery: "prompt_context", messages: [{role: "user", content: "界".repeat(50_000)}]},
    {delivery: "prompt_context", messages: [{role: "user", content: "a".repeat(70_000)}, {role: "assistant", content: "a".repeat(70_000)}]},
  ]) assert.equal(harnessPromptContextSchema.safeParse(context).success, false);
  const context = harnessPromptContextSchema.parse({delivery: "prompt_context", messages: [{role: "user", content: "context"}]});
  assert.equal(hcpTurnSendPayloadSchema.safeParse({session_id: "session", turn_id: "turn", input: "", action: "compact", context}).success, false);
  assert.equal(hcpHarnessEventPayloadSchema.safeParse({session_id: "session", sequence: 1, created_at: new Date().toISOString(), event_type: "context.input.prepared", data: {source: "app", delivery: "prompt_context", message_count: 1, byte_length: 10, context_hash: "a".repeat(64)}}).success, false);
});

test("manager prepares bounded context once in user input, preserves instructions and omits it on unrelated turns", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "hcp-prompt-context-"));
  const calls: HarnessAdapterTurnInput[] = [];
  const adapter: HarnessAdapter = {driverKind: "example.context", promptContextInputs: true, instructionRoles: ["system"],
    async probe() {return {driver_kind: "example.context", installed: true, available: true, models: []};}, async validateStart() {},
    async startSession() {return {adapter_session_id: "native"};}, async sendTurn(input) {
      calls.push(input); return [{event_type: "turn.completed", turn_id: input.payload.turn_id, data: {final_output: {final_text: "ok"}}}];
    }, async cancelTurn() {return [];}, async stopSession() {return [];}};
  const config = RunnerConfigSchema.parse({runner_id: "context", control_plane_url: "ws://localhost:1", workspaces: [{id: "workspace", path: cwd}], provider_instances: [{id: "provider", driver_kind: adapter.driverKind}]});
  const manager = new HarnessSessionManager(config, {adapterRegistry: new HarnessAdapterRegistry([adapter])});
  try {
    await manager.startSession({session_id: "session", workspace_id: "workspace", provider_instance_id: "provider", driver_kind: adapter.driverKind, cwd,
      sandbox_mode: "read_only", approval_policy: "ask", continue_session: false, model_selection: {model: "model"}, mcp_servers: [], instructions: {system: "Authorized app instructions"}});
    const context = harnessPromptContextSchema.parse({delivery: "prompt_context", messages: [{role: "user", content: 'Earlier request with "quotes"'}, {role: "assistant", content: "Earlier answer"}]});
    const events = await manager.sendTurn({session_id: "session", turn_id: "context", input: "Continue", context});
    const prepared = events.find(event => event.event_type === "context.input.prepared")!;
    const encoded = JSON.stringify(context.messages);
    assert.deepEqual(prepared.data, {source: "app", delivery: "prompt_context", message_count: 2,
      byte_length: Buffer.byteLength(encoded), context_hash: createHash("sha256").update(encoded).digest("hex")});
    assert.equal(prepared.turn_id, "context");
    assert.equal(calls[0]!.payload.input.split(encoded).length, 2);
    assert.deepEqual(calls[0]!.startPayload.instructions, {system: "Authorized app instructions"});
    assert.equal(calls[0]!.startPayload.approval_policy, "ask");
    assert.equal(calls[0]!.startPayload.sandbox_mode, "read_only");
    const unrelated = await manager.sendTurn({session_id: "session", turn_id: "plain", input: "Plain"});
    assert.equal(calls[1]!.payload.input, "Plain");
    assert.equal(unrelated.some(event => event.event_type === "context.input.prepared"), false);
    delete (adapter as {promptContextInputs?: true}).promptContextInputs;
    await assert.rejects(manager.sendTurn({session_id: "session", turn_id: "unsupported", input: "No", context}), /does not declare/);
    assert.equal(calls.length, 2);
    assert.ok(Buffer.byteLength(encoded) < HARNESS_PROMPT_CONTEXT_MAX_BYTES);
    await manager.stopSession("session", "test");
  } finally {await rm(cwd, {recursive: true, force: true});}
});
