import assert from "node:assert/strict";
import {test} from "node:test";
import {nativeConversationHistorySchema, harnessPortableHistoryItemsSchema} from "@harness-control/protocol";
import {portableHistoryItem, portableItemObservation} from "./portable-history.js";
import {hash, publicHistory} from "./conversation-history.js";
import {BoundedHarnessContentStore} from "./content-store.js";

test("portable history exposes common native messages and tool call/result ownership without native parsing", () => {
  const codex = portableHistoryItem({id: "user", type: "userMessage", content: [{type: "text", text: "first"}, {type: "text", text: "second"}]}, "codex", "fallback");
  assert.deepEqual(codex, [{id: "user", native_item_reference: "user", status: "unknown", type: "message", role: "user", body: {storage: "inline", value: "first\nsecond"}}]);
  const call = portableHistoryItem({id: "call", type: "tool_call", tool_name: "Read", arguments: {path: "a.txt"}}, "claude", "fallback")[0]!;
  const result = portableHistoryItem({id: "call", type: "tool_result", content: "file contents", status: "completed"}, "claude", "fallback")[0]!;
  assert.equal(call.type, "tool_call");
  assert.equal(result.type, "tool_result");
  if (result.type !== "tool_result") throw new Error("Expected a result");
  assert.equal(result.call_id, call.id);
  assert.notEqual(result.id, call.id);
  const openCode = portableHistoryItem({id: "part", type: "tool_call", tool_name: "bash", arguments: {command: "pwd"}, output: "/workspace", status: "completed"}, "opencode", "fallback");
  assert.deepEqual(openCode.map(item => item.type), ["tool_call", "tool_result"]);
  assert.equal(openCode[1]?.type === "tool_result" && openCode[1].call_id, "part");
  const edit = portableHistoryItem({id: "edit", type: "fileChange", status: "completed", changes: [{path: "old.ts", kind: {type: "update", move_path: "new.ts"}, diff: "+change"}]}, "codex", "fallback")[0]!;
  assert.deepEqual(edit.type === "file_change" && edit.changes.storage === "inline" && edit.changes.value,
    [{path: "new.ts", previous_path: "old.ts", change_type: "renamed", diff: "+change"}]);
});

test("unsupported native shapes remain explicit display extensions instead of invented message semantics", () => {
  const items = portableHistoryItem({id: "future", type: "futureNativeType", secretless_metadata: {value: 1}}, "codex", "fallback");
  assert.equal(items[0]?.type, "extension");
  assert.equal(items[0]?.type === "extension" && items[0].namespace, "codex");
  assert.equal(portableHistoryItem({id: "malformed", type: "tool_call"}, "claude", "fallback")[0]?.type, "extension");
  const text = portableHistoryItem({id: "text", type: "text", text: "retained without a role"}, "custom", "fallback")[0]!;
  assert.equal(text.type === "message" && text.role, "unknown");
});

test("large busy turns retain typed content through bounded pages and leave native mutation hashes unchanged", () => {
  const store = new BoundedHarnessContentStore();
  const scope = {session_id: "session", provider_instance_id: "provider", provider_binding_hash: "hash", workspace_id: "workspace", cwd: "/workspace"};
  const publish = (value: unknown) => store.publish(scope, value);
  const thread = {id: "native", turns: [{id: "turn", status: "completed", items: Array.from({length: 120}, (_, index) =>
    ({id: `answer-${index}`, type: "agentMessage", status: "completed", text: `🙂${index}`.repeat(2500)}))}]};
  const revision = hash(thread.turns);
  const history = nativeConversationHistorySchema.parse(publicHistory(thread, publish, undefined, "codex"));
  assert.equal(history.history_hash, revision);
  assert.equal(hash(thread.turns), revision);
  assert.equal(history.turn_count, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(history)) < 192 * 1024);
  const retained = history.turns[0]!.portable_items_ref!;
  assert.equal(retained.format, "json");
  const chunks: Buffer[] = [];
  let offset = 0;
  do {
    const chunk = store.read("session", retained.content_id, offset, 64 * 1024);
    chunks.push(Buffer.from(chunk.data_base64, "base64"));
    if (chunk.next_offset === undefined) break;
    offset = chunk.next_offset;
  } while (true);
  const items = harnessPortableHistoryItemsSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  assert.equal(items.length, 120);
  assert.equal(items[119]?.type, "message");
  const last = items[119]!;
  assert.equal(last.type === "message" && last.body.storage === "inline" && last.body.value, thread.turns[0]!.items[119]!.text);
  assert.throws(() => store.read("foreign-session", retained.content_id, 0, 10), /another session/);
});

