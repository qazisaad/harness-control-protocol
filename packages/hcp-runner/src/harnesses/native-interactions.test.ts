import assert from "node:assert/strict";
import { test } from "node:test";
import type { HcpSessionStartPayload, HcpApprovalResponsePayload, HcpInputResponsePayload } from "@harness-control/protocol";
import { NativeInteractions } from "./native-interactions.js";
import type { HarnessAdapterEvent } from "./adapters/types.js";

const start: HcpSessionStartPayload = {session_id: "session", workspace_id: "workspace", provider_instance_id: "codex",
  driver_kind: "codex", cwd: "/tmp", model_selection: {model: "model"}, sandbox_mode: "workspace_write",
  approval_policy: "ask", continue_session: false, mcp_servers: []};
const binding = {threadId: "native-thread", turnId: "native-turn", itemId: "item"};
function fixture(payload = start, turnId = "turn", nativeWorkId?: string) {
  const events: HarnessAdapterEvent[] = [];
  let published!: () => void;
  const ready = new Promise<void>(resolve => {published = resolve;});
  const owner = new NativeInteractions(payload, {session_id: "session", turn_id: turnId, input: "hi"},
    {threadId: binding.threadId, turnId: () => binding.turnId}, event => {events.push(event); published();}, nativeWorkId);
  const signal = new AbortController();
  const approval = (): HcpApprovalResponsePayload => ({session_id: "session", turn_id: turnId, request_id: events[0]!.data.request_id as string,
    actor_id: "actor", action_hash: events[0]!.data.action_hash as string, decision: "accept"});
  const input = (value: unknown): HcpInputResponsePayload => ({session_id: "session", turn_id: turnId,
    request_id: events[0]!.data.request_id as string, actor_id: "actor", value});
  return {owner, events, signal, ready, approval, input};
}

for (const requestType of ["command", "file_change"] as const) {
  test(`native ${requestType} decision is bound to one immutable request`, async () => {
    const f = fixture();
    try {
      const result = f.owner.approval({...binding, command: "echo hello"}, requestType, f.signal.signal);
      await f.ready;
      assert.equal(f.events[0]!.data.request_type, requestType);
      assert.throws(() => f.owner.respondApproval({...f.approval(), action_hash: "other"}), /stale, invalid/);
      assert.throws(() => f.owner.respondApproval({...f.approval(), session_id: "other"}), /another active session/);
      assert.throws(() => f.owner.respondApproval({...f.approval(), decision: "accept_for_session"}), /stale, invalid/);
      f.owner.respondApproval(f.approval());
      f.owner.respondApproval(f.approval());
      assert.deepEqual(await result, {decision: "accept"});
      assert.equal(f.events.filter(event => event.event_type === "approval.resolved").length, 1);
      assert.throws(() => f.owner.respondApproval({...f.approval(), decision: "decline"}), /stale, invalid/);
    } finally {f.owner.close();}
  });
}

for (const kind of ["approval", "question"] as const) test(`follow-up ${kind} does not inherit an earlier first-turn deadline`, async () => {
  const f = fixture({...start, first_turn: {turn_id: "initial", input: "first", not_after: "1970-01-01T00:00:00.000Z"}}, "follow-up");
  try {
    const pending = kind === "approval" ? f.owner.approval(binding, "command", f.signal.signal)
      : f.owner.questions({...binding, questions: [{id: "q", header: "Choice", question: "Pick", options: [{label: "A", description: "First"}]}]}, f.signal.signal);
    await f.ready;
    assert.ok(Date.parse(f.events[0]!.data.expires_at as string) > Date.now());
    if (kind === "approval") f.owner.respondApproval(f.approval());
    else f.owner.respondInput(f.input({answers: {q: {answers: ["A"]}}}));
    await pending;
  } finally {f.owner.close();}
});

test("the original turn still honors its own deadline, including the Unix epoch", async () => {
  const f = fixture({...start, first_turn: {turn_id: "turn", input: "first", not_after: "1970-01-01T00:00:00.000Z"}});
  try {
    const pending = f.owner.approval(binding, "command", f.signal.signal);
    await f.ready;
    assert.equal(Date.parse(f.events[0]!.data.expires_at as string), 0);
    assert.throws(() => f.owner.respondApproval(f.approval()), /stale, invalid/);
    await assert.rejects(pending, /expired/);
  } finally {f.owner.close();}
});

