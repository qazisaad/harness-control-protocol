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
    rpc.setRequestHandler("item/tool/call", async (params, signal) => {
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
