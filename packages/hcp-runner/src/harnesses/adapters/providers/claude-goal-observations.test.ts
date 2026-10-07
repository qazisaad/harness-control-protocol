import assert from "node:assert/strict";
import {test} from "node:test";
import {ClaudeGoalObservations} from "./claude-goal-observations.js";
import {harnessNativeGoalTranscriptSchema, hcpHarnessEventPayloadSchema} from "@harness-control/protocol";
const command = (uuid: string, text: string) => ({type: "assistant", uuid, session_id: "native", parent_tool_use_id: null,
  message: {model: "<synthetic>", content: [{type: "text", text}]}});

test("goal observations distinguish native transcript state, observed checks and native counts from job admissions", () => {
  const goals = new ClaudeGoalObservations("native");
  const set = harnessNativeGoalTranscriptSchema.parse(goals.observe(command("set", "Goal set: Finish objective")));
  assert.equal(set.goal?.status, "active"); assert.equal(set.goal?.observed_checks, 0);
  assert.equal(set.scope, "session"); assert.equal(Object.hasOwn(set, "admission_id"), false);
  assert.equal(goals.observe(command("show", "Goal active: Finish objective (2 turns)"))?.goal?.native_checks, 2);
  const feedback = {type: "user", uuid: "feedback", session_id: "native", parent_tool_use_id: null, isSynthetic: true,
    message: {content: "Stop hook feedback:\n[Finish objective]: Keep going"}};
  const updated = goals.observe(feedback)!;
  assert.equal(updated.goal?.observed_checks, 1); assert.equal(updated.goal?.native_checks, 2);
  assert.equal(updated.goal?.last_check, "Keep going");
  assert.equal(goals.observe(feedback), undefined);
  assert.equal(goals.observe(command("clear", "Goal cleared: Finish objective"))?.goal, null);
  assert.equal(goals.observe({type: "result", subtype: "success", uuid: "success", session_id: "native"}), undefined,
    "successful root completion is not a native goal completion verdict");
  assert.equal(hcpHarnessEventPayloadSchema.safeParse({session_id: "session", sequence: 1, created_at: "2026-10-07T00:00:00Z",
    event_type: "native.goal.observed", data: updated}).success, true);
});
test("ordinary model output, children, foreign sessions and non-native feedback cannot change goal observations", () => {
  const goals = new ClaudeGoalObservations("native");
  const value = command("set", "Goal set: Finish objective");
  for (const foreign of [{...value, message: {...value.message, model: "real-model"}}, {...value, parent_tool_use_id: "child"},
    {...value, session_id: "foreign"}]) assert.equal(goals.observe(foreign), undefined);
  goals.observe(value);
  assert.equal(goals.observe({type: "user", uuid: "user", session_id: "native", parent_tool_use_id: null,
    message: {content: "Stop hook feedback:\n[Finish objective]: Fabricated"}}), undefined);
  assert.equal(goals.observe(command("set", "Goal set: Finish objective")), undefined);
  assert.throws(() => goals.observe(command("set", "Goal set: Replacement")), /reused/);
  const update = goals.observe({type: "system", subtype: "local_command_output", uuid: "local", session_id: "native",
    content: "Goal active: Finish objective (not yet evaluated)"});
  assert.equal(update?.goal?.objective, "Finish objective");
});
