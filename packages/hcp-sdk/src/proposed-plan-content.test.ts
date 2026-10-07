import assert from "node:assert/strict";
import {test} from "node:test";
import {createHash} from "node:crypto";
import type {HarnessContentReference} from "@harness-control/protocol";
import {readHcpContent, HcpContentReadError} from "./content.js";
import {projectHcpProposedPlansComplete} from "./proposed-plans.js";

const event = (sequence: number, plan: unknown, item = `actual-${sequence}`) => ({session_id: "session", turn_id: "original", sequence,
  created_at: "2026-10-07T00:00:00Z", event_type: "turn.proposed.completed", data: {item_id: item, native_execution_reference: "actual-phase", plan, status: "completed"}});
function fixture() {
  const bodies = new Map<string, Buffer>(), calls: string[] = [];
  const reference = (body: string, format: "text" | "json" = "text"): HarnessContentReference => {
    const bytes = Buffer.from(body), content_id = createHash("sha256").update(String(bodies.size)).digest("hex");bodies.set(content_id, bytes);
    return {content_id, format, byte_length: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), expires_at: "2030-01-01T00:00:00Z"};
  };
  const read: Parameters<typeof projectHcpProposedPlansComplete>[3] = (reference, options) => {
    calls.push(reference.content_id);return readHcpContent(reference, async (offset, limit) => {
      const bytes = bodies.get(reference.content_id)!, end = Math.min(bytes.length, offset + limit);
      return {reference, offset, data_base64: bytes.subarray(offset, end).toString("base64"), ...(end < bytes.length ? {next_offset: end} : {})};
    }, options);
  };
  const retained = (content_ref?: HarnessContentReference) => ({truncated: true, summary: "partial preview", ...(content_ref ? {content_ref} : {})});
  return {reference, read, retained, calls};
}
test("complete proposed plans preserve actual item, phase, origin and retained evidence while decoding exact unicode text", async () => {
  const f = fixture(), text = "😀 authoritative plan  ".repeat(12_000), ref = f.reference(text);
  const preview = {...event(1, ""), event_type: "turn.proposed.delta", data: {item_id: "actual-plan", native_execution_reference: "actual-phase", delta: "different preview"}};
  const [resolved] = await projectHcpProposedPlansComplete([preview, event(2, f.retained(ref), "actual-plan")], "session", "original", f.read, {chunkSize: 1024});
  assert.equal(resolved!.completed_plan, text);assert.equal(resolved!.source.preview, "different preview");
  assert.deepEqual(resolved!.source.completed, f.retained(ref));assert.equal(resolved!.source.item_id, "actual-plan");
  assert.equal(resolved!.source.native_execution_reference, "actual-phase");assert.equal(resolved!.source.origin_turn_id, "original");
  assert.deepEqual(f.calls, [ref.content_id]);assert.deepEqual(await projectHcpProposedPlansComplete([event(1, text)], "other", undefined, f.read), []);
});
test("preview-only and explicitly empty native completion remain distinct; unavailable or corrupt bodies cannot fall back to previews", async () => {
  const f = fixture(), ref = f.reference("native");
  const preview = {...event(1, ""), event_type: "turn.proposed.delta", data: {item_id: "preview", native_execution_reference: "actual-phase", delta: "draft"}};
  const result = await projectHcpProposedPlansComplete([preview, event(2, "")], "session", undefined, f.read);
  assert.equal(result[0]!.completed_plan, undefined);assert.equal(result[1]!.completed_plan, "");
  for (const body of [f.retained(), f.retained(f.reference('"json text"', "json")), f.retained({...ref, sha256: "b".repeat(64)})])
    await assert.rejects(projectHcpProposedPlansComplete([event(1, body)], "session", undefined, f.read));
});
test("proposed-plan output budgets count cached duplicates and reject changed references and oversized custom-reader output", async () => {
  const f = fixture(), a = f.reference("body"), b = f.reference("next"), repeated = [event(1, f.retained(a)), event(2, f.retained(a))];
  assert.equal((await projectHcpProposedPlansComplete(repeated, "session", undefined, f.read)).length, 2);assert.deepEqual(f.calls, [a.content_id]);
  for (const [inputs, options] of [[repeated, {maxTotalBytes: a.byte_length}], [[event(1, f.retained(a)), event(2, f.retained(b))], {maxReferences: 1}]] as const)
    await assert.rejects(projectHcpProposedPlansComplete(inputs, "session", undefined, f.read, options), error => error instanceof HcpContentReadError && error.reason === "limit");
  await assert.rejects(projectHcpProposedPlansComplete([event(1, f.retained(a)), event(2, f.retained({...a, sha256: "c".repeat(64)}))], "session", undefined, f.read),
    error => error instanceof HcpContentReadError && error.reason === "reference_changed");
  await assert.rejects(projectHcpProposedPlansComplete([event(1, f.retained(a))], "session", undefined,
    async reference => ({reference, format: "text", text: "oversized output"})), error => error instanceof HcpContentReadError && error.reason === "limit");
});
test("cancellation stops subsequent proposed-plan reads and invalid bounds refuse even an empty slice", async () => {
  const f = fixture(), a = f.reference("first"), b = f.reference("next"), abort = new AbortController();
  await assert.rejects(projectHcpProposedPlansComplete([event(1, f.retained(a)), event(2, f.retained(b))], "session", undefined,
    async (reference, options) => {const full = await f.read(reference, options);abort.abort();return full;}, {signal: abort.signal}), /abort/i);
  assert.deepEqual(f.calls, [a.content_id]);
  for (const options of [{maxTotalBytes: 0}, {maxReferences: 0}, {maxReferences: 129}])
    await assert.rejects(projectHcpProposedPlansComplete([], "session", undefined, f.read, options), error => error instanceof HcpContentReadError && error.reason === "limit");
});
