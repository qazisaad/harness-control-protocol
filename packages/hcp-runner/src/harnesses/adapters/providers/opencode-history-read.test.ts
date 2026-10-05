import assert from "node:assert/strict";
import {test} from "node:test";
import {openCodeConversation} from "./opencode-conversation.js";
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
