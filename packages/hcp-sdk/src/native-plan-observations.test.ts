import {test} from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import type {HarnessContentReference} from "@harness-control/protocol";
import {readHcpContent, HcpContentReadError} from "./content.js";
import {projectHcpNativePlanObservations, projectHcpNativePlanObservationsComplete} from "./native-plan-observations.js";

const step = {index: 0, text: "Native todo", status: "running", native_status: "in_progress"};
const event = (sequence: number, observation = "snapshot", body: unknown = [step]) => ({session_id: "session", turn_id: "original", sequence,
  created_at: "2026-10-07T00:00:00Z", event_type: "turn.plan.updated", data: {native_plan: {source: "native", observation, kind: "todo_list",
    native_reference: "native-session", ...(observation === "tool_input" ? {native_item_reference: "actual-call"} : {}), steps: body}}});
function fixture() {
  const objects = new Map<string, Buffer>(), calls: string[] = [];
  const reference = (body: unknown, format: "json" | "text" = "json"): HarnessContentReference => {
    const bytes = Buffer.from(format === "json" ? JSON.stringify(body) : String(body)), content_id = createHash("sha256").update(String(objects.size)).digest("hex");
    objects.set(content_id, bytes);return {content_id, format, byte_length: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), expires_at: "2030-01-01T00:00:00Z"};
  };
  const read: Parameters<typeof projectHcpNativePlanObservationsComplete>[3] = (reference, options) => {
    calls.push(reference.content_id);return readHcpContent(reference, async (offset, limit) => {
      const bytes = objects.get(reference.content_id)!, end = Math.min(bytes.length, offset + limit);
      return {reference, offset, data_base64: bytes.subarray(offset, end).toString("base64"), ...(end < bytes.length ? {next_offset: end} : {})};
    }, options);
  };
  const retained = (content_ref: HarnessContentReference) => ({truncated: true, summary: "preview", content_ref});
  return {reference, read, retained, calls};
}
test("native snapshots and tool-input intent preserve actual identities, origin and empty state without fake closure", () => {
  const sources = projectHcpNativePlanObservations([event(2, "tool_input"), event(1), event(3, "snapshot", [])], "session");
  assert.deepEqual(sources.map(source => [source.event_sequence, source.native_plan.observation]), [[1, "snapshot"], [2, "tool_input"], [3, "snapshot"]]);
  assert.equal(sources[0]!.native_plan.native_item_reference, undefined);assert.equal(sources[1]!.native_plan.native_item_reference, "actual-call");
  assert.equal(sources[1]!.native_plan.native_execution_reference, undefined);assert.equal(sources[1]!.origin_turn_id, "original");
  assert.deepEqual(sources[2]!.native_plan.steps, []);
  assert.equal(projectHcpNativePlanObservations([event(1)], "foreign").length, 0);assert.equal(projectHcpNativePlanObservations([event(1)], "session", "foreign").length, 0);
  const noOrigin = {...event(1), turn_id: undefined};assert.equal(projectHcpNativePlanObservations([noOrigin], "session")[0]!.origin_turn_id, undefined);
});
test("exact replay remains one observation and legacy, conflicting or partial-index evidence cannot become a native snapshot", () => {
  assert.equal(projectHcpNativePlanObservations([event(1), event(1)], "session").length, 1);
  assert.deepEqual(projectHcpNativePlanObservations([{...event(1), data: {plan: [{content: "legacy", status: "pending"}]}}], "session"), []);
  for (const sources of [[event(1), event(1, "tool_input")], [event(1, "snapshot", [{...step, index: 1}])],
    [event(1, "snapshot", [step, step])]]) assert.throws(() => projectHcpNativePlanObservations(sources, "session"), {name: "HcpNativePlanObservationError"});
});
test("bounded native observations return copies and preserve unknown statuses instead of inventing pending state", () => {
  const source = event(1, "snapshot", [{...step, status: "unknown", native_status: "native-future"}]);
  const projected = projectHcpNativePlanObservations([source], "session");
  assert.equal(Array.isArray(projected[0]!.native_plan.steps) && projected[0]!.native_plan.steps[0]!.status, "unknown");
  projected[0]!.native_plan.native_reference = "changed";assert.equal(projectHcpNativePlanObservations([source], "session")[0]!.native_plan.native_reference, "native-session");
  for (const sources of [Array.from({length: 129}, (_, index) => event(index + 1)), Array.from({length: 16_385}, () => event(1)),
    [event(1, "snapshot", [{...step, text: "x".repeat(8 * 1024 * 1024)}])]])
    assert.throws(() => projectHcpNativePlanObservations(sources, "session"), {name: "HcpNativePlanObservationError"});
});
test("complete plan observation hydration verifies large unicode arrays while retaining tool-input semantics", async () => {
  const f = fixture(), body = [{...step, text: "😀 native todo ".repeat(12_000)}], reference = f.reference(body);
  const [resolved] = await projectHcpNativePlanObservationsComplete([event(1, "tool_input", f.retained(reference))], "session", "original", f.read, {chunkSize: 1024});
  assert.deepEqual(resolved!.steps, body);assert.deepEqual(resolved!.source.native_plan.steps, f.retained(reference));
  assert.equal(resolved!.source.native_plan.observation, "tool_input");assert.deepEqual(f.calls, [reference.content_id]);
});
test("invalid or corrupt normalized bodies cannot replace source references with preview steps", async () => {
  const f = fixture(), a = f.reference([step]);
  for (const body of [{truncated: true, summary: "missing"}, f.retained(f.reference([{...step, index: 3}])), f.retained(f.reference("not an array", "text"))])
    await assert.rejects(projectHcpNativePlanObservationsComplete([event(1, "snapshot", body)], "session", undefined, f.read), {name: "HcpNativePlanObservationError"});
  await assert.rejects(projectHcpNativePlanObservationsComplete([event(1, "snapshot", f.retained({...a, sha256: "b".repeat(64)}))], "session", undefined, f.read), error => error instanceof HcpContentReadError && error.reason === "integrity");
});
test("decoded duplicate output, reference limits and cancellation stay bounded independently of cached I/O", async () => {
  const f = fixture(), a = f.reference([step]), b = f.reference([{...step, text: "Another"}]);
  const repeated = [event(1, "snapshot", f.retained(a)), event(2, "snapshot", f.retained(a))];
  assert.equal((await projectHcpNativePlanObservationsComplete(repeated, "session", undefined, f.read)).length, 2);assert.deepEqual(f.calls, [a.content_id]);
  await assert.rejects(projectHcpNativePlanObservationsComplete(repeated, "session", undefined, f.read, {maxTotalBytes: a.byte_length}), error => error instanceof HcpContentReadError && error.reason === "limit");
  const inputs = [event(1, "snapshot", f.retained(a)), event(2, "snapshot", f.retained(b))];
  await assert.rejects(projectHcpNativePlanObservationsComplete(inputs, "session", undefined, f.read, {maxReferences: 1}), error => error instanceof HcpContentReadError && error.reason === "limit");
  const abort = new AbortController();f.calls.length = 0;
  await assert.rejects(projectHcpNativePlanObservationsComplete(inputs, "session", undefined,
    async (reference, options) => {const full = await f.read(reference, options);abort.abort();return full;}, {signal: abort.signal}), /abort/i);
  assert.deepEqual(f.calls, [a.content_id]);
});
test("explanations retain source evidence and hydrate exact large text with shared output and reference budgets", async () => {
  const f = fixture(), text = " 😀 native explanation  ".repeat(5000), ref = f.reference(text, "text");
  const withExplanation = (sequence: number, explanation: unknown) => {
    const e = event(sequence);return {...e, data: {native_plan: {...e.data.native_plan, explanation}}};
  };
  const inputs = [event(1), withExplanation(2, ""), withExplanation(3, f.retained(ref))];
  const results = await projectHcpNativePlanObservationsComplete(inputs, "session", undefined, f.read, {chunkSize: 1024});
  assert.equal(results[0]!.explanation, undefined);assert.equal(results[1]!.explanation, "");
  assert.equal(results[2]!.explanation, text);assert.deepEqual(results[2]!.source.native_plan.explanation, f.retained(ref));
  await assert.rejects(projectHcpNativePlanObservationsComplete(inputs, "session", undefined, f.read, {maxTotalBytes: ref.byte_length}),
    error => error instanceof HcpContentReadError && error.reason === "limit");
  const bothRefs = {...withExplanation(1, f.retained(ref)), data: {native_plan: {...event(1).data.native_plan,
    steps: f.retained(f.reference([step])), explanation: f.retained(ref)}}};
  await assert.rejects(projectHcpNativePlanObservationsComplete([bothRefs], "session", undefined, f.read, {maxReferences: 1}),
    error => error instanceof HcpContentReadError && error.reason === "limit");
  for (const body of [{truncated: true, summary: "missing"}, f.retained(f.reference([step])), f.retained({...ref, sha256: "c".repeat(64)})])
    await assert.rejects(projectHcpNativePlanObservationsComplete([withExplanation(1, body)], "session", undefined, f.read));
});
