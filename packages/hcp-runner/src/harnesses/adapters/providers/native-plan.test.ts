import assert from "node:assert/strict";
import {test} from "node:test";
import {nativePlanObservation, nativePlanProposalInput} from "./native-plan.js";

test("native snapshots normalize actual statuses and array positions without inventing item IDs", () => {
  const plan = nativePlanObservation("execution_plan", [{step: "Untrimmed  ", status: "inProgress"}, {step: "Second", status: "future"}],
    {observation: "snapshot", native_reference: "native-thread", native_execution_reference: "native-turn"});
  assert.deepEqual(plan, {source: "native", kind: "execution_plan", observation: "snapshot", native_reference: "native-thread", native_execution_reference: "native-turn",
    steps: [{index: 0, text: "Untrimmed  ", status: "running", native_status: "inProgress"}, {index: 1, text: "Second", status: "unknown", native_status: "future"}]});
  assert.deepEqual(nativePlanObservation("todo_list", [], {observation: "snapshot", native_reference: "native-session"})?.steps, []);
});
test("native tool-input todos remain intent and require an actual call identity", () => {
  const rows = [{content: "First", status: "completed", activeForm: "Completing first"}, {content: "Next", status: "cancelled", priority: "high"}];
  const plan = nativePlanObservation("todo_list", rows, {observation: "tool_input", native_reference: "native-session", native_item_reference: "native-call"});
  assert.equal(plan?.observation, "tool_input");assert.equal(plan?.native_item_reference, "native-call");assert.equal(plan?.native_execution_reference, undefined);
  assert.deepEqual(plan?.steps, [{index: 0, text: "First", status: "completed", native_status: "completed", active_form: "Completing first"},
    {index: 1, text: "Next", status: "cancelled", native_status: "cancelled", priority: "high"}]);
  assert.equal(nativePlanObservation("todo_list", rows, {observation: "tool_input", native_reference: "native-session"}), undefined);
});
test("malformed or excessive native arrays do not become partial structured snapshots", () => {
  for (const rows of [[{content: "First", status: "pending"}, {}], [{status: "completed"}], [{content: "First", status: ""}],
    Array.from({length: 4097}, () => ({content: "step", status: "pending"}))])
    assert.equal(nativePlanObservation("todo_list", rows, {observation: "snapshot", native_reference: "native-session"}), undefined);
});
test("large normalized plans retain the full body behind a scoped reference rather than a partial step array", () => {
  const raw = [{content: "😀 native step ".repeat(8000), status: "pending"}], reference = {content_id: "a".repeat(64), sha256: "b".repeat(64),
    byte_length: 1, format: "json" as const, expires_at: "2030-01-01T00:00:00Z"};
  let full: unknown, publications = 0;
  const plan = nativePlanObservation("todo_list", raw, {observation: "snapshot", native_reference: "native-session"}, value => {full = value;publications++;return reference;});
  assert.equal(publications, 1);assert.deepEqual(full, [{index: 0, text: raw[0]!.content, status: "pending", native_status: "pending"}]);
  assert.equal(Array.isArray(plan?.steps), false);assert.ok(plan?.steps && "truncated" in plan.steps && plan.steps.truncated);
});
test("native explanations preserve empty and exact text, retaining large bodies independently of steps", () => {
  const binding = {observation: "snapshot" as const, native_reference: "thread"};
  assert.equal(nativePlanObservation("execution_plan", [], binding)?.explanation, undefined);
  assert.equal(nativePlanObservation("execution_plan", [], {...binding, explanation: ""})?.explanation, "");
  assert.equal(nativePlanObservation("execution_plan", [], {...binding, explanation: " Native explanation  "})?.explanation, " Native explanation  ");
  const text = "😀 explanation ".repeat(8000), reference = {content_id: "a".repeat(64), sha256: "b".repeat(64),
    byte_length: Buffer.byteLength(text), format: "text" as const, expires_at: "2030-01-01T00:00:00Z"};
  let published: unknown;
  const observation = nativePlanObservation("execution_plan", [], {...binding, explanation: text}, value => {published = value;return reference;});
  assert.equal(published, text);assert.deepEqual(observation?.steps, []);
  assert.ok(observation?.explanation && typeof observation.explanation !== "string" && observation.explanation.content_ref?.content_id === reference.content_id);
});

test("proposal input preserves actual empty/body/call observations and never infers an unavailable plan file", () => {
  const binding = {native_reference: "session", native_item_reference: "call", request_reference: "request"};
  assert.equal(nativePlanProposalInput("", binding)?.plan, "");
  assert.deepEqual(nativePlanProposalInput(" Native body  ", binding), {source: "native", observation: "tool_input", ...binding, plan: " Native body  "});
  for (const body of [undefined, null, {filePath: "/native/plan.md"}, ["preview"]]) assert.equal(nativePlanProposalInput(body, binding), undefined);
});
