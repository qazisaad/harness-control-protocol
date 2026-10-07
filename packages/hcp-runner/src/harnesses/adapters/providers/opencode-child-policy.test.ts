import assert from "node:assert/strict";
import {test} from "node:test";
import {assertOpenCodeInitialChildPolicy, openCodeOrderedChildRules, openCodeInstalledChildRules, openCodeOwnedPolicyPlugin} from "./opencode-child-policy.js";
import {openCodeOwnedPolicyServer} from "./opencode-owned-policy-server.js";

const parent = [
  {permission: "*", pattern: "*", action: "deny" as const},
  {permission: "*", pattern: "*", action: "ask" as const},
  {permission: "read", pattern: "*", action: "allow" as const},
  {permission: "read", pattern: "*.env", action: "deny" as const},
  {permission: "external_directory", pattern: "/toy/*", action: "allow" as const},
  {permission: "task", pattern: "*", action: "allow" as const},
];
const initial = parent.filter(rule => rule.action === "deny" || rule.permission === "external_directory");
test("ordered child policy preserves complete root overrides while forbidding another child generation", () => {
  const child = openCodeOrderedChildRules(parent);
  assert.deepEqual(child.slice(0, -1), parent);assert.deepEqual(child.at(-1), {permission: "task", pattern: "*", action: "deny"});
  child[2]!.pattern = "/changed";assert.equal(parent[2]!.pattern, "*");
  assert.throws(() => openCodeOrderedChildRules(parent.slice(1)), /deny-all parent seed/);
});
test("initial child proof accepts only exact inherited denials/external rules and pinned native default denials", () => {
  assertOpenCodeInitialChildPolicy(initial, parent);
  assertOpenCodeInitialChildPolicy([...initial, {permission: "task", pattern: "*", action: "deny"}, {permission: "todowrite", pattern: "*", action: "deny"}], parent);
  for (const actual of [[...initial].reverse(), initial.slice(1), [...initial, {permission: "bash", pattern: "*", action: "allow"}],
    [...initial, {permission: "task", pattern: "*", action: "ask"}], [...initial, {permission: "read", pattern: "*", action: "deny"}],
    [...initial, {permission: "task", pattern: "*", action: "deny"}, {permission: "task", pattern: "*", action: "deny"}]])
    assert.throws(() => assertOpenCodeInitialChildPolicy(actual, parent), /initial permissions|initialization added authority/);
});

test("complete installed child readback retains the exact native PATCH append semantics", () => {
  const defaults = [{permission: "task", pattern: "*", action: "deny" as const}, {permission: "todowrite", pattern: "*", action: "deny" as const}];
  const inherited = [...initial, ...defaults];
  const installed = openCodeInstalledChildRules(inherited, parent);
  assert.deepEqual(installed, [...inherited, ...openCodeOrderedChildRules(parent), ...defaults]);
  assert.deepEqual(installed.at(-1), {permission: "todowrite", pattern: "*", action: "deny"});
  assert.throws(() => openCodeInstalledChildRules([...initial, {permission: "read", pattern: "*", action: "allow"}], parent), /initialization added authority/);
});

async function plugin(source: string) {
  const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`) as {
    default(ctx: {directory: string}): Promise<{"chat.message"(input: {sessionID: string; messageID?: string}, output: {message: {id: string; sessionID: string}; parts: unknown[]}): Promise<void>}>;
  };
  return module.default({directory: "/workspace"});
}
test("private native prompt hook awaits scoped confirmation and preserves every model-visible value", async () => {
  const server = await openCodeOwnedPolicyServer();
  let confirm!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => {entered = resolve;});
  const release = new Promise<void>(resolve => {confirm = resolve;});
  const scopes: unknown[] = [];
  server.bind(async input => {scopes.push(input);entered();await release;return {confirmed: true, native_reference: input.session_id, native_execution_reference: input.message_id};});
  try {
    const hooks = await plugin(openCodeOwnedPolicyPlugin(server));
    const input = {sessionID: "child", messageID: "native-message"};
    const output = {message: {id: "native-message", sessionID: "child"}, parts: [{type: "text", text: "model-visible toy prompt"}]};
    const before = structuredClone({input, output});let returned = false;
    const pending = hooks["chat.message"](input, output).then(() => {returned = true;});
    await waiting;assert.equal(returned, false);assert.deepEqual(scopes, [{session_id: "child", message_id: "native-message", directory: "/workspace"}]);
    assert.deepEqual({input, output}, before);confirm();await pending;
    assert.deepEqual({input, output}, before);assert.equal(JSON.stringify(output).includes(server.proof), false);
  } finally {confirm();await server.close();}
});
test("native prompt bridge refuses forged scope/proof, injected body fields, unavailable owner and scope drift", async () => {
  const server = await openCodeOwnedPolicyServer();let calls = 0;
  server.bind(async input => {calls++;return {confirmed: true, native_reference: "foreign", native_execution_reference: input.message_id};});
  try {
    const send = (body: unknown, proof = server.proof) => fetch(server.endpoint, {method: "POST", headers: {"content-type": "application/json", "x-hcp-native-policy-proof": proof}, body: JSON.stringify(body)});
    const valid = {session_id: "child", message_id: "message", directory: "/workspace"};
    assert.equal((await send(valid, "forged")).status, 403);assert.equal(calls, 0);
    assert.equal((await send({...valid, authority: "allow"})).status, 400);assert.equal(calls, 0);
    assert.equal((await send(valid)).status, 400);assert.equal(calls, 1);
    const hooks = await plugin(openCodeOwnedPolicyPlugin(server));
    await assert.rejects(hooks["chat.message"]({sessionID: "child", messageID: "message"}, {message: {id: "message", sessionID: "foreign"}, parts: []}), /ownership could not be confirmed/);
    assert.equal(calls, 1);
    await assert.rejects(hooks["chat.message"]({sessionID: "child"}, {message: {id: "message", sessionID: "child"}, parts: []}), /ownership could not be confirmed/);
    assert.equal(calls, 2);assert.throws(() => server.bind(async input => ({confirmed: true, native_reference: input.session_id, native_execution_reference: input.message_id})), /cannot be replaced/);
  } finally {await server.close();}
});