test("unretained large fields report partial fidelity explicitly", () => {
  const history = publicHistory({id: "native", turns: [{id: "turn", status: "completed", items: [{id: "answer", type: "agentMessage", text: "x".repeat(60_000)}]}]}, undefined, undefined, "codex");
  assert.equal(history.turns[0]!.portable_fidelity, "partial");
  const item = history.turns[0]!.portable_items![0]!;
  assert.equal(item.type === "message" && item.body.storage, "unavailable");
});

test("retained value previews preserve Unicode character boundaries", () => {
  const store = new BoundedHarnessContentStore();
  const publish = (value: unknown) => store.publish({session_id: "session", provider_instance_id: "provider", provider_binding_hash: "hash", workspace_id: "workspace", cwd: "/workspace"}, value);
  const item = portableHistoryItem({id: "answer", type: "agentMessage", text: "🙂".repeat(20_000)}, "codex", "fallback", publish)[0]!;
  assert.ok(item.type === "message" && item.body.storage === "reference");
  const preview = item.body.preview!;
  assert.equal(Buffer.from(preview, "utf8").toString("utf8"), preview);
});


test("live Codex tools retain arguments, server identity, failures and result-call correlation", () => {
  const observation = portableItemObservation({id: "native-call", type: "mcpToolCall", server: "catalog", tool: "lookup", status: "failed",
    arguments: {query: "fixture"}, result: {content: [{type: "text", text: "partial result"}]}, error: {message: "fixture failure"}}, "codex",
    {native_reference: "thread", native_item_reference: "native-call", native_call_reference: "native-call", native_execution_reference: "phase"});
  assert.equal(observation.fidelity, "full");
  assert.ok("items" in observation);
  assert.deepEqual(observation.items[0], {id: "native-call", native_item_reference: "native-call", native_call_reference: "native-call", type: "tool_call", status: "failed", tool_name: "lookup", tool_namespace: "catalog", arguments: {storage: "inline", value: {query: "fixture"}}});
  const result = observation.items[1]!;
  assert.equal(result.type, "tool_result");
  assert.ok(result.type === "tool_result" && result.result.storage === "inline");
  assert.equal(result.call_id, "native-call");
  assert.deepEqual(result.result.value, {error: {message: "fixture failure"}, output: {content: [{type: "text", text: "partial result"}]}});
  assert.notEqual(result.id, observation.native_item_reference);
  const dynamic = portableHistoryItem({id: "dynamic", type: "dynamicToolCall", tool: "custom", namespace: "extension", arguments: {}, status: "completed", contentItems: [{type: "inputText", text: "complete"}]}, "codex", "unused");
  assert.deepEqual(dynamic.map(item => item.type), ["tool_call", "tool_result"]);
});

