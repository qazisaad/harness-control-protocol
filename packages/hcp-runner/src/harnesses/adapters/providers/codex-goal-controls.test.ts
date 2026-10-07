import assert from "node:assert/strict";
import {test} from "node:test";
import {tmpdir} from "node:os";
import {controlCodexGoal} from "./codex-goal-controls.js";
import type {CodexGoal} from "./codex-goal.js";

function fixture(goalMutationOrigins = false) {
  let goal: CodexGoal | null = {threadId: "root", createdAt: 100, updatedAt: 100, objective: "Work", status: "active",
    tokensUsed: 10, timeUsedSeconds: 1};
  let fenced = false, wrongGeneration = false, loseAck = false, wrongRoot = false;
  const mutations: string[] = [], origins: unknown[] = [];
  const rpc = {async request(method: string, params: unknown): Promise<unknown> {
    if (method === "thread/read") return {thread: {id: wrongRoot ? "foreign" : "root", cwd: tmpdir()}};
    if (method === "thread/goal/get") return {goal};
    assert.equal(fenced, true, "native mutation must follow the durable command fence");
    mutations.push(method);origins.push((params as {origin?: unknown}).origin);
    if (method === "thread/goal/set") goal = {...goal!, status: "paused", updatedAt: 101, ...(wrongGeneration ? {createdAt: 200} : {})};
    else if (method === "thread/goal/clear") goal = null;
    else assert.fail(method);
    if (loseAck) throw new Error("Lost ACK");
    return {};
  }};
  const input = {rpc, goalMutationOrigins, threadId: "root", cwd: tmpdir(), signal: new AbortController().signal};
  return {input, mutations, origins, fence: () => {fenced = true;}, wrongGeneration: () => {wrongGeneration = true;},
    wrongRoot: () => {wrongRoot = true;}, loseAck: () => {loseAck = true;}};
}
test("goal inspection reports native metadata without acquiring or mutating an execution owner", async () => {
  const f = fixture(); const result = await controlCodexGoal({...f.input, operation: {kind: "goal", action: "read"}});
  assert.equal(result.action, "read"); assert.equal(result.goal?.native_created_at, 100);
  assert.equal(Object.hasOwn(result.goal!, "admission_id"), false); assert.deepEqual(f.mutations, []);
});
test("pause and clear require exact generation, durable intent and native readback", async () => {
  const f = fixture();
  const paused = await controlCodexGoal({...f.input, operation: {kind: "goal", action: "pause", expected_native_created_at: 100}, beginMutation: f.fence});
  assert.equal(paused.action, "pause"); assert.equal(paused.goal?.status, "paused");
  const cleared = await controlCodexGoal({...f.input, operation: {kind: "goal", action: "clear", expected_native_created_at: 100}, beginMutation: f.fence});
  assert.equal(cleared.goal, null); assert.deepEqual(f.mutations, ["thread/goal/set", "thread/goal/clear"]);
});
test("foreign root, stale generation and inspection-only mutation refuse before dispatch", async () => {
  for (const scenario of ["root", "generation", "inspection"] as const) {
    const f = fixture(); if (scenario === "root") f.wrongRoot();
    await assert.rejects(controlCodexGoal({...f.input, operation: {kind: "goal", action: "pause", expected_native_created_at: scenario === "generation" ? 99 : 100},
      ...(scenario !== "inspection" ? {beginMutation: f.fence} : {})}), /original conversation|current native goal|live owner/);
    assert.deepEqual(f.mutations, []);
  }
});
test("changed generation and lost ACK cannot become successful native receipts", async () => {
  for (const scenario of ["generation", "ack"] as const) {
    const f = fixture(); if (scenario === "generation") f.wrongGeneration(); else f.loseAck();
    await assert.rejects(controlCodexGoal({...f.input, operation: {kind: "goal", action: "pause", expected_native_created_at: 100}, beginMutation: f.fence}),
      scenario === "generation" ? /exact native paused goal/ : /Lost ACK/);
    assert.equal(f.mutations.length, 1);
  }
});

test("0.161 host goal pause and clear carry user provenance only after durable authorization", async () => {
  const f = fixture(true);
  await controlCodexGoal({...f.input, operation: {kind: "goal", action: "pause", expected_native_created_at: 100}, beginMutation: f.fence});
  await controlCodexGoal({...f.input, operation: {kind: "goal", action: "clear", expected_native_created_at: 100}, beginMutation: f.fence});
  assert.deepEqual(f.origins, ["user", "user"]);
});
