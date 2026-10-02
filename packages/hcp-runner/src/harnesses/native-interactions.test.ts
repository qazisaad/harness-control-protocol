import assert from "node:assert/strict";
import { test } from "node:test";
import type { HcpSessionStartPayload, HcpApprovalResponsePayload, HcpInputResponsePayload } from "@harness-control/protocol";
import { NativeInteractions } from "./native-interactions.js";
import type { HarnessAdapterEvent } from "./adapters/types.js";

const start: HcpSessionStartPayload = {session_id: "session", workspace_id: "workspace", provider_instance_id: "codex",
  driver_kind: "codex", cwd: "/tmp", model_selection: {model: "model"}, sandbox_mode: "workspace_write",
  approval_policy: "ask", continue_session: false, mcp_servers: []};
const binding = {threadId: "native-thread", turnId: "native-turn", itemId: "item"};
function fixture() {
  const events: HarnessAdapterEvent[] = [];
  let published!: () => void;
  const ready = new Promise<void>(resolve => {published = resolve;});
  const owner = new NativeInteractions(start, {session_id: "session", turn_id: "turn", input: "hi"},
    {threadId: binding.threadId, turnId: () => binding.turnId}, event => {events.push(event); published();});
  const signal = new AbortController();
  const approval = (): HcpApprovalResponsePayload => ({session_id: "session", turn_id: "turn", request_id: events[0]!.data.request_id as string,
    actor_id: "actor", action_hash: events[0]!.data.action_hash as string, decision: "accept"});
  const input = (value: unknown): HcpInputResponsePayload => ({session_id: "session", turn_id: "turn",
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
