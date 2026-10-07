import assert from "node:assert/strict";
import {test} from "node:test";
import {createHcpEnvelope, type HcpHarnessEventPayload, type HcpMessage, type HcpSessionStartPayload} from "@harness-control/protocol";
import {HcpHostConnection, HcpNativeSessions, HcpNativeSessionError} from "./index.js";
const payload: HcpSessionStartPayload = {session_id: "physical", workspace_id: "workspace", provider_instance_id: "native", driver_kind: "codex",
  cwd: "/fixture", execution_profile: "interactive", continuation_group_key: "conversation", model_selection: {model: "fixture-model"},
  sandbox_mode: "read_only", approval_policy: "ask", continue_session: false, mcp_servers: []};
function fixture(mode: "auto" | "ack" | "lazy" | "disconnect" | "stop_disconnect" = "auto") {
  const sent: HcpMessage[] = [], sequences = new Map<string, number>();let peer: HcpHostConnection;
  const event = (session: string, type: HcpHarnessEventPayload["event_type"], data: HcpHarnessEventPayload["data"], sequence?: number) => {
    const next = sequence ?? (sequences.get(session) ?? 0) + 1;sequences.set(session, next);
    return peer.receive(createHcpEnvelope("harness.event", {session_id: session, sequence: next, event_type: type, created_at: "2026-10-07T00:00:00Z", data}));
  };
  const configured = (session = "physical", profile = "interactive", native = true) => event(session, "session.configured",
    {execution_profile: profile, ...(native ? {native_conversation_ready: true, native_reference: "actual-native-thread"} : {})});
  const exited = (session = "physical", provider = "native", physical = true) => event(session, "session.exited",
    {provider_instance_id: provider, ...(physical ? {native_owner_closed: true} : {})});
  let beforeAck: (() => void) | undefined;
  peer = new HcpHostConnection({send(message) {
    sent.push(message);
    if (message.type !== "harness.session.start" && message.type !== "harness.session.stop") return;
    if (mode === "disconnect" || mode === "stop_disconnect" && message.type === "harness.session.stop") {peer.disconnect();return;}
    if (mode !== "ack" && message.type === "harness.session.start") configured(message.payload.session_id, "interactive", mode !== "lazy");
    if (["auto", "lazy"].includes(mode) && message.type === "harness.session.stop") exited(message.payload.session_id);
    beforeAck?.();
    peer.receive(createHcpEnvelope("hcp.command.ack", {command_id: message.id, duplicate: false, accepted_at: "2026-10-07T00:00:00Z"}));
  }});
  peer.receive(createHcpEnvelope("host.hello", {runner_id: "fixture", host_id: "fixture", runner_version: "0.5.0", capabilities: [], supported_protocol_versions: ["hcp.v0"]}));
  peer.accept({protocol_version: "hcp.v0", heartbeat_interval_seconds: 30});
  return {peer, sent, event, configured, exited, beforeAck: (hook: () => void) => {beforeAck = hook;}, sessions: new HcpNativeSessions(peer)};
}
const outcome = (expected: HcpNativeSessionError["outcome"]) => (error: unknown) => error instanceof HcpNativeSessionError && error.outcome === expected;
test("same-owner policy confirmation updates native session observations while preserving immutable launch authority", async () => {
  const f = fixture(); try {
    await f.sessions.open(payload);
    f.event("physical", "session.configured", {execution_profile: "interactive", native_conversation_ready: true,
      native_reference: "actual-native-thread", mode: "execute", policy_revision: 1});
    const state = f.sessions.state("physical")!;
    assert.equal(state.phase, "active"); assert.equal((state.configured!.data as {policy_revision?: number}).policy_revision, 1);
    assert.equal(state.payload.approval_policy, "ask");
  } finally {f.sessions.dispose();}
});
test("configured observations from another physical native owner fence the active SDK generation", async () => {
  const f = fixture(); try {
    await f.sessions.open(payload);
    f.event("physical", "session.configured", {execution_profile: "interactive", native_conversation_ready: true,
      native_reference: "another-native-thread", mode: "execute", policy_revision: 1});
    assert.equal(f.sessions.state("physical")!.phase, "unconfirmed");
  } finally {f.sessions.dispose();}
});
test("public native ownership captures proof before ACK, copies state and permits a successor only after physical closure", async () => {
  const f = fixture();try {
    const active = await f.sessions.open(payload);assert.equal(active.phase, "active");active.payload.cwd = "/changed";
    assert.equal(f.sessions.state("physical")!.payload.cwd, "/fixture");
    await assert.rejects(f.sessions.open({...payload, session_id: "successor"}), outcome("not_sent"));
    assert.equal((await f.sessions.close("physical")).phase, "closed");await f.sessions.close("physical");
    assert.equal(f.sent.filter(message => message.type === "harness.session.stop").length, 1);
    assert.equal((await f.sessions.open({...payload, session_id: "successor", continue_session: true})).phase, "active");
  } finally {f.sessions.dispose();f.peer.disconnect();}
});
test("public lifecycle refuses ACK-only, wrong profile, foreign exit and logical retirement as native proof", async () => {
  const f = fixture("ack");try {
    const opening = f.sessions.open(payload);f.configured("physical", "background");assert.equal(f.sessions.state("physical")!.phase, "opening");
    f.configured();await opening;
    const closing = f.sessions.close("physical");await assert.rejects(f.sessions.close("physical"), outcome("not_sent"));
    f.exited("physical", "foreign");f.exited("physical", "native", false);await Promise.resolve();assert.equal(f.sessions.state("physical")!.phase, "closing");
    f.exited();assert.equal((await closing).phase, "closed");
  } finally {f.sessions.dispose();f.peer.disconnect();}
});
test("public unknown startup holds continuation ownership without retry", async () => {
  const f = fixture("disconnect");try {
    await assert.rejects(f.sessions.open(payload), outcome("unknown"));assert.equal(f.sessions.state("physical")!.phase, "unconfirmed");
    await assert.rejects(f.sessions.open({...payload, session_id: "successor"}), outcome("not_sent"));
    assert.equal(f.sent.filter(message => message.type === "harness.session.start").length, 1);
  } finally {f.sessions.dispose();}
});
test("public unknown unload cannot be replayed with a fresh command identity", async () => {
  const f = fixture("stop_disconnect");try {
    await f.sessions.open(payload);await assert.rejects(f.sessions.close("physical"), outcome("unknown"));
    await assert.rejects(f.sessions.close("physical"), outcome("not_sent"));
    assert.equal(f.sent.filter(message => message.type === "harness.session.stop").length, 1);
  } finally {f.sessions.dispose();}
});
test("aborted readiness never sends cancellation or lets late native readiness restore commit authority", async () => {
  const f = fixture("ack"), abort = new AbortController();try {
    const opening = f.sessions.open(payload, {signal: abort.signal});const failed = assert.rejects(opening, outcome("unconfirmed"));abort.abort();await failed;
    f.configured();assert.equal(f.sessions.state("physical")!.phase, "unconfirmed");
    assert.equal(f.sent.some(message => message.type === "harness.session.stop" || message.type === "harness.turn.cancel"), false);
    const closing = f.sessions.close("physical");f.exited();assert.equal((await closing).phase, "closed");
  } finally {f.sessions.dispose();f.peer.disconnect();}
});
test("lazy startup reserves dispatch authority and captures actual readiness which arrived before ACK", async () => {
  const f = fixture("lazy");try {
    const reserved = await f.sessions.open(payload, {readiness: "configured"});assert.equal(reserved.phase, "reserved");
    assert.equal((reserved.configured!.data as {native_reference?: string}).native_reference, undefined);
    f.configured();assert.equal(f.sessions.state("physical")!.phase, "active");
    await f.sessions.close("physical");
    f.beforeAck(() => {f.configured("successor");});
    assert.equal((await f.sessions.open({...payload, session_id: "successor", continue_session: true}, {readiness: "configured"})).phase, "active");
  } finally {f.sessions.dispose();f.peer.disconnect();}
});
test("owner loss, continuity gaps and disconnect fence active generations without accepting later readiness", async () => {
  for (const loss of ["owner", "gap", "disconnect"] as const) {
    const f = fixture();try {
      await f.sessions.open(payload);
      if (loss === "owner") f.event("physical", "native.work.owner_lost", {reason: "native_exit"});
      else if (loss === "gap") f.event("physical", "runtime.warning", {code: "fixture"}, 3);
      else f.peer.disconnect();
      assert.equal(f.sessions.state("physical")!.phase, "unconfirmed");
      if (loss === "owner") {f.configured();assert.equal(f.sessions.state("physical")!.phase, "unconfirmed");}
    } finally {f.sessions.dispose();f.peer.disconnect();}
  }
});
test("generation replay, missing startup contract and disposed registry refuse without damaging a known owner", async () => {
  const f = fixture();try {
    await f.sessions.open(payload);await assert.rejects(f.sessions.open(payload), outcome("not_sent"));
    assert.equal(f.sessions.state("physical")!.phase, "active");
    const {execution_profile: _profile, ...missing} = payload;
    await assert.rejects(f.sessions.open({...missing, session_id: "missing"}), outcome("not_sent"));
    f.sessions.dispose();assert.equal(f.sessions.state("physical")!.phase, "unconfirmed");
    await assert.rejects(f.sessions.open({...payload, session_id: "successor"}), outcome("not_sent"));
    assert.equal(f.sent.filter(message => message.type === "harness.session.start").length, 1);
  } finally {f.sessions.dispose();f.peer.disconnect();}
});
test("session observation listeners are copied, isolate failures and never publish a duplicate event twice", () => {
  const f = fixture("ack"), observed: unknown[] = [];let failed = 0;
  const first = f.peer.subscribeSessionObservations(value => {if (value.kind === "event") (value.event.data as {execution_profile?: string}).execution_profile = "changed";});
  const second = f.peer.subscribeSessionObservations(() => {failed++;throw new Error("fixture observer failure");});
  const third = f.peer.subscribeSessionObservations(value => observed.push(value));
  f.configured();f.event("physical", "session.configured", {execution_profile: "interactive", native_reference: "actual-native-thread", native_conversation_ready: true}, 1);
  assert.equal(observed.length, 1);assert.equal(failed, 1);
  assert.equal((observed[0] as {event: {data: {execution_profile: string}}}).event.data.execution_profile, "interactive");
  f.peer.disconnect();assert.equal(observed.length, 2);assert.equal(failed, 1);
  first();second();third();f.sessions.dispose();
});

