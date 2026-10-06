import assert from "node:assert/strict";
import {test} from "node:test";
import {HarnessMcpDispatchQueue} from "./mcp-dispatch.js";
import {NativeMcpBridge} from "./adapters/providers/native-mcp.js";

test("root and child bridges share a slot through approval and execution", async () => {
  const queue = new HarnessMcpDispatchQueue();
  const events: string[] = [];
  let release!: () => void;
  const waiting = new Promise<void>(resolve => {release = resolve;});
  const make = (name: string) => new NativeMcpBridge([{name, tools: [{name: "read", input_schema: {}, review_policy: {kind: "always"}}],
    async callTool() {events.push(`${name}:execute`); return {is_error: false};}}], {
    async request() {events.push(`${name}:approve`); if (name === "child") await waiting; return {request_id: name, action_json: "action"};},
    async complete() {events.push(`${name}:complete`);},
  }, queue.dispatch);
  const child = make("child"), root = make("root");
  const binding = {threadId: "native", turnId: "native-turn"};
  const call = (bridge: NativeMcpBridge) => bridge.call({...binding, callId: "call", namespace: bridge.definitions[0]!.name, tool: "read", arguments: {}}, binding, new AbortController().signal);
  const first = call(child), second = call(root);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ["child:approve"]);
  release(); await Promise.all([first, second]);
  assert.deepEqual(events, ["child:approve", "child:execute", "child:complete", "root:approve", "root:execute", "root:complete"]);
});

test("cancelled queued calls never dispatch and cannot release an active operation", async () => {
  const queue = new HarnessMcpDispatchQueue();
  let release!: () => void;
  const waiting = new Promise<void>(resolve => {release = resolve;});
  const first = queue.dispatch(() => waiting, new AbortController().signal);
  const abort = new AbortController();
  const second = queue.dispatch(async () => assert.fail("cancelled operation dispatched"), abort.signal);
  let third = false;
  const last = queue.dispatch(async () => {third = true;}, new AbortController().signal);
  abort.abort(new Error("owner closed"));
  await assert.rejects(second, /owner closed/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(third, false);
  release(); await Promise.all([first, last]);
  assert.equal(third, true);
});

test("unknown prior effects fence later owners at dispatch rather than while queued", async () => {
  let unknown = false;
  const queue = new HarnessMcpDispatchQueue(() => {if (unknown) throw new Error("unknown receipt");});
  const first = queue.dispatch(async () => {unknown = true; throw new Error("lost acknowledgement");}, new AbortController().signal);
  const second = queue.dispatch(async () => assert.fail("redispatched after loss"), new AbortController().signal);
  await assert.rejects(first, /lost acknowledgement/);
  await assert.rejects(second, /unknown receipt/);
});
