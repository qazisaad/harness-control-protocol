import assert from "node:assert/strict";
import {test} from "node:test";
import {openCodeConversation, readOpenCodeOwnedHistory} from "./opencode-conversation.js";
import type {HarnessAdapterConversationInput} from "../types.js";
import type {OpenCodeRuntime} from "./opencode.js";

test("OpenCode live history rejects changing native snapshots without publishing a page or modifying state", async () => {
  let reads = 0;
  const runtime = {readHistory: async () => [{info: {id: "message", sessionID: "native", role: "user"},
    parts: [{id: "part", sessionID: "native", messageID: "message", type: "text", text: `Revision ${++reads}`}]}]} as unknown as OpenCodeRuntime;
  const input = {commandId: "read", request: {session_id: "session", operation: {kind: "read"}},
    conversation: {native_thread_id: "native"},
    publishContent: () => {throw new Error("An unstable page cannot publish content");},
    save: () => {throw new Error("Read cannot modify retained state");}} as unknown as HarnessAdapterConversationInput;
  await assert.rejects(openCodeConversation(input, runtime), /changed during the snapshot/);
  assert.equal(reads, 2);
});

for (const mode of ["stable", "changed", "foreign-session", "foreign-part"] as const)
test(`owned OpenCode child snapshots validate every native message and part (${mode})`, async () => {
  let reads = 0;
  const messages = async () => {
    reads++;
    return [{info: {id: "message", sessionID: mode === "foreign-session" ? "foreign" : "child", role: "user"},
      parts: [{id: "part", sessionID: "child", messageID: mode === "foreign-part" ? "foreign" : "message", type: "text",
        text: mode === "changed" ? `Revision ${reads}` : "Owned input"}]}];
  };
  const read = () => readOpenCodeOwnedHistory(messages, "child", new AbortController().signal, {limit: 1});
  if (mode === "stable") {
    const history = await read();
    assert.equal(history.turn_count, 1);
    assert.equal(history.turns[0]!.items[0]!.text, "Owned input");
    assert.equal(history.turns[0]!.portable_items?.length, 1);
    assert.equal(reads, 2);
  } else await assert.rejects(read(), mode === "changed" ? /changed during/ : /another/);
  const before = reads;
  await assert.rejects(readOpenCodeOwnedHistory(messages, "child", AbortSignal.abort(new Error("read abandoned")), {}), /abandoned/);
  assert.equal(reads, before);
});


test("owned OpenCode native media uses portable source fields and actual native part identity", async () => {
  const messages = async () => [{info: {id: "message", sessionID: "child", role: "user"}, parts: [
    {id: "actual-part", sessionID: "child", messageID: "message", type: "file", mime: "image/png", filename: "Observed.png", url: "data:image/png;base64,AQID"}]}];
  const history = await readOpenCodeOwnedHistory(messages, "child", new AbortController().signal, {});
  const item = history.turns[0]!.portable_items![0]!;
  assert.equal(item.type, "attachment");assert.equal(item.native_item_reference, "actual-part");
  assert.deepEqual(item.type === "attachment" && item.body.storage === "inline" && item.body.value,
    {kind: "embedded", mime_type: "image/png", filename: "Observed.png", data_base64: "AQID"});
});
