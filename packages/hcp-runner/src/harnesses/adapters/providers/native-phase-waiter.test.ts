import assert from "node:assert/strict";
import {test} from "node:test";
import {NativePhaseWaiter} from "./native-phase-waiter.js";

test("between-phase waits resolve only from the next owned admission", async () => {
  const phases = new NativePhaseWaiter(), signal = new AbortController().signal;
  phases.admit("first"); assert.equal(await phases.wait(signal), "first");
  phases.completed("foreign"); assert.equal(await phases.wait(signal), "first");
  phases.completed("first");
  let settled = false; const next = phases.wait(signal).then(reference => {settled = true; return reference;});
  await Promise.resolve(); assert.equal(settled, false);
  phases.admit("second"); assert.equal(await next, "second");
  phases.close(); await assert.rejects(phases.wait(signal), /settled/);
});
test("cancelled and closed phase waits never reopen callbacks or leak into a later phase", async () => {
  const phases = new NativePhaseWaiter(), cancellation = new AbortController();
  const pending = phases.wait(cancellation.signal); cancellation.abort(new Error("Cancelled"));
  await assert.rejects(pending, /Cancelled/);
  const ownerLost = phases.wait(new AbortController().signal); phases.close(new Error("Owner lost"));
  await assert.rejects(ownerLost, /Owner lost/); assert.throws(() => phases.admit("unowned"), /Owner lost/);
});
