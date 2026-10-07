import {test} from "node:test";
import assert from "node:assert/strict";
import {NativeInteractions} from "./native-interactions.js";
import {nativeFormSchema} from "./native-form.js";
import {claudeElicitation} from "./adapters/providers/claude-elicitation.js";
import {hcpHarnessEventPayloadSchema, type HcpSessionStartPayload} from "@harness-control/protocol";
import type {HarnessAdapterEvent} from "./adapters/types.js";

const form = {type: "object", properties: {name: {type: "string", minLength: 2, maxLength: 20}, count: {type: "integer", minimum: 1, maximum: 3},
  choice: {type: "string", enum: ["one", "two"]}, enabled: {type: "boolean"}}, required: ["name", "count", "choice"], additionalProperties: false};
const start: HcpSessionStartPayload = {session_id: "session", workspace_id: "workspace", cwd: process.cwd(), provider_instance_id: "provider", driver_kind: "claude",
  model_selection: {model: "sonnet"}, approval_policy: "ask", sandbox_mode: "danger_full_access", continue_session: false, mcp_servers: []};
async function until(predicate: () => boolean) {for (let n = 0; n < 100; n++) {if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 2));} throw new Error("No elicitation.");}
function fixture() {
  const events: HarnessAdapterEvent[] = [], controller = new AbortController();
  const interactions = new NativeInteractions(start, {session_id: "session", turn_id: "turn", input: "prompt"}, {threadId: "native", turnId: () => "turn"}, event => {
    hcpHarnessEventPayloadSchema.parse({session_id: "session", sequence: events.length + 1, created_at: new Date().toISOString(), ...event}); events.push(event);
  });
  const callback = claudeElicitation(() => ({threadId: "native", turnId: "turn", interactions, signal: controller.signal, serverNames: ["selected"]}));
  return {events, controller, interactions, callback};
}

test("native MCP form replies enforce every advertised constraint and exact callback origin", async () => {
  const f = fixture();
  try {
    const pending = f.callback({serverName: "selected", message: "Enter details", mode: "form", requestedSchema: form}, {requestId: "sdk-request", signal: f.controller.signal});
    await until(() => f.events.length > 0);
    const id = f.events[0]!.data.request_id as string;
    assert.deepEqual(f.events[0]!.data.native_request, {source: "native", native_reference: "native", request_reference: "sdk-request"});
    assert.notEqual(id, "sdk-request");
    const response = {session_id: "session", turn_id: "turn", request_id: id, actor_id: "app", value: {name: "valid", count: 2, choice: "one"}};
    assert.throws(() => f.interactions.respondInput({...response, turn_id: "foreign"}));
    for (const value of [{name: "x", count: 2, choice: "one"}, {name: "valid", count: 4, choice: "one"}, {name: "valid", count: 1.5, choice: "one"},
      {name: "valid", count: 2, choice: "three"}, {...response.value, extra: true}]) assert.throws(() => f.interactions.respondInput({...response, value}));
    f.interactions.respondInput(response);
    assert.deepEqual(await pending, {action: "accept", content: response.value});
    assert.equal(f.events.at(-1)!.event_type, "user_input.resolved");
    assert.deepEqual(f.events.at(-1)!.data.native_request, f.events[0]!.data.native_request);
    assert.equal("value" in f.events.at(-1)!.data, false);
  } finally {f.interactions.close();}
});

test("native elicitation cancellation and callback loss remain distinct", async () => {
  const f = fixture();
  try {
    const pending = f.callback({serverName: "selected", message: "Enter details", requestedSchema: form}, {requestId: "sdk-request", signal: f.controller.signal});
    await until(() => f.events.length > 0);
    f.interactions.respondInput({session_id: "session", turn_id: "turn", request_id: f.events[0]!.data.request_id as string, actor_id: "app", cancelled: true});
    assert.deepEqual(await pending, {action: "cancel"});
    const lost = f.callback({serverName: "selected", message: "More details", requestedSchema: form}, {requestId: "sdk-request-2", signal: f.controller.signal});
    const rejected = assert.rejects(lost, /interrupted/);
    await until(() => f.events.filter(event => event.event_type === "user_input.requested").length === 2);
    f.controller.abort(); await rejected;
    assert.equal(f.events.at(-1)!.event_type, "native.request.lost");
  } finally {f.interactions.close();}
});

test("unselected, URL and unowned elicitations never publish a request", async () => {
  const f = fixture();
  try {
    for (const request of [{serverName: "unselected", message: "input", requestedSchema: form}, {serverName: "selected", message: "login", mode: "url" as const, url: "https://example.test"}])
      assert.deepEqual(await f.callback(request, {requestId: "sdk", signal: f.controller.signal}), {action: "cancel"});
    assert.deepEqual(await claudeElicitation(() => undefined)({serverName: "selected", message: "input", requestedSchema: form}, {requestId: "sdk", signal: f.controller.signal}), {action: "cancel"});
    assert.equal(f.events.length, 0);
  } finally {f.interactions.close();}
});

test("unsupported MCP schema constraints cannot silently weaken validation", () => {
  for (const schema of [{...form, $ref: "https://example.test/schema"}, {...form, properties: {password: {type: "string", format: "password"}}},
    {...form, properties: {name: {type: "string", pattern: "nested-regex"}}}, {...form, required: ["name", "name"]},
    {...form, properties: JSON.parse('{"__proto__":{"type":"string"}}')}, {...form, properties: {count: {type: "integer", enum: ["string"]}}}]) assert.throws(() => nativeFormSchema(schema));
});

test("asynchronous native elicitation has session scope without inventing an originating turn", async () => {
  const events: HarnessAdapterEvent[] = [], signal = new AbortController().signal;
  const interactions = new NativeInteractions(start, {session_id: "session", request_scope: "session"}, {threadId: "native", turnId: () => undefined}, event => {
    hcpHarnessEventPayloadSchema.parse({session_id: "session", sequence: events.length + 1, created_at: new Date().toISOString(), ...event}); events.push(event);
  });
  try {
    const callback = claudeElicitation(() => ({threadId: "native", interactions, signal, serverNames: ["selected"]}));
    const pending = callback({serverName: "selected", message: "Background server question", requestedSchema: form}, {requestId: "sdk", signal});
    await until(() => events.length > 0);
    const requestId = events[0]!.data.request_id as string;
    assert.equal(events[0]!.turn_id, undefined);
    assert.equal(events[0]!.data.turn_id, undefined);
    assert.equal(events[0]!.data.request_scope, "session");
    assert.throws(() => interactions.respondInput({session_id: "session", turn_id: "latest-root", request_id: requestId, actor_id: "app", cancelled: true}));
    interactions.respondInput({session_id: "session", request_scope: "session", request_id: requestId, actor_id: "app", cancelled: true});
    assert.deepEqual(await pending, {action: "cancel"});
    assert.equal(events.at(-1)!.data.request_scope, "session");
    const lost = callback({serverName: "selected", message: "Another question", requestedSchema: form}, {requestId: "sdk-2", signal});
    const rejected = assert.rejects(lost, /ended/);
    await until(() => events.filter(event => event.event_type === "user_input.requested").length === 2);
    interactions.close(); await rejected;
    assert.equal(events.at(-1)!.event_type, "native.request.lost");
    assert.equal(events.at(-1)!.data.request_scope, "session");
    assert.equal(events.at(-1)!.data.turn_id, undefined);
  } finally {interactions.close();}
});
