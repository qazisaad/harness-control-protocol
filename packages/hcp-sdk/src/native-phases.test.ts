import assert from "node:assert/strict";
import {test} from "node:test";
import {projectHcpNativePhases} from "./native-phases.js";
import {hcpHarnessEventPayloadSchema} from "@harness-control/protocol";

const event = (sequence: number, completed = false, overrides: Record<string, unknown> = {}, origin = "original", session = "session") =>
  hcpHarnessEventPayloadSchema.parse({session_id: session, sequence, turn_id: origin, created_at: `2026-10-07T00:00:0${sequence}Z`,
    event_type: completed ? "native.execution.completed" : "native.execution.admitted", data: {source: "native", scope: "root",
      admission_id: "phase-one", native_reference: "native-root", native_execution_reference: "native-one", goal_admission_id: "job",
      ...(completed ? {status: "completed"} : {}), ...overrides}});
test("public native phase projection preserves autonomous phases and original origin independently of application turn completion", () => {
  const inputs = [event(3, true), event(1), event(4, false, {admission_id: "phase-two", native_execution_reference: "native-two"}),
    event(1, false, {}, "foreign", "another-session")];
  const phases = projectHcpNativePhases(inputs, "session", "original");
  assert.deepEqual(phases.map(phase => [phase.admission_id, phase.native_execution_reference, phase.origin_turn_id, phase.status]),
    [["phase-one", "native-one", "original", "completed"], ["phase-two", "native-two", "original", undefined]]);
  assert.equal(phases[0]?.admitted_at, "2026-10-07T00:00:01Z");assert.equal(phases[0]?.completed_at, "2026-10-07T00:00:03Z");
  assert.equal(phases[1]?.completed_at, undefined);assert.deepEqual(projectHcpNativePhases(inputs, "session", "new-root"), []);
});
test("retained terminal-only evidence does not fabricate an admission timestamp or lose completion through later replay", () => {
  const only = projectHcpNativePhases([event(3, true)], "session")[0]!;
  assert.equal(only.admitted_at, undefined);assert.equal(only.status, "completed");
  const replay = projectHcpNativePhases([event(3, true), event(1), event(3, true)], "session");
  assert.equal(replay.length, 1);assert.equal(replay[0]?.status, "completed");
  only.native_execution_reference = "changed";assert.equal(projectHcpNativePhases([event(3, true)], "session")[0]?.native_execution_reference, "native-one");
});
for (const field of ["native_reference", "native_execution_reference", "goal_admission_id", "status", "origin"] as const)
test(`native phase projection refuses conflicting ${field} evidence`, () => {
  const changed = field === "origin" ? event(4, true, {}, "new-root") : event(4, true, {[field]: field === "status" ? "failed" : "changed"});
  assert.throws(() => projectHcpNativePhases([event(3, true), changed], "session"), {name: "HcpNativePhaseConflictError"});
});
test("one native execution cannot become two independent admission identities", () => {
  assert.throws(() => projectHcpNativePhases([event(1), event(2, false, {admission_id: "duplicate-phase"})], "session"),
    {name: "HcpNativePhaseConflictError"});
});
