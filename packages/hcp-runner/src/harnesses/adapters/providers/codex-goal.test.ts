import assert from "node:assert/strict";
import {test} from "node:test";
import {CodexGoalOwner, type CodexGoal} from "./codex-goal.js";

function fixture(goalMutationOrigins = false) {
  let goal: CodexGoal | undefined;
  const calls: string[] = [], evidence: string[] = [], mutations: {method: string; origin?: string}[] = [];
  let activateAck: (() => void) | undefined;
  let delay = false;
  const rpc = {async request(method: string, params: unknown): Promise<unknown> {
    calls.push(method);
    if (["thread/goal/set", "thread/goal/clear"].includes(method)) mutations.push({method, ...params as {origin?: string}});
    const value = params as {threadId: string; objective?: string; status: CodexGoal["status"]; tokenBudget?: number};
    assert.equal(value.threadId, "root");
    if (method === "thread/goal/get") return {goal: goal ? {...goal} : null};
    if (method === "thread/goal/clear") {goal = undefined; return {};}
    assert.equal(method, "thread/goal/set");
    if (!goal) {
      assert.deepEqual(evidence, ["reserve"]);
      assert.equal(value.status, "paused");
      goal = {threadId: "root", objective: value.objective!, status: "paused", createdAt: 100,
        updatedAt: 100, tokensUsed: 0, timeUsedSeconds: 0, ...(value.tokenBudget ? {tokenBudget: value.tokenBudget} : {})};
    } else goal = {...goal, status: value.status, updatedAt: goal.updatedAt + 1};
    if (value.status === "active" && delay) await new Promise<void>(resolve => {activateAck = resolve;});
    return {goal: {...goal}};
  }};
  const owner = new CodexGoalOwner(rpc, "root", {reserve() {evidence.push("reserve");},
    confirm() {evidence.push("confirm");}, updated(goal) {evidence.push(goal.status);}}, goalMutationOrigins);
  return {owner, calls, evidence, mutations, get: () => goal, replace: (replacement: CodexGoal) => {goal = replacement;},
    delay: () => {delay = true;}, acknowledge: () => activateAck!()};
}

test("goal admission is paused and durable before activation; no implicit token budget", async () => {
  const f = fixture();
  const prepared = await f.owner.prepare("Finish the objective", undefined, new AbortController().signal);
  assert.equal(prepared.status, "paused"); assert.equal(prepared.tokenBudget, undefined);
  assert.equal(f.owner.active, false); assert.deepEqual(f.evidence, ["reserve", "confirm"]);
  await f.owner.activate(new AbortController().signal);
  assert.equal(f.owner.active, true);
  await f.owner.pause(); assert.equal(f.owner.active, false); assert.equal(f.get()?.status, "paused");
});

test("cancellation racing the activation ACK immediately pauses the owned native job", async () => {
  const f = fixture(); await f.owner.prepare("Work", 100, new AbortController().signal);
  f.delay(); const activation = f.owner.activate(new AbortController().signal);
  await new Promise(resolve => setImmediate(resolve));
  const stop = f.owner.pause(); assert.equal(f.owner.active, false);
  f.acknowledge(); await Promise.all([activation, stop]);
  assert.equal(f.get()?.status, "paused"); assert.deepEqual(f.evidence, ["reserve", "confirm", "active", "paused"]);
});

test("replacement, modified budget and decreasing native usage never receive an owned mutation", async () => {
  for (const patch of [{createdAt: 101}, {objective: "foreign"}, {tokenBudget: 200}, {updatedAt: 99}]) {
    const f = fixture(); await f.owner.prepare("Work", 100, new AbortController().signal);
    f.replace({...f.get()!, ...patch});
    await assert.rejects(f.owner.activate(new AbortController().signal), /original execution owner/);
    assert.equal(f.calls.filter(call => call === "thread/goal/set").length, 1);
  }
});

test("existing native jobs cannot be silently cleared, adopted or replaced", async () => {
  const f = fixture(); await f.owner.prepare("Work", undefined, new AbortController().signal);
  const other = new CodexGoalOwner({async request() {return {goal: f.get()};}}, "root", {
    reserve() {assert.fail("existing job cannot be admitted");}, confirm() {}, updated() {},
  });
  await assert.rejects(other.prepare("Replacement", undefined, new AbortController().signal), /Clear the existing/);
});

test("goal observations require the original native generation and preserve native terminal reasons", async () => {
  const f = fixture(); await f.owner.prepare("Work", undefined, new AbortController().signal);
  await f.owner.activate(new AbortController().signal);
  assert.equal(f.owner.observe({method: "thread/goal/updated", params: {threadId: "other", goal: {...f.get()!, threadId: "other"}}}), false);
  f.owner.observe({method: "thread/goal/updated", params: {threadId: "root", goal: {...f.get()!, status: "budgetLimited", tokensUsed: 100}}});
  assert.equal(f.owner.active, false); assert.equal(f.owner.goal?.status, "budgetLimited");
  assert.throws(() => f.owner.observe({method: "thread/goal/updated", params: {threadId: "root", goal: {...f.get()!, tokensUsed: 99}}}), /original execution owner/);
  assert.throws(() => f.owner.observe({method: "thread/goal/cleared", params: {threadId: "root"}}), /cleared outside/);
});

