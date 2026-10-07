import assert from "node:assert/strict";
import {test} from "node:test";
import {ClaudeTextParts, claudeCompletedTextParts} from "./claude-text-parts.js";
import {harnessTextDeltaEventDataSchema} from "@harness-control/protocol";
const start = (id: string) => ({type: "message_start", message: {id}});
const block = (index: number, kind: string, text: string) => ({type: "content_block_start", index, content_block: {type: kind, [kind]: text}});
const change = (index: number, kind: string, text: string) => ({type: "content_block_delta", index, delta: {type: `${kind}_delta`, [kind]: text}});
test("Claude native text preserves initial content and distinct physical message/block positions", () => {
  const parts = new ClaudeTextParts(); parts.observe(start("native-message"));
  const initial = parts.observe(block(0, "thinking", "Initial thought"))!;
  assert.equal(initial.delta, "Initial thought");
  assert.deepEqual(initial.native_part, {message_reference: "native-message", index: 0});
  const {kind, ...data} = parts.observe(change(0, "thinking", " continuation"))!;
  assert.equal(kind, "thinking"); harnessTextDeltaEventDataSchema.parse(data);
  assert.equal(Object.hasOwn(data, "item_id"), false);
  const second = parts.observe(block(1, "text", "Answer"))!;
  assert.equal(second.native_part?.index, 1);
  parts.observe(start("next-native-message"));
  assert.equal(parts.observe(block(0, "thinking", "Next thought"))?.native_part?.message_reference, "next-native-message");
});
test("missing anchors remain unattributed and contradictory native block frames refuse", () => {
  const parts = new ClaudeTextParts();
  assert.equal(parts.observe(change(0, "text", "Unanchored"))?.native_part, undefined);
  parts.observe(start("native"));
  assert.equal(parts.observe(block(0, "thinking", ""))?.state, "started");
  assert.throws(() => parts.observe(change(0, "text", "Wrong kind")), /block kind/);
  const completed = parts.observe({type: "content_block_stop", index: 0});
  assert.deepEqual(completed, {kind: "thinking", state: "completed", message_id: "native", native_part: {message_reference: "native", index: 0}});
  assert.equal(parts.observe({type: "content_block_stop", index: 0}), undefined);
  assert.throws(() => parts.observe(change(0, "thinking", "Late")), /closure/);
  parts.observe({type: "message_stop"});
  assert.equal(parts.observe(change(0, "text", "No anchor"))?.native_part, undefined);
});


test("complete Claude assistant bodies preserve actual block positions, empty text and thinking without fake item IDs", () => {
  const parts = claudeCompletedTextParts({id: "native-message", content: [{type: "text", text: ""}, {type: "tool_use", id: "tool", name: "Read", input: {}}, {type: "thinking", thinking: "Native thought"}, {type: "redacted_thinking", data: "opaque"}]});
  assert.deepEqual(parts.map(part => [part.native_part.index, part.item_type, part.content]), [[0, "text", ""], [2, "reasoning", "Native thought"]]);
  assert.equal(Object.hasOwn(parts[0]!, "item_id"), false);
  assert.deepEqual(claudeCompletedTextParts({content: [{type: "text", text: "missing native anchor"}]}), []);
});
test("large complete Claude text retains its own scoped body instead of a streamed preview", () => {
  const bodies: unknown[] = [];
  const content = "🙂".repeat(20_000), ref = {content_id: "a".repeat(64), sha256: "b".repeat(64), byte_length: Buffer.byteLength(content), format: "text" as const, expires_at: "2030-01-01T00:00:00Z"};
  const [part] = claudeCompletedTextParts({id: "message", content: [{type: "text", text: content}]}, value => {bodies.push(value);return ref;});
  assert.deepEqual(bodies, [content]); assert.deepEqual(part?.native_part, {message_reference: "message", index: 0});
  assert.deepEqual((part?.content as {content_ref: unknown}).content_ref, ref);
});
