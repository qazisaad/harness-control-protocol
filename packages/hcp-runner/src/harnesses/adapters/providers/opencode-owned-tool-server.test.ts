import assert from "node:assert/strict";
import {test} from "node:test";
import {openCodeOwnedToolServer} from "./opencode-owned-tool-server.js";
import {openCodeOwnedToolAlias} from "./opencode-owned-tools.js";

const input = {alias: openCodeOwnedToolAlias("selected", "tool"), arguments: {}, native_context:
  {session_id: "session", message_id: "message", call_id: "call", directory: "/owned"}};
test("private native endpoint requires separate proof and strict invocation before dispatch", async () => {
  const server = await openCodeOwnedToolServer(); let calls = 0;
  const request = (proof = server.proof, body: unknown = input) => fetch(server.endpoint, {method: "POST",
    headers: {"content-type": "application/json", "x-hcp-native-tool-proof": proof}, body: JSON.stringify(body)});
  try {
    assert.equal((await request()).status, 403);
    server.bind(async invocation => {calls++; assert.deepEqual(invocation, input); return {output: "confirmed"};});
    assert.throws(() => server.bind(async () => ({})), /cannot be replaced/);
    for (const proof of ["", "wrong", "x".repeat(server.proof.length)]) assert.equal((await request(proof)).status, 403);
    assert.equal((await request(server.proof, {...input, proof: server.proof})).status, 400);
    assert.equal(calls, 0);
    assert.deepEqual(await (await request()).json(), {output: "confirmed"}); assert.equal(calls, 1);
  } finally {await server.close();await server.close();}
});
test("disconnect and owner closure abort admitted native endpoint lifetimes", async () => {
  for (const closeOwner of [false, true]) {
    const server = await openCodeOwnedToolServer(), abort = new AbortController();
    let signal!: AbortSignal, admitted!: () => void;
    const admission = new Promise<void>(resolve => {admitted = resolve;});
    server.bind(async (_input, lifetime) => {
      signal = lifetime;admitted();
      return new Promise((_resolve, reject) => lifetime.addEventListener("abort", () => reject(new Error("Private backend error")), {once: true}));
    });
    const response = fetch(server.endpoint, {method: "POST", headers: {"content-type": "application/json", "x-hcp-native-tool-proof": server.proof},
      body: JSON.stringify(input), signal: abort.signal}).catch(() => undefined);
    try {
      await admission;
      const aborted = new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), {once: true}));
      if (closeOwner) await server.close(); else abort.abort();
      await aborted; assert.equal(signal.aborted, true); await response;
    } finally {await server.close();}
  }
});
test("native endpoint does not expose backend errors", async () => {
  const server = await openCodeOwnedToolServer();
  try {
    server.bind(async () => {throw new Error(`Sensitive ${server.proof}`);});
    const response = await fetch(server.endpoint, {method: "POST", headers: {"content-type": "application/json", "x-hcp-native-tool-proof": server.proof}, body: JSON.stringify(input)});
    assert.equal(response.status, 400);assert.equal((await response.text()).includes(server.proof), false);
  } finally {await server.close();}
});
test("native endpoint refuses responses above its bounded serialization limit", async () => {
  const server = await openCodeOwnedToolServer();
  try {
    server.bind(async () => ({output: "x".repeat(8 * 1024 * 1024)}));
    const response = await fetch(server.endpoint, {method: "POST", headers: {"content-type": "application/json", "x-hcp-native-tool-proof": server.proof}, body: JSON.stringify(input)});
    assert.equal(response.status, 400);assert.ok((await response.text()).length < 256);
  } finally {await server.close();}
});
