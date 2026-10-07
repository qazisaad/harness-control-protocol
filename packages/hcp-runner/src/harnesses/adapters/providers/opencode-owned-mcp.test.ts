import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtemp, realpath, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {RunnerConfigSchema} from "../../../config/index.js";
import type {HarnessAdapterStartInput, HarnessAdapterTurnInput, HarnessMcpToolset} from "../types.js";
import {OpenCodeOwnedWork} from "./opencode-work.js";
import {OpenCodeOwnedMcp} from "./opencode-owned-mcp.js";
import {openCodeOwnedToolAlias} from "./opencode-owned-tools.js";

async function fixture(review = false) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "hcp-owned-mcp-")));
  const provider = RunnerConfigSchema.parse({runner_id: "runner", control_plane_url: "ws://localhost:1", provider_instances: [{id: "opencode", driver_kind: "opencode"}]}).provider_instances[0]!;
  const start: HarnessAdapterStartInput = {provider, payload: {session_id: "session", workspace_id: "workspace", provider_instance_id: "opencode", driver_kind: "opencode",
    model_selection: {model: "opencode/public"}, sandbox_mode: "danger_full_access", approval_policy: "ask", continue_session: false, mcp_servers: [], cwd}, emitSessionEvent() {}};
  let calls = 0;
  const sets: HarnessMcpToolset[] = [{name: "selected", tools: [{name: "lookup", input_schema: {type: "object", properties: {query: {type: "string"}}, required: ["query"]},
    ...(review ? {review_policy: {kind: "always" as const}} : {})}], async callTool() {calls++;return {is_error: false, content: [{type: "text", text: "answer"}], private_meta: {secret: true}};}}];
  const alias = openCodeOwnedToolAlias("selected", "lookup");
  const native = (session: string, prompt: string, message: string, call: string) => ({info: {id: message, sessionID: session, role: "assistant", parentID: prompt},
    parts: [{id: `part-${call}`, sessionID: session, messageID: message, type: "tool", tool: alias, callID: call, state: {status: "running", input: {query: "hello"}}}]});
  const messages = new Map<string, ReturnType<typeof native>>([["root-assistant", native("root", "prompt", "root-assistant", "root-call")]]);
  const work = new OpenCodeOwnedWork("root", start, {session: async id => ({id, directory: cwd, ...(id === "child" ? {parentID: "root"} : {})}),
    message: async (_session, id) => messages.get(id)});
  work.admitRoot("prompt", "original");
  const owner = new OpenCodeOwnedMcp(work, sets), rootSignal = new AbortController();
  const turn: HarnessAdapterTurnInput = {provider, startPayload: start.payload, session: {adapter_session_id: "root"},
    payload: {session_id: "session", turn_id: "original", input: "original prompt"}, mcpToolsets: sets};
  const invocation = (session = "root", message = "root-assistant", call = "root-call") => ({alias, arguments: {query: "hello"},
    native_context: {session_id: session, message_id: message, call_id: call, directory: cwd}});
  const child = async () => {
    work.observe({type: "message.part.updated", properties: {part: {id: "task-part", messageID: "root-assistant", sessionID: "root", type: "tool", tool: "task", callID: "task-call",
      state: {status: "running", title: "Owned child", metadata: {parentSessionId: "root", sessionId: "child", background: true, jobId: "child"}}}}});
    messages.set("child-assistant", native("child", "child-prompt", "child-assistant", "child-call"));
    work.observe({type: "message.updated", properties: {info: {id: "child-prompt", sessionID: "child", role: "user"}}});
    work.observe({type: "message.updated", properties: {info: messages.get("child-assistant")!.info}});
    await work.settled();
  };
  return {cwd, owner, work, turn, messages, rootSignal, child, invocation, calls: () => calls,
    close: async () => {owner.close();await rm(cwd, {recursive: true, force: true});}};
}

