import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CodexRpc } from "./codex-rpc.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "hcp-native-rpc-"));
  const executable = join(directory, "native-fixture.mjs");
  await writeFile(executable, `#!/usr/bin/env node
import { createInterface } from "node:readline";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
createInterface({input: process.stdin}).on("line", line => {
  const value = JSON.parse(line);
  if (value.method === "probe") {
    send({id: value.id, result: {started:true}});
    send({id:"tool-request", method:"item/tool/call", params:{value:42}});
  } else if (value.id === "tool-request") {
    send({method:"probe/result", params:value});
  } else if (value.method === "resolve-request") {
    send({method:"serverRequest/resolved",params:{requestId:"tool-request"}});
    send({id:value.id,result:{resolved:true}});
  } else if (value.method === "unsafe-id") {
    send({id:value.id,result:{started:true}});
    send({id:value.params.id,method:"item/tool/call",params:{}});
  } else if (value.method === "ping") {
    send({id:value.id,result:{alive:true}});
  } else if (value.method === "delayed-read") {
    setTimeout(() => send({id:value.id,result:{late:true}}), 100);
  } else if (value.method === "bound-probe") {
    send({id:value.id,result:{started:true}});
    send({id:"tool-request",method:"item/tool/call",params:{threadId:"child",turnId:"child-turn",value:42}});
  } else if (value.method === "terminal") {
    send({method:"turn/completed",params:{threadId:value.params.threadId,turn:{id:value.params.turnId,status:"interrupted"}}});
    send({id:value.id,result:{}});
  }
});

`, { mode: 0o700 });
  const rpc = new CodexRpc(executable, directory, process.env);
  return { rpc, async close() { await rpc.process.stop(); await rm(directory, {recursive:true, force:true}); } };
}

test("native tools receive one response for the original request", {timeout: 5000}, async () => {
  const {rpc, close} = await fixture();
  try {
    let calls = 0;
    rpc.setRequestHandler("item/tool/call", async (params, signal, context) => {
      assert.deepEqual(context, {requestId: "tool-request"});
      assert.equal(Object.isFrozen(context), true);
      assert.deepEqual(params, {value:42});
      assert.equal(signal.aborted, false);
      calls++;
      return {contentItems:[{type:"inputText",text:"42"}], success:true};
    });
    const response = new Promise(resolve => { rpc.onNotification = message => resolve(message.params); });
    await rpc.request("probe", {});
    assert.deepEqual(await response, {id:"tool-request", result:{contentItems:[{type:"inputText",text:"42"}],success:true}});
    assert.equal(calls, 1);
  } finally { await close(); }
});

test("unregistered native requests remain rejected", {timeout: 5000}, async () => {
  const {rpc, close} = await fixture();
  try {
    const failed = new Promise<Error>(resolve => { rpc.onFailure=resolve; });
    await rpc.request("probe", {});
    assert.match((await failed).message, /unsupported interactive input/);
  } finally { await close(); }
});

test("native process loss aborts outstanding tool work", {timeout: 5000}, async () => {
  const {rpc, close} = await fixture();
  try {
    let started!: () => void;
    const ready = new Promise<void>(resolve => {started=resolve;});
    let observedAbort!: () => void;
    const aborted = new Promise<void>(resolve => {observedAbort=resolve;});
    rpc.setRequestHandler("item/tool/call", async (_, signal) => {
      started();
      await new Promise((_, reject) => signal.addEventListener("abort", () => {observedAbort(); reject(signal.reason);}, {once:true}));
    });
    await rpc.request("probe", {});
    await ready;
    await rpc.process.stop();
    await aborted;
  } finally { await close(); }
});

test("native resolution fences a pending reply without killing its persistent owner", {timeout: 5000}, async () => {
  const {rpc, close} = await fixture();
  try {
    let started!: () => void, aborted!: () => void;
    const ready = new Promise<void>(resolve => {started = resolve;});
    const resolved = new Promise<void>(resolve => {aborted = resolve;});
    let failure: Error | undefined, reply = false;
    rpc.onFailure = error => {failure = error;};
    rpc.onNotification = message => {if (message.method === "probe/result") reply = true;};
    rpc.setRequestHandler("item/tool/call", async (_, signal) => {
      started();
      await new Promise((_, reject) => signal.addEventListener("abort", () => {aborted(); reject(signal.reason);}, {once:true}));
    });
    await rpc.request("probe", {}); await ready;
    await rpc.request("resolve-request", {}); await resolved;
    assert.deepEqual(await rpc.request("ping", {}), {alive:true});
    assert.equal(failure, undefined); assert.equal(reply, false);
  } finally {await close();}
});

test("an observed native child terminal fences only callbacks for that exact thread and turn", {timeout:5000}, async () => {
  const {rpc,close} = await fixture();
  try {
    let started!: () => void, aborted!: () => void, wasAborted = false, failure: Error | undefined;
    const ready = new Promise<void>(resolve=>{started=resolve;});
    const terminal = new Promise<void>(resolve=>{aborted=resolve;});
    rpc.onFailure = error=>{failure=error;};
    rpc.setRequestHandler("item/tool/call",async (_,signal)=>{
      started(); await new Promise((_,reject)=>signal.addEventListener("abort",()=>{wasAborted=true;aborted();reject(signal.reason);},{once:true}));
    });
    await rpc.request("bound-probe",{}); await ready;
    await rpc.request("terminal",{threadId:"root",turnId:"child-turn"});
    await rpc.request("terminal",{threadId:"child",turnId:"older-child-turn"});
    assert.equal(wasAborted,false);
    await rpc.request("terminal",{threadId:"child",turnId:"child-turn"}); await terminal;
    assert.deepEqual(await rpc.request("ping",{}),{alive:true}); assert.equal(failure,undefined);
  } finally {await close();}
});

test("abandoned native reads discard late replies without stopping the shared owner", {timeout: 5000}, async () => {
  const {rpc, close} = await fixture();
  try {
    const controller = new AbortController();
    const reason = new Error("history deadline");
    const read = rpc.request("delayed-read", {}, {signal: controller.signal});
    controller.abort(reason);
    await assert.rejects(read, error => error === reason);
    assert.deepEqual(await rpc.request("ping", {}), {alive: true});
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.deepEqual(await rpc.request("ping", {}), {alive: true});
    const aborted = AbortSignal.abort(reason);
    await assert.rejects(rpc.request("probe", {}, {signal: aborted}), error => error === reason);
    assert.deepEqual(await rpc.request("ping", {}), {alive: true});
  } finally {await close();}
});


test("unsafe native request IDs fail before callback dispatch", {timeout: 5000}, async () => {
  for (const id of [Number.MAX_SAFE_INTEGER + 1, 1.5, "", "x".repeat(513)]) {
    const {rpc, close} = await fixture();
    try {
      const failure = new Promise<Error>(resolve => {rpc.onFailure = resolve;});
      rpc.setRequestHandler("item/tool/call", async () => assert.fail("Unsafe native request ID dispatched"));
      await rpc.request("unsafe-id", {id});
      assert.equal((await failure as Error & {code: string}).code, "codex_protocol_error");
    } finally {await close();}
  }
});