test("native decisions cannot expand the provider's offered choices", async () => {
  const f = fixture();
  try {
    const result = f.owner.approval({...binding, availableDecisions: ["decline", "cancel"]}, "command", f.signal.signal);
    await f.ready;
    assert.deepEqual(f.events[0]!.data.allowed_decisions, ["decline", "cancel"]);
    assert.throws(() => f.owner.respondApproval(f.approval()), /stale, invalid/);
    f.owner.respondApproval({...f.approval(), decision: "decline"});
    assert.deepEqual(await result, {decision: "decline"});
  } finally {f.owner.close();}
});

test("native questions validate exact answers without journaling responses", async () => {
  const f = fixture();
  try {
    const result = f.owner.questions({...binding, questions: [{id: "scope", header: "Scope", question: "Pick a scope",
      options: [{label: "Small", description: "One file"}, {label: "Large", description: "All files"}]}]}, f.signal.signal);
    await f.ready;
    assert.throws(() => f.owner.respondInput(f.input({answers: {scope: {answers: ["Unknown"]}}})));
    assert.throws(() => f.owner.respondInput(f.input({answers: {scope: {answers: ["Small"]}, other: {answers: ["extra"]}}})));
    const value = {answers: {scope: {answers: ["Small"]}}};
    f.owner.respondInput(f.input(value));
    assert.deepEqual(await result, value);
    assert.equal("value" in f.events[1]!.data, false);
  } finally {f.owner.close();}
});

for (const action of ["abort", "close"] as const) {
  test(`${action} rejects pending native requests and late answers`, async () => {
    const f = fixture();
    const result = f.owner.approval(binding, "command", f.signal.signal);
    const rejection = assert.rejects(result, /interrupted|turn ended/i);
    await f.ready;
    if (action === "abort") f.signal.abort(); else f.owner.close();
    await rejection;
    assert.throws(() => f.owner.respondApproval(f.approval()));
    f.owner.close();
  });
}

test("other conversations and unsupported secret questions fail before publication", async () => {
  const f = fixture();
  await assert.rejects(f.owner.approval({...binding, threadId: "other"}, "command", f.signal.signal), /another conversation/);
  await assert.rejects(f.owner.questions({...binding, questions: [{id: "key", header: "Key", question: "Secret?", isSecret: true}]}, f.signal.signal), /encrypted response/);
  assert.deepEqual(f.events, []);
  f.owner.close();
});

test("native work callbacks retain their work identity and earlier admitted root", async () => {
  const f = fixture(start,"original-root","owned-child");
  try {
    const response = f.owner.approval(binding,"command",f.signal.signal); await f.ready;
    assert.equal(f.events[0]!.turn_id,"original-root"); assert.equal(f.events[0]!.data.native_work_id,"owned-child");
    assert.throws(()=>f.owner.respondApproval({...f.approval(),turn_id:"newer-root"}),/another active session or turn/);
    f.owner.respondApproval(f.approval()); await response;
    assert.equal(f.events[1]!.data.native_work_id,"owned-child");
  } finally {f.owner.close();}
});

test("lost native work callbacks keep provenance without becoming session-scoped input", async () => {
  const f = fixture(start,"original-root","owned-child");
  const response = f.owner.questions({...binding,questions:[{id:"color",header:"Color",question:"Which color?",options:[{label:"Green",description:"Test"}]}]},f.signal.signal);
  const rejected = assert.rejects(response,/turn ended/); await f.ready;
  f.owner.close(); await rejected;
  assert.equal(f.events[0]!.data.native_work_id,"owned-child");
  const lost = f.events.filter(event=>event.event_type==="native.request.lost")[0]!;
  assert.equal(lost.turn_id,"original-root"); assert.equal(lost.data.native_work_id,"owned-child");
  assert.equal(lost.data.request_scope,undefined);
  assert.throws(()=>new NativeInteractions(start,{session_id:"session",request_scope:"session"},
    {threadId:binding.threadId,turnId:()=>undefined},()=>{},"owned-child"),/admitted root origin/);
});