test("a lost creation ACK keeps admission uncertain and does not retry or activate", async () => {
  let mutations = 0, reservations = 0;
  const owner = new CodexGoalOwner({async request(method) {
    if (method === "thread/goal/get") return {goal: null};
    mutations++; throw new Error("lost ACK");
  }}, "root", {reserve() {reservations++;}, confirm() {assert.fail();}, updated() {assert.fail();}});
  await assert.rejects(owner.prepare("Work", undefined, new AbortController().signal), /lost ACK/);
  await assert.rejects(owner.activate(new AbortController().signal), /original execution owner/);
  await assert.rejects(owner.prepare("Work", undefined, new AbortController().signal), /original execution owner/);
  assert.equal(mutations, 1); assert.equal(reservations, 1);
});

test("explicit owned clear first pauses activation and accepts only its own clear notification", async () => {
  const f = fixture(); await f.owner.prepare("Work", undefined, new AbortController().signal);
  await f.owner.activate(new AbortController().signal); await f.owner.clear(new AbortController().signal);
  assert.equal(f.get(), undefined); assert.equal(f.owner.goal, undefined); assert.equal(f.owner.active, false);
  assert.equal(f.owner.observe({method: "thread/goal/cleared", params: {threadId: "root"}}), true);
  assert.deepEqual(f.evidence, ["reserve", "confirm", "active", "paused"]);
});

for (const status of ["paused", "blocked", "budgetLimited", "usageLimited"] as const)
test(`explicit resume preserves the requested native generation and usage (${status})`, async () => {
  const f = fixture();
  const retained = {threadId: "root", objective: "Retained objective", status, createdAt: 100, updatedAt: 101,
    tokensUsed: 75, timeUsedSeconds: 20, tokenBudget: 100};
  f.replace(retained);
  const goal = await f.owner.prepareResume(100, new AbortController().signal);
  assert.equal(goal.status, "paused"); assert.equal(goal.objective, retained.objective);
  assert.equal(goal.tokensUsed, 75); assert.equal(goal.tokenBudget, 100);
  assert.equal(f.evidence[0], "reserve");
  await f.owner.activate(new AbortController().signal);
  assert.equal(f.owner.goal?.createdAt, 100); assert.equal(f.owner.goal?.tokensUsed, 75);
});

test("resume refuses missing, replaced, active and completed jobs before admission or mutation", async () => {
  for (const patch of [undefined, {createdAt: 200}, {status: "active" as const}, {status: "complete" as const}]) {
    const f = fixture();
    if (patch) f.replace({threadId: "root", objective: "Goal", status: "paused", createdAt: 100, updatedAt: 100,
      tokensUsed: 0, timeUsedSeconds: 0, ...patch});
    await assert.rejects(f.owner.prepareResume(100, new AbortController().signal), /inactive, unfinished/);
    assert.deepEqual(f.evidence, []); assert.deepEqual(f.calls, ["thread/goal/get"]);
  }
});

test("completion or limits before initial activation never restart the native job", async () => {
  for (const status of ["complete", "blocked", "budgetLimited", "usageLimited"] as const) {
    const f = fixture(); await f.owner.prepare("Goal", 100, new AbortController().signal);
    f.replace({...f.get()!, status, updatedAt: 101, tokensUsed: 20});
    await f.owner.activate(new AbortController().signal);
    assert.equal(f.owner.active, false); assert.equal(f.owner.goal?.status, status);
    assert.equal(f.calls.filter(call => call === "thread/goal/set").length, 1);
  }
});

test("0.161 goal mutations retain explicit user intent while cleanup remains automatic", async () => {
  for (const supported of [false, true]) {
    const f = fixture(supported), signal = new AbortController().signal;
    await f.owner.prepare("Work", undefined, signal);await f.owner.activate(signal);
    await f.owner.pause();await f.owner.pause(true, "user");await f.owner.clear(signal);
    assert.deepEqual(f.mutations.map(value => value.origin), supported ? ["user", "user", "automatic", "user"] : [undefined, undefined, undefined, undefined]);
    assert.equal(f.get(), undefined);
    const explicit = fixture(supported);await explicit.owner.prepare("Work", undefined, signal);await explicit.owner.activate(signal);await explicit.owner.pause(true, "user");
    assert.deepEqual(explicit.mutations.map(value => value.origin), supported ? ["user", "user", "user"] : [undefined, undefined, undefined]);
  }
});
