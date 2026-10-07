import assert from "node:assert/strict";
import {test} from "node:test";
import {createHash} from "node:crypto";
import {type HarnessContentReference} from "@harness-control/protocol";
import {HcpContentReadError, readHcpContent} from "./content.js";
import {projectHcpProposedPlans} from "./proposed-plans.js";
import {projectHcpNativeProposalInputs, projectHcpNativeProposalInputsComplete} from "./native-proposal-inputs.js";
const event = (sequence: number, plan: unknown = " Native plan  ") => ({session_id: "session", turn_id: "original", sequence,
  created_at: "2026-10-07T00:00:00Z", event_type: "turn.proposed.observed", data: {source: "native", observation: "tool_input",
    native_reference: "native-session", native_item_reference: "actual-call", request_reference: "actual-request", plan}});
function fixture() {
  const bodies = new Map<string, Buffer>(), calls: string[] = [];
  const reference = (body: string, format: "text" | "json" = "text"): HarnessContentReference => {
    const bytes = Buffer.from(body), content_id = createHash("sha256").update(String(bodies.size)).digest("hex");bodies.set(content_id, bytes);
    return {content_id, format, byte_length: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), expires_at: "2030-01-01T00:00:00Z"};
  };
  const read: Parameters<typeof projectHcpNativeProposalInputsComplete>[3] = (reference, options) => {
    calls.push(reference.content_id);return readHcpContent(reference, async (offset, limit) => {
      const bytes = bodies.get(reference.content_id)!, end = Math.min(bytes.length, offset + limit);
      return {reference, offset, data_base64: bytes.subarray(offset, end).toString("base64"), ...(end < bytes.length ? {next_offset: end} : {})};
    }, options);
  };
  const retained = (content_ref?: HarnessContentReference) => ({truncated: true, summary: "partial preview", ...(content_ref ? {content_ref} : {})});
  return {reference, read, retained, calls};
}
test("proposal input keeps native intent, call/request/origin and explicit empty body without promotion to completed items", () => {
  const projected = projectHcpNativeProposalInputs([event(2, ""), event(1), event(1)], "session");
  assert.equal(projected.length, 2);assert.equal(projected[0]!.native_proposal.native_item_reference, "actual-call");
  assert.equal(projected[0]!.native_proposal.request_reference, "actual-request");assert.equal(projected[0]!.native_proposal.native_execution_reference, undefined);
  assert.equal(projected[0]!.origin_turn_id, "original");assert.equal(projected[1]!.native_proposal.plan, "");
  assert.deepEqual(projectHcpProposedPlans([event(1)], "session"), []);
  assert.deepEqual(projectHcpNativeProposalInputs([event(1)], "foreign"), []);
  assert.deepEqual(projectHcpNativeProposalInputs([event(1)], "session", "foreign"), []);
  assert.equal(projectHcpNativeProposalInputs([{...event(1), turn_id: undefined}], "session")[0]!.origin_turn_id, undefined);
  projected[0]!.native_proposal.plan = "modified";assert.equal(projectHcpNativeProposalInputs([event(1)], "session")[0]!.native_proposal.plan, " Native plan  ");
});
test("conflicting replay and unbounded proposal-input slices refuse rather than fabricating a combined or completed plan", () => {
  for (const inputs of [[event(1), event(1, "different")], Array.from({length: 129}, (_, i) => event(i + 1)),
    Array.from({length: 16_385}, () => event(1)), [event(1, "x".repeat(8 * 1024 * 1024))]])
    assert.throws(() => projectHcpNativeProposalInputs(inputs, "session"), {name: "HcpNativeProposalInputError"});
});
test("complete proposal-input reader preserves exact retained text and evidence, refusing absent, non-text or corrupt bodies", async () => {
  const f = fixture(), text = "😀 Native tool-input plan  ".repeat(12_000), ref = f.reference(text);
  const [resolved] = await projectHcpNativeProposalInputsComplete([event(1, f.retained(ref))], "session", "original", f.read, {chunkSize: 1024});
  assert.equal(resolved!.plan, text);assert.deepEqual(resolved!.source.native_proposal.plan, f.retained(ref));
  assert.equal(resolved!.source.native_proposal.observation, "tool_input");assert.deepEqual(f.calls, [ref.content_id]);
  for (const body of [f.retained(), f.retained(f.reference('"json text"', "json")), f.retained({...ref, sha256: "b".repeat(64)})])
    await assert.rejects(projectHcpNativeProposalInputsComplete([event(1, body)], "session", undefined, f.read));
});
test("proposal-input decoded output/reference bounds, changed cached identity and cancellation prevent further reads", async () => {
  const f = fixture(), a = f.reference("body"), b = f.reference("next"), repeated = [event(1, f.retained(a)), event(2, f.retained(a))];
  assert.equal((await projectHcpNativeProposalInputsComplete(repeated, "session", undefined, f.read)).length, 2);assert.deepEqual(f.calls, [a.content_id]);
  for (const [inputs, options] of [[repeated, {maxTotalBytes: a.byte_length}], [[event(1, f.retained(a)), event(2, f.retained(b))], {maxReferences: 1}]] as const)
    await assert.rejects(projectHcpNativeProposalInputsComplete(inputs, "session", undefined, f.read, options), error => error instanceof HcpContentReadError && error.reason === "limit");
  await assert.rejects(projectHcpNativeProposalInputsComplete([event(1, f.retained(a)), event(2, f.retained({...a, sha256: "c".repeat(64)}))], "session", undefined, f.read),
    error => error instanceof HcpContentReadError && error.reason === "reference_changed");
  const abort = new AbortController();f.calls.length = 0;
  await assert.rejects(projectHcpNativeProposalInputsComplete([event(1, f.retained(a)), event(2, f.retained(b))], "session", undefined,
    async (reference, options) => {const full = await f.read(reference, options);abort.abort();return full;}, {signal: abort.signal}), /abort/i);
  assert.deepEqual(f.calls, [a.content_id]);
  for (const options of [{maxTotalBytes: 0}, {maxReferences: 0}])
    await assert.rejects(projectHcpNativeProposalInputsComplete([], "session", undefined, f.read, options), error => error instanceof HcpContentReadError && error.reason === "limit");
});
