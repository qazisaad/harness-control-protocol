import assert from "node:assert/strict";
import {test} from "node:test";
import {projectHcpReasoningItems} from "./reasoning-items.js";

const delta = (sequence: number, kind: "summary" | "content" = "summary", index = 0, phase = "phase", origin = "original") => ({
  session_id: "session", sequence, turn_id: origin, created_at: "2026-10-07T00:00:00Z", event_type: "reasoning.delta",
  data: {item_id: "reasoning", native_execution_reference: phase, native_segment: {kind, index}, delta: `${kind}-${index}`},
});
const completed = (sequence: number, content: unknown = {summary: ["Final summary"], content: ["Final content"]}) => ({
  session_id: "session", sequence, turn_id: "original", created_at: "2026-10-07T00:00:01Z", event_type: "item.completed",
  data: {item_id: "reasoning", native_execution_reference: "phase", item_type: "reasoning", ...(content === undefined ? {} : {content})},
});
test("summary/content indexes stay separate and completed native arrays do not come from preview concatenation", () => {
  const items = projectHcpReasoningItems([completed(4), delta(1), delta(2, "content"), delta(3, "summary", 1)], "session");
  assert.equal(items.length, 1);assert.deepEqual(items[0]?.segments.map(segment => [segment.kind, segment.index]), [["summary", 0], ["content", 0], ["summary", 1]]);
  assert.deepEqual(items[0]?.completed_content, {summary: ["Final summary"], content: ["Final content"]});
  assert.equal(items[0]?.completed, true);assert.equal(items[0]?.native_execution_reference, "phase");
});
test("phase and original origin isolate reused native item IDs", () => {
  const items = projectHcpReasoningItems([delta(1), delta(2, "summary", 0, "another-phase", "another-root")], "session");
  assert.equal(items.length, 2);assert.equal(items[1]?.origin_turn_id, "another-root");
  assert.equal(projectHcpReasoningItems([delta(1)], "session", "another-root").length, 0);
  assert.equal(projectHcpReasoningItems([delta(1)], "foreign-session").length, 0);
});
test("native message block completion invents neither an item ID, execution ID nor authoritative final content", () => {
  const part = {message_reference: "actual-message", index: 2};
  const first = {...delta(1), data: {native_part: part, delta: "Native thinking"}};
  const last = {...completed(2), data: {native_part: part, item_type: "reasoning"}};
  const item = projectHcpReasoningItems([first, last], "session")[0]!;
  assert.deepEqual(item.native_part, part);assert.equal(item.item_id, undefined);assert.equal(item.native_execution_reference, undefined);
  assert.equal(item.completed, true);assert.equal(item.completed_content, undefined);assert.equal(item.segments[0]?.text, "Native thinking");
});
test("retained completion-only slices have no invented preview or admission time and return copies", () => {
  const item = projectHcpReasoningItems([completed(2)], "session")[0]!;
  assert.deepEqual(item.segments, []);assert.equal(item.first_observed_at, "2026-10-07T00:00:01Z");
  assert.deepEqual(projectHcpReasoningItems([completed(2, {summary: [], content: []})], "session")[0]?.completed_content, {summary: [], content: []});
  if (item.completed_content && typeof item.completed_content === "object" && "summary" in item.completed_content && Array.isArray(item.completed_content.summary)) item.completed_content.summary.push("changed");
  assert.deepEqual(projectHcpReasoningItems([completed(2)], "session")[0]?.completed_content, {summary: ["Final summary"], content: ["Final content"]});
});
test("exact replays do not duplicate text while conflicts and late deltas refuse", () => {
  assert.equal(projectHcpReasoningItems([delta(1), delta(1), completed(2), completed(2)], "session")[0]?.segments[0]?.text, "summary-0");
  for (const inputs of [[delta(1), delta(1, "content")], [delta(1), delta(2, "summary", 0, "phase", "changed")],
    [completed(1), delta(2)], [completed(1), completed(2, "changed")]])
    assert.throws(() => projectHcpReasoningItems(inputs, "session"), {name: "HcpReasoningProjectionError"});
});
test("deferred completed content preserves its exact reference and cannot be replaced by the summary", () => {
  const content = {truncated: true, summary: "Preview", content_ref: {content_id: "a".repeat(64), sha256: "a".repeat(64), byte_length: 250_000,
    format: "json", expires_at: "2026-10-08T00:00:00Z"}};
  assert.deepEqual(projectHcpReasoningItems([completed(2, content)], "session")[0]?.completed_content, content);
  assert.throws(() => projectHcpReasoningItems([completed(2, {summary: ["Partial native body"]})], "session"), {name: "HcpReasoningProjectionError"});
});
test("unidentified reasoning cannot become a physical item and incompatible pointers refuse", () => {
  assert.deepEqual(projectHcpReasoningItems([{...delta(1), data: {delta: "Unidentified"}}], "session"), []);
  assert.throws(() => projectHcpReasoningItems([{...delta(1), data: {...delta(1).data, native_part: {message_reference: "other", index: 0}}}], "session"), {name: "HcpReasoningProjectionError"});
});
test("bounded item, event and byte registries refuse excessive evidence", () => {
  assert.throws(() => projectHcpReasoningItems(Array.from({length: 129}, (_, index) => delta(index + 1, "summary", 0, `phase-${index}`)), "session"), {name: "HcpReasoningProjectionError"});
  assert.throws(() => projectHcpReasoningItems(Array(16385).fill(delta(1)), "session"), {name: "HcpReasoningProjectionError"});
  assert.throws(() => projectHcpReasoningItems([{...delta(1), data: {...delta(1).data, delta: "x".repeat(8 * 1024 * 1024)}}], "session"), {name: "HcpReasoningProjectionError"});
});


test("native block closure can precede its complete assistant body without reopening reasoning", () => {
  const body = {native_part: {message_reference: "message", index: 0}, item_type: "reasoning"};
  const events = [{...completed(1), data: body}, {...completed(2), data: {...body, content: "Authoritative thinking"}}];
  assert.equal(projectHcpReasoningItems(events, "session")[0]?.completed_content, "Authoritative thinking");
  assert.throws(() => projectHcpReasoningItems([...events, {...completed(3), data: {...body, content: "changed"}}], "session"), {name: "HcpReasoningProjectionError"});
});
