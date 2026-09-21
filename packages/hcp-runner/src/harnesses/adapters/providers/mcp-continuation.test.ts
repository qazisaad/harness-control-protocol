import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { HarnessMcpContinuation } from "../types.js";
import { nativeMcpNamespace } from "./native-mcp.js";
import { recordMcpContinuation } from "./mcp-continuation.js";

const continuation: HarnessMcpContinuation = {
  native_thread_id: "thread", request_id: "review", attachment_name: "selected", tool_name: "lookup",
  arguments: {query: "e\u0301", enabled: false}, outcome: {kind: "completed", result: {is_error: false, structured_content: {value: 1}}},
};
const metadata = {type: "session_meta", payload: {id: "thread"}};
const call = {type: "response_item", payload: {type: "function_call", call_id: "reviewed_review",
  namespace: nativeMcpNamespace("selected"), name: "lookup", arguments: '{"enabled":false,"query":"e\\u0301"}'}};
const output = {type: "response_item", payload: {type: "function_call_output", call_id: "reviewed_review",
  output: '{"structured_content":{"value":1},"is_error":false}'}};

async function fixture(records: unknown[], run: (invoke: () => Promise<void>, methods: string[]) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "native-reviewed-history-"));
  const path = join(root, "rollout.jsonl");
  await writeFile(path, records.map(record => JSON.stringify(record)).join("\n") + "\n");
  const methods: string[] = [];
  const rpc = {async request(method: string): Promise<unknown> {
    methods.push(method);
    return method === "thread/read" ? {thread: {id: "thread", path}} : {};
  }};
  try {await run(() => recordMcpContinuation(rpc, "thread", continuation), methods);}
  finally {await rm(root, {recursive: true, force: true});}
}

test("native result recovery compares JSON values and never inserts a recorded operation again", async () => {
  await fixture([metadata, call, output], async (invoke, methods) => {
    await invoke();
    assert.deepEqual(methods, ["thread/read"]);
  });
});

test("a first continuation inserts the actual call and result after checking native history", async () => {
  await fixture([metadata], async (invoke, methods) => {
    await invoke();
    assert.deepEqual(methods, ["thread/read", "thread/inject_items"]);
  });
});

for (const [label, records] of [
  ["another session", [{...metadata, payload: {id: "other"}}, call, output]],
  ["partial native write", [metadata, call]],
  ["changed arguments", [metadata, {...call, payload: {...call.payload, arguments: '{"query":"é","enabled":false}'}}, output]],
  ["changed result", [metadata, call, {...output, payload: {...output.payload, output: '{"is_error":true}'}}]],
] as const) {
  test(`${label} cannot cause reinsertion or conceal mismatched native evidence`, async () => {
    await fixture([...records], async (invoke, methods) => {
      await assert.rejects(invoke);
      assert.deepEqual(methods, ["thread/read"]);
    });
  });
}