test("an exit before startup ACK prevents late configuration from claiming an active owner", async () => {
  const f = fixture();try {
    f.beforeAck(() => {f.exited();});
    await assert.rejects(f.sessions.open(payload), outcome("unconfirmed"));
    assert.equal(f.sessions.state("physical")!.phase, "unconfirmed");
    f.configured();assert.equal(f.sessions.state("physical")!.phase, "unconfirmed");
  } finally {f.sessions.dispose();f.peer.disconnect();}
});

test("a new SDK registry can acquire a closed retained conversation using its expected native identity", async () => {
  const f = fixture();try {
    await f.sessions.open(payload);await f.sessions.close("physical");f.sessions.dispose();
    const next = new HcpNativeSessions(f.peer);try {
      const restored = await next.open({...payload, session_id: "cold", continue_session: true, expected_native_reference: "actual-native-thread"});assert.equal(restored.phase, "active");
      const sent = f.sent.find(message => message.type === "harness.session.start" && message.payload.session_id === "cold")!;assert.equal(sent.type, "harness.session.start");if (sent.type === "harness.session.start") assert.equal(sent.payload.expected_native_reference, "actual-native-thread");
    } finally {next.dispose();}
  } finally {f.sessions.dispose();f.peer.disconnect();}
});
test("SDK cold acquisition fences substituted native readiness before becoming active", async () => {
  const f = fixture();try {
    await assert.rejects(f.sessions.open({...payload, continue_session: true, expected_native_reference: "foreign"}), outcome("unconfirmed"));assert.equal(f.sessions.state("physical")!.phase, "unconfirmed");
    assert.equal(f.sent.some(message => message.type === "harness.turn.send"), false);
  } finally {f.sessions.dispose();f.peer.disconnect();}
});
test("late lazy native readiness cannot substitute the cold continuation's expected owner", async () => {
  const f = fixture("lazy");try {
    const reserved = await f.sessions.open({...payload, continue_session: true, expected_native_reference: "foreign"}, {readiness: "configured"});assert.equal(reserved.phase, "reserved");
    f.configured();assert.equal(f.sessions.state("physical")!.phase, "unconfirmed");
  } finally {f.sessions.dispose();f.peer.disconnect();}
});
