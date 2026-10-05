import {test} from "node:test";
import assert from "node:assert/strict";
import {OpenCodeText} from "./opencode-text.js";
import {OpenCodeItems} from "./opencode-items.js";
import type {HarnessAdapterEvent} from "../types.js";
import {hcpHarnessEventPayloadSchema} from "@harness-control/protocol";

const message = (parentID = "prompt") => ({type: "message.updated", properties: {info: {id: "message", sessionID: "session", role: "assistant", parentID}}});
const tool = (status: "pending" | "running" | "completed" | "error", output?: string) => ({type: "message.part.updated", properties: {part: {
  id: "tool", messageID: "message", sessionID: "session", type: "tool", tool: "bash", state: {status, input: {command: "echo hello"}, ...(output !== undefined ? {output} : {})},
}}});
function fixture() {
  const events: HarnessAdapterEvent[] = [];
  const text = new OpenCodeText("session", "prompt", "turn", () => {});
  const items = new OpenCodeItems("session", "turn", id => text.ownsMessage(id), event => events.push(event));
  const observe = (event: Parameters<typeof items.observe>[0]) => {text.observe(event); items.observe(event);};
  return {events, observe};
}

test("OpenCode tool lifecycle is prompt bound and duplicate progress cannot reopen terminal items", () => {
  const f = fixture(); f.observe(message());
  f.observe(tool("pending")); f.observe(tool("running")); f.observe(tool("running"));
  f.observe(tool("completed", "hello")); f.observe(tool("running")); f.observe(tool("completed", "late"));
  assert.deepEqual(f.events.map(event => event.event_type), ["item.started", "item.updated", "item.completed"]);
  assert.equal(f.events.at(-1)?.data.status, "completed");
  assert.match(JSON.stringify(f.events.at(-1)?.data.content), /hello/);
  f.events.forEach((event, sequence) => hcpHarnessEventPayloadSchema.parse({...event, session_id: "session", sequence: sequence + 1, created_at: new Date().toISOString()}));
});

test("OpenCode buffers tool completion until message ownership and ignores foreign roots", () => {
  const owned = fixture(); owned.observe(tool("completed", "hello")); owned.observe(tool("running"));
  assert.equal(owned.events.length, 0);
  owned.observe(message()); assert.deepEqual(owned.events.map(event => event.event_type), ["item.completed"]);
  const foreign = fixture(); foreign.observe(tool("running")); foreign.observe(message("old-prompt")); foreign.observe(tool("completed", "old output"));
  assert.equal(foreign.events.length, 0);
});

test("OpenCode cannot rebind an existing native tool to another assistant message", () => {
  const f = fixture(); f.observe(message()); f.observe(tool("running"));
  const altered = tool("completed"); altered.properties.part.messageID = "other";
  assert.throws(() => f.observe(altered), /changed an admitted tool/);
});
