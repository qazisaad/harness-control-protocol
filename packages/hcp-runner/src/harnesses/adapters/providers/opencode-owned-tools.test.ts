import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtemp, realpath, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {openCodeOwnedToolAlias, openCodeOwnedToolPlugin, verifyOpenCodeOwnedToolInvocation} from "./opencode-owned-tools.js";

const alias = openCodeOwnedToolAlias("selected", "search");
test("owned plugin preserves complete JSON Schema and transports physical identity outside arguments", async () => {
  const schema = {type: "object", properties: {query: {type: "string"}}, required: ["query"], additionalProperties: false,
    oneOf: [{properties: {query: {minLength: 2}}}], $defs: {nested: {type: "string"}}};
  const source = openCodeOwnedToolPlugin({endpoint: "http://127.0.0.1:32123/invoke", proof: "private_invocation_proof_1234567890",
    tools: [{alias, description: 'Quotes " and `${unsafe}` stay data.', schema}]});
  const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  const plugin = await module.default();
  const parameters = {effectDecoder: true}, output = {parameters, jsonSchema: {type: "object"}};
  await plugin["tool.definition"]({toolID: alias}, output);
  assert.equal(output.parameters, parameters);
  assert.deepEqual(output.jsonSchema, schema);
  const abort = new AbortController(), originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (url: string, options: RequestInit) => {
      assert.equal(url, "http://127.0.0.1:32123/invoke");
      assert.equal((options.headers as Record<string, string>)["x-hcp-native-tool-proof"], "private_invocation_proof_1234567890");
      assert.deepEqual(JSON.parse(options.body as string), {alias, arguments: {query: "hello"}, native_context:
        {session_id: "session", message_id: "message", call_id: "call", directory: "/owned"}});
      assert.equal(options.signal, abort.signal);
      return new Response(JSON.stringify({output: "answer"}));
    }) as typeof fetch;
    assert.deepEqual(await plugin.tool[alias].execute({query: "hello"}, {sessionID: "session", messageID: "message", callID: "call", directory: "/owned", abort: abort.signal}), {output: "answer"});
    await assert.rejects(plugin.tool[alias].execute({}, {sessionID: "session", messageID: "message", directory: "/owned", abort: abort.signal}), /could not confirm/);
    abort.abort();
    await assert.rejects(plugin.tool[alias].execute({}, {sessionID: "session", messageID: "message", callID: "call", directory: "/owned", abort: abort.signal}), /could not confirm/);
  } finally {globalThis.fetch = originalFetch;}
});

test("owned invocation refuses foreign, terminal, ambiguous and altered native calls", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "hcp-owned-tools-")));
  try {
    const input = {alias, arguments: {query: "hello", nested: {b: 2, a: 1}}, native_context: {session_id: "session", message_id: "message", call_id: "call", directory}};
    const session = {id: "session", directory, parentID: "root"};
    const part = {id: "part", sessionID: "session", messageID: "message", type: "tool", callID: "call", tool: alias,
      state: {status: "running", input: {nested: {a: 1, b: 2}, query: "hello"}}};
    const message = {info: {id: "message", sessionID: "session", role: "assistant", parentID: "prompt"}, parts: [part]};
    const transport = {session: async () => session, message: async () => message};
    assert.deepEqual(await verifyOpenCodeOwnedToolInvocation(input, directory, transport), {invocation: input, native_prompt_id: "prompt", native_part_id: "part", native_parent_session_id: "root"});
    for (const altered of [
      {...message, info: {...message.info, id: "foreign"}}, {...message, info: {...message.info, sessionID: "foreign"}},
      {...message, info: {...message.info, role: "user"}}, {...message, parts: [part, part]},
      ...["completed", "error", undefined].map(status => ({...message, parts: [{...part, state: {status, input: part.state.input}}]})),
      ...[{sessionID: "foreign"}, {messageID: "foreign"}, {callID: "foreign"}, {tool: openCodeOwnedToolAlias("foreign", "search")},
        {state: {status: "running", input: {query: "changed"}}}].map(change => ({...message, parts: [{...part, ...change}]})),
    ]) await assert.rejects(verifyOpenCodeOwnedToolInvocation(input, directory, {...transport, message: async () => altered}));
    await assert.rejects(verifyOpenCodeOwnedToolInvocation(input, directory, {...transport, session: async () => ({...session, id: "foreign"})}));
    await assert.rejects(verifyOpenCodeOwnedToolInvocation({...input, proof: "model-visible"}, directory, transport));
  } finally {await rm(directory, {recursive: true, force: true});}
});

test("owned plugin refuses non-owned endpoints and ambiguous aliases", () => {
  const tools = [{alias, description: "", schema: {type: "object"}}], proof = "private_invocation_proof_1234567890";
  for (const endpoint of ["https://127.0.0.1:32123/", "http://localhost:32123/", "http://127.0.0.1/", "http://user:pass@127.0.0.1:32123/", "http://127.0.0.1:32123/?proof=bad"])
    assert.throws(() => openCodeOwnedToolPlugin({endpoint, proof, tools}));
  assert.throws(() => openCodeOwnedToolPlugin({endpoint: "http://127.0.0.1:32123/", proof, tools: [...tools, ...tools]}));
});
