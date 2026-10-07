import assert from "node:assert/strict";
import {test} from "node:test";
import {projectHcpProposedPlans} from "./proposed-plans.js";

const event = (sequence: number, completed = false, text = "preview", phase = "native-phase", origin = "original", session = "session") => ({
  session_id: session, sequence, turn_id: origin, created_at: "2026-10-07T00:00:00Z",
  event_type: completed ? "turn.proposed.completed" : "turn.proposed.delta",
  data: {item_id: "native-plan", native_execution_reference: phase,
    ...(completed ? {plan: text, status: "completed"} : {delta: text})},
});
test("authoritative native completion replaces a different preview, including an explicitly empty final plan", () => {
  const plans = projectHcpProposedPlans([event(3, true, "actual replacement"), event(1), event(2, false, " draft")], "session");
  assert.equal(plans[0]?.preview, "preview draft");assert.equal(plans[0]?.completed, "actual replacement");assert.equal(plans[0]?.status, "completed");
  assert.equal(projectHcpProposedPlans([event(1), event(2, true, "")], "session")[0]?.completed, "");
  plans[0]!.preview = "changed";assert.equal(projectHcpProposedPlans([event(1)], "session")[0]?.preview, "preview");
});
test("native phase and original origin isolate reused item identifiers and partial slices stay previews", () => {
  const plans = projectHcpProposedPlans([event(1), event(2, true, "phase-two", "another-phase", "another-root"), event(1, true, "foreign", "native-phase", "original", "other-session")], "session");
  assert.equal(plans.length, 2);assert.equal(plans[0]?.status, "preview");assert.equal(plans[0]?.completed, undefined);
  assert.equal(plans[1]?.origin_turn_id, "another-root");assert.equal(projectHcpProposedPlans([event(1)], "session", "another-root").length, 0);
});
test("replays cannot duplicate preview text or change completion, sequence or origin authority", () => {
  assert.equal(projectHcpProposedPlans([event(1), event(1), event(2, true), event(2, true)], "session")[0]?.preview, "preview");
  for (const inputs of [[event(1), event(1, false, "changed")], [event(1), event(2, false, "changed", "native-phase", "changed-origin")],
    [event(1, true), event(2, true, "changed")], [event(1, true), event(2)]])
    assert.throws(() => projectHcpProposedPlans(inputs, "session"), {name: "HcpProposedPlanConflictError"});
});
test("large completed plans keep their scoped content reference and never substitute a preview summary", () => {
  const input = event(1, true) as unknown as {data: Record<string, unknown>};
  const plan = {truncated: true, summary: "preview", content_ref: {content_id: "a".repeat(64), sha256: "a".repeat(64), byte_length: 250_000,
    format: "json", expires_at: "2026-10-08T00:00:00Z"}};
  input.data.plan = plan;
  assert.deepEqual(projectHcpProposedPlans([input], "session")[0]?.completed, plan);
});
test("bounded preview and item registries refuse excessive evidence without creating completion", () => {
  assert.throws(() => projectHcpProposedPlans(Array.from({length: 33}, (_, index) => event(index + 1, false, "x".repeat(32768))), "session"), {name: "HcpProposedPlanConflictError"});
  assert.throws(() => projectHcpProposedPlans(Array.from({length: 129}, (_, index) => event(index + 1, false, "x", `phase-${index}`)), "session"), {name: "HcpProposedPlanConflictError"});
  assert.throws(() => projectHcpProposedPlans(Array(16385).fill(event(1)), "session"), {name: "HcpProposedPlanConflictError"});
});