test("live portable bodies retain large arguments and refuse to turn missing arguments into empty input", () => {
  const refs = {native_reference: "thread", native_item_reference: "call"};
  const item = {id: "call", type: "tool_call", tool_name: "Read", arguments: {text: "🙂".repeat(20_000)}};
  const store = new BoundedHarnessContentStore();
  const publish = (value: unknown) => store.publish({session_id: "session", provider_instance_id: "provider", provider_binding_hash: "hash", workspace_id: "workspace", cwd: "/workspace"}, value);
  const retained = portableItemObservation(item, "claude", refs, publish);
  assert.equal(retained.fidelity, "full"); assert.ok("items" in retained);
  assert.ok(retained.items[0]?.type === "tool_call" && retained.items[0].arguments.storage === "reference");
  for (const source of [{...item, arguments: undefined}, item]) {
    const partial = portableItemObservation(source, "claude", refs);
    assert.equal(partial.fidelity, "partial");
    assert.ok("items" in partial && partial.items[0]?.type === "tool_call" && partial.items[0].arguments.storage === "unavailable");
  }
  assert.equal(portableItemObservation({id: "future", type: "future"}, "custom", refs).fidelity, "partial");
});


test("portable history correlates live OpenCode calls while preserving distinct native part identity", () => {
  const rows = portableHistoryItem({id: "part", native_item_reference: "part", native_call_reference: "call", type: "tool_call", tool_name: "custom", arguments: {}, output: "complete", status: "completed"}, "opencode", "unused");
  assert.equal(rows[0]!.id, "call"); assert.equal(rows[0]!.native_item_reference, "part"); assert.equal(rows[0]!.native_call_reference, "call");
  assert.ok(rows[1]!.type === "tool_result"); assert.equal(rows[1]!.call_id, "call"); assert.equal(rows[1]!.native_item_reference, "part");
  assert.notEqual(rows[1]!.id, rows[1]!.native_item_reference);
});
test("fallback display IDs do not become native references and actual Codex tool identity survives history", () => {
  const text = portableHistoryItem({id: "message:0", type: "text", role: "assistant", text: "fixture"}, "claude", "unused")[0]!;
  assert.equal(text.native_item_reference, undefined); assert.equal(text.native_call_reference, undefined);
  const tool = portableHistoryItem({id: "call", type: "dynamicToolCall", tool: "custom", arguments: {}, status: "completed", contentItems: []}, "codex", "unused");
  assert.equal(tool[0]!.native_item_reference, "call"); assert.equal(tool[0]!.native_call_reference, "call");
  assert.ok(tool[1]!.type === "tool_result"); assert.equal(tool[1]!.call_id, "call");
});


test("maximum-size image history hydrates its complete retained attachment through public SDK chunks", async () => {
  const {createHash} = await import("node:crypto");
  const {readHcpContent, resolveHcpHistoryPage} = await import("@harness-control/sdk");
  const store = new BoundedHarnessContentStore();
  const scope = {session_id: "session", provider_instance_id: "provider", provider_binding_hash: "binding", workspace_id: "workspace", cwd: "/workspace"};
  const attachment = {type: "image", url: "data:image/png;base64," + Buffer.alloc(10 * 1024 * 1024, 7).toString("base64")};
  const thread = {id: "native", turns: [{id: "turn", status: "completed", items: [{id: "user", type: "userMessage", content: [{type: "text", text: "Original request"}, attachment]}]}]};
  const originalHash = hash(thread.turns);
  const page = publicHistory(thread, value => store.publish(scope, value), undefined, "codex");
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < 192 * 1024);assert.equal(page.turns[0]?.portable_fidelity, "full");
  const complete = await resolveHcpHistoryPage(page, (reference, options) => readHcpContent(reference,
    async (offset, limit) => store.read("session", reference.content_id, offset, limit), options));
  const row = complete.turns[0]?.portable_items?.find(row => row.item.type === "attachment");
  assert.equal(row?.values.body?.storage, "resolved");
  const value = row?.values.body;
  assert.ok(value?.storage === "resolved");
  assert.equal(createHash("sha256").update(JSON.stringify(value.value)).digest("hex"), createHash("sha256").update(JSON.stringify({kind: "embedded", mime_type: "image/png", data_base64: attachment.url.slice("data:image/png;base64,".length)})).digest("hex"));
  assert.equal(hash(thread.turns), originalHash);
});
