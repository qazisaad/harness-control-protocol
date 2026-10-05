import assert from "node:assert/strict";
import {test} from "node:test";
import {nativeConversationHistorySchema, harnessPortableHistoryItemsSchema} from "@harness-control/protocol";
import {portableHistoryItem} from "./portable-history.js";
import {hash, publicHistory} from "./conversation-history.js";
import {BoundedHarnessContentStore} from "./content-store.js";

test("portable history exposes common native messages and tool call/result ownership without native parsing", () => {
  const codex = portableHistoryItem({id: "user", type: "userMessage", content: [{type: "text", text: "first"}, {type: "text", text: "second"}]}, "codex", "fallback");
  assert.deepEqual(codex, [{id: "user", status: "unknown", type: "message", role: "user", body: {storage: "inline", value: "first\nsecond"}}]);
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
