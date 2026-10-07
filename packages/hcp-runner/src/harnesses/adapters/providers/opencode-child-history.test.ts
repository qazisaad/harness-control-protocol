import assert from "node:assert/strict";
import {test} from "node:test";
import {tmpdir} from "node:os";
import {openCodeChildHistoryView} from "./opencode-child-history.js";

const custody = {source: "opencode", work_id: "work", native_reference: "child", origin_turn_id: "turn",
  root_native_reference: "root", parent_native_reference: "root", launch_native_reference: "launch"};
function fixture() {
  const records = new Map<string, {id: string; directory: string; permission: string[]; parentID?: string}>([
    ["root", {id: "root", directory: tmpdir(), permission: ["root-policy"]}],
    ["child", {id: "child", directory: tmpdir(), permission: ["child-policy"], parentID: "root"}],
  ]);
  const reads: string[] = [], writes: string[] = [];
  let target = "fork", closed = false, failPolicy = false;
  const controller = new AbortController();
  const transport = {
    isClosed: () => closed,
    metadata: async (id: string) => records.get(id),
    messages: async (id: string) => {reads.push(id); return [];},
    fork: async (id: string, before?: string) => {
      writes.push(`fork:${id}:${before ?? "all"}`);
      if (!records.has(target)) records.set(target, {id: target, directory: tmpdir(), permission: ["child-policy"]});
      return target;
    },
    configureFork: async (id: string) => {writes.push(`policy:${id}`); if (!failPolicy) records.get(id)!.permission = ["root-policy"];},
    verifyPermissions: (permission: unknown) => assert.deepEqual(permission, ["root-policy"]),
  };
  return {records, reads, writes, controller,
    view: () => openCodeChildHistoryView(custody, tmpdir(), controller.signal, transport),
    setTarget: (id: string) => {target = id;}, close: () => {closed = true;}, badPolicy: () => {failPolicy = true;}};
}

test("retained child inspection never changes source permissions or admits arbitrary sessions", async () => {
  const f = fixture(), view = await f.view();
  await view.readHistory("child");
  await assert.rejects(view.readHistory("root"), /arbitrary/);
  await assert.rejects(view.readHistory("foreign"), /arbitrary/);
  assert.deepEqual(f.reads, ["child"]);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.records.get("child")!.permission, ["child-policy"]);
});

test("child fork admits only an independent destination with verified original root policy", async () => {
  const f = fixture(), view = await f.view();
  assert.equal(await view.forkHistory("boundary"), "fork");
  await view.readHistory("fork");
  assert.deepEqual(f.writes, ["fork:child:boundary", "policy:fork"]);
  assert.deepEqual(f.records.get("child")!.permission, ["child-policy"]);
  f.records.get("fork")!.permission = ["changed-policy"];
  await assert.rejects(view.readHistory("fork"));
});

for (const target of ["root", "child"])
test(`native fork returning ${target} cannot mutate its permissions`, async () => {
  const f = fixture(), view = await f.view(); f.setTarget(target);
  await assert.rejects(view.forkHistory(), /not independent/);
  assert.deepEqual(f.writes, ["fork:child:all"]);
});

test("a failed fork policy confirmation cannot authorize a retained read", async () => {
  const f = fixture(), view = await f.view(); f.badPolicy();
  await assert.rejects(view.forkHistory());
  await assert.rejects(view.readHistory("fork"), /arbitrary/);
});

test("ancestry drift, workspace drift and lost transport refuse reads", async () => {
  const f = fixture(), view = await f.view();
  f.records.get("child")!.parentID = "foreign";
  await assert.rejects(view.readHistory("child"), /ancestry/);
  f.records.get("child")!.parentID = "root";
  f.records.get("root")!.directory = "/";
  await assert.rejects(view.readHistory("child"), /workspace/);
  f.records.get("root")!.directory = tmpdir(); f.close();
  await assert.rejects(view.readHistory("child"), /closed/);
  assert.deepEqual(f.reads, []);
});

test("aborted inspection never dispatches messages or fork mutations", async () => {
  const f = fixture(), view = await f.view(); f.controller.abort(new Error("abandoned"));
  await assert.rejects(view.readHistory("child"), /abandoned/);
  await assert.rejects(view.forkHistory(), /abandoned/);
  assert.deepEqual(f.reads, []); assert.deepEqual(f.writes, []);
});
