import assert from "node:assert/strict";
import Ajv2020 from "ajv/dist/2020.js";
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


for (const kind of ["approval", "input", "lost"] as const) test(`native request identity stays separate from the HCP token through ${kind}`, async () => {
  const f = fixture();
  const identity = {source: "native" as const, native_reference: "native-thread", request_reference: "actual-native-request",
    message_reference: "native-message", call_reference: "native-call"};
  try {
    const pending = kind === "input" ? f.owner.questions({...binding, questions: [{id: "q", header: "Choice", question: "Pick"}]}, f.signal.signal, identity)
      : f.owner.approval(binding, "command", f.signal.signal, identity);
    await f.ready;
    assert.deepEqual(f.events[0]!.data.native_request, identity);
    assert.notEqual(f.events[0]!.data.request_id, identity.request_reference);
    identity.request_reference = "caller-mutation";
    if (kind === "lost") {f.signal.abort(); await assert.rejects(pending, /interrupted/);}
    else if (kind === "approval") {f.owner.respondApproval(f.approval()); await pending;}
    else {f.owner.respondInput(f.input({answers: {q: {answers: ["A"]}}})); await pending;}
    assert.equal((f.events.at(-1)!.data.native_request as {request_reference: string}).request_reference, "actual-native-request");
  } finally {f.owner.close();}
});

test("native request evidence for another physical conversation refuses before publication", async () => {
  const f = fixture();
  try {
    await assert.rejects(f.owner.approval(binding, "command", f.signal.signal,
      {source: "native", native_reference: "foreign", request_reference: "request"}), /another physical conversation/);
    assert.equal(f.events.length, 0);
  } finally {f.owner.close();}
});

test("rejection feedback is exact, capability-bound and part of immutable callback replay", async () => {
  const f = fixture();
  try {
    const result = f.owner.approval(binding, "other", f.signal.signal, undefined, {rejectionFeedback: true});await f.ready;
    assert.equal(f.events[0]!.data.rejection_feedback_supported, true);
    assert.throws(() => f.owner.respondApproval({...f.approval(), feedback: "invalid accept"}), /rejection feedback/);
    assert.throws(() => f.owner.respondApproval({...f.approval(), decision: "decline", feedback: "x".repeat(8193)}), /rejection feedback/);
    assert.throws(() => f.owner.respondApproval({...f.approval(), action_hash: "wrong", decision: "decline", feedback: "feedback"}), /stale, invalid/);
    const reply = {...f.approval(), decision: "decline" as const, feedback: " Please revise  😀 "};
    f.owner.respondApproval(reply);f.owner.respondApproval(reply);
    assert.deepEqual(await result, {decision: "decline", feedback: reply.feedback});
    assert.equal(f.events.filter(event => event.event_type === "approval.resolved").length, 1);
    assert.equal(f.events[1]!.data.feedback, reply.feedback);
    assert.throws(() => f.owner.respondApproval({...reply, feedback: "different"}), /stale, invalid/);
  } finally {f.owner.close();}
});
test("unadvertised native feedback refuses without consuming the pending decision", async () => {
  const f = fixture();
  try {
    const result = f.owner.approval(binding, "other", f.signal.signal);await f.ready;
    assert.equal(f.events[0]!.data.rejection_feedback_supported, undefined);
    assert.throws(() => f.owner.respondApproval({...f.approval(), decision: "cancel", feedback: "unsupported"}), /rejection feedback/);
    f.owner.respondApproval({...f.approval(), decision: "cancel"});assert.deepEqual(await result, {decision: "cancel"});
  } finally {f.owner.close();}
});

test("native question form retains exact headers and option descriptions without losing selection semantics", async () => {
  const f = fixture();try {
    const result = f.owner.questions({...binding, questions: [{id: "scope", header: " Native heading ", question: "Pick a scope",
      multiSelect: true, options: [{label: "Small", description: " One file \n"}, {label: "Large", description: ""}]}]}, f.signal.signal);
    await f.ready;
    const schema = f.events[0]!.data.form_schema as {properties: {answers: {properties: {scope: {title: string; description: string; properties: {answers: {maxItems: number; items: {enum: string[]; anyOf: unknown[]}}}}}}}};
    const field = schema.properties.answers.properties.scope;
    const validator = new Ajv2020.default({strict: false}).compile(schema);
    assert.equal(validator({answers: {scope: {answers: ["Small", "Large"]}}}), true);
    assert.equal(validator({answers: {scope: {answers: ["Small", "Small"]}}}), false);
    assert.equal(validator({answers: {scope: {answers: ["Unknown"]}}}), false);
    assert.equal(field.title, " Native heading ");assert.equal(field.description, "Pick a scope");
    assert.deepEqual(field.properties.answers.items.enum, ["Small", "Large"]);assert.equal(field.properties.answers.maxItems, 16);
    assert.deepEqual(field.properties.answers.items.anyOf, [{const: "Small", description: " One file \n"}, {const: "Large", description: ""}]);
    assert.throws(() => f.owner.respondInput(f.input({answers: {scope: {answers: ["Small", "Small"]}}})));
    const value = {answers: {scope: {answers: ["Small", "Large"]}}};f.owner.respondInput(f.input(value));assert.deepEqual(await result, value);
  } finally {f.owner.close();}
});
test("native question annotations preserve open answers and repeated native choice labels", async () => {
  const f = fixture();try {
    const result = f.owner.questions({...binding, questions: [{id: "scope", header: "", question: "Pick or enter",
      isOther: true, options: [{label: "A", description: "First"}, {label: "A", description: "Second"}]}]}, f.signal.signal);
    await f.ready;
    const schema = f.events[0]!.data.form_schema as {properties: {answers: {properties: {scope: {title: string; properties: {answers: {items: {anyOf: unknown[]; enum?: unknown}}}}}}}};
    const field = schema.properties.answers.properties.scope;assert.equal(field.title, "");
    const validator = new Ajv2020.default({strict: false}).compile(schema);
    assert.equal(validator({answers: {scope: {answers: ["A"]}}}), true);
    assert.equal(validator({answers: {scope: {answers: ["Exact custom answer"]}}}), true);
    assert.equal(validator({answers: {scope: {answers: [""]}}}), false);
    assert.equal(field.properties.answers.items.enum, undefined);
    assert.deepEqual(field.properties.answers.items.anyOf, [{const: "A", description: "First"}, {const: "A", description: "Second"}, {type: "string", minLength: 1, maxLength: 8192}]);
    const value = {answers: {scope: {answers: ["Exact custom answer"]}}};f.owner.respondInput(f.input(value));assert.deepEqual(await result, value);
  } finally {f.owner.close();}
});

test("free native question answers use the JSON Schema Unicode length boundary", async () => {
  for (const options of [undefined, [{label: "A", description: "Choice"}]]) {
    const f = fixture();try {
      const result = f.owner.questions({...binding, questions: [{id: "answer", header: "Answer", question: "Enter an answer", isOther: true,
        ...(options ? {options} : {})}]}, f.signal.signal);
      await f.ready;
      const schema = f.events[0]!.data.form_schema as Record<string, unknown>;
      const validator = new Ajv2020.default({strict: false}).compile(schema);
      const value = (length: number) => ({answers: {answer: {answers: ["😀".repeat(length)]}}});
      assert.equal(validator(value(8192)), true);assert.equal(validator(value(8193)), false);
      assert.throws(() => f.owner.respondInput(f.input(value(8193))));
      f.owner.respondInput(f.input(value(8192)));assert.deepEqual(await result, value(8192));
    } finally {f.owner.close();}
  }
});