test("selected root calls require exact admitted physical prompt and one-use native identity", async () => {
  const f = await fixture();
  try {
    f.owner.admitRoot("prompt", f.turn, f.rootSignal.signal);
    const result = await f.owner.invoke(f.invocation(), new AbortController().signal);
    assert.equal(result.output, "answer");assert.equal(JSON.stringify(result).includes("secret"), false);assert.equal(f.calls(), 1);
    await assert.rejects(f.owner.invoke(f.invocation(), new AbortController().signal), /repeated/);
    f.messages.get("root-assistant")!.info.parentID = "foreign";
    await assert.rejects(f.owner.invoke(f.invocation(), new AbortController().signal), /no live original/);assert.equal(f.calls(), 1);
  } finally {await f.close();}
});
test("native tool admission refuses changed platform review policy before any call", async () => {
  const f = await fixture(true);
  try {
    const changed = {...f.turn, mcpToolsets: f.turn.mcpToolsets!.map(set => ({...set, tools: set.tools.map(tool => {
      const {review_policy: _policy, ...withoutPolicy} = tool;return withoutPolicy;
    })}))};
    assert.throws(() => f.owner.admitRoot("prompt", changed, f.rootSignal.signal), /catalog differs/);
    assert.equal(f.calls(), 0);
  } finally {await f.close();}
});
test("retained child uses original work review after a newer root starts and original root signal aborts", async () => {
  const f = await fixture(true);const reviewed: string[] = [];
  try {
    f.turn.reviewMcpTool = {async request() {assert.fail("Child used root review");}, async complete() {}};
    f.turn.reviewNativeWorkMcp = workId => ({async request() {reviewed.push(workId);return null;}, async complete() {}});
    f.owner.admitRoot("prompt", f.turn, f.rootSignal.signal);await f.child();
    const workId = f.work.childOrigin("child")!.work_id;
    f.work.closeRoot("prompt");f.rootSignal.abort();f.work.admitRoot("new-prompt", "new-root");
    f.owner.admitRoot("new-prompt", {...f.turn, payload: {...f.turn.payload, turn_id: "new-root"}, reviewNativeWorkMcp: () => {assert.fail("Child used newer root");}}, new AbortController().signal);
    const result = await f.owner.invoke(f.invocation("child", "child-assistant", "child-call"), new AbortController().signal);
    assert.match(result.output, /declined/);assert.deepEqual(reviewed, [workId]);assert.equal(f.calls(), 0);
  } finally {await f.close();}
});
test("a late human grant cannot dispatch after the exact native tool part completes", async () => {
  const f = await fixture(true);
  try {
    f.turn.reviewMcpTool = {async request() {
      f.messages.get("root-assistant")!.parts[0]!.state.status = "completed";
      return {request_id: "grant", action_json: "{}"};
    }, async complete() {assert.fail("Uninvoked grant completed");}};
    f.owner.admitRoot("prompt", f.turn, f.rootSignal.signal);
    await assert.rejects(f.owner.invoke(f.invocation(), new AbortController().signal), /liveness or arguments/);assert.equal(f.calls(), 0);
  } finally {await f.close();}
});
test("loss and exact child cancellation abort a pending original work review", async () => {
  for (const lose of [false, true]) {
    const f = await fixture(true);let ready!: () => void;
    const pending = new Promise<void>(resolve => {ready = resolve;});
    try {
      f.turn.reviewNativeWorkMcp = () => ({request: async (_request, signal) => {
        ready();return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("review owner aborted")), {once: true}));
      }, async complete() {}});
      f.owner.admitRoot("prompt", f.turn, f.rootSignal.signal);await f.child();
      const response = f.owner.invoke(f.invocation("child", "child-assistant", "child-call"), new AbortController().signal);
      await pending;
      if (lose) {f.work.lose();f.owner.synchronize();} else f.owner.closeWork(f.work.childOrigin("child")!.work_id);
      await assert.rejects(response, /aborted/);assert.equal(f.calls(), 0);
    } finally {await f.close();}
  }
});
