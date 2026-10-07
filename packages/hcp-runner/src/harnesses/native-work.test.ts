import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtemp, realpath, rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {hcpConversationRequestPayloadSchema, hcpConversationResultPayloadSchema, type HarnessNativeWorkObservation, type HcpConversationRequestPayload, type HcpSessionStartPayload} from "@harness-control/protocol";
import {HarnessSessionManager, HarnessAdapterRegistry, type HarnessAdapter, type HarnessAdapterEvent} from "./index.js";
import {RunnerConfigSchema} from "../config/index.js";
import {JsonRunnerStateStore} from "../state/index.js";

async function fixture(historyMode?: "supported" | "changed" | "lost" | "undeclared", custodyMode = false) {
  const cwd = await mkdtemp(join(tmpdir(), "hcp-native-work-"));
  const path = join(cwd, "state.json");
  let emit!: (event: HarnessAdapterEvent) => void;
  let calls = 0;
  let lost = false;
  let acknowledgementOnly = false;
  let loseOwnerDuringCancel = false;
  const work = (work_id = "child", status: HarnessNativeWorkObservation["status"] = "running", parent_work_id?: string): HarnessNativeWorkObservation =>
    ({work_id, native_reference: `native-${work_id}`, origin_turn_id: "turn", kind: custodyMode ? "agent" : "task", background: true, status, supports_cancel: true, ...(parent_work_id ? {parent_work_id} : {})});
  const publish = (value: HarnessNativeWorkObservation) => emit({event_type: "native.work.updated", data: {work: value}});
  const driverKind = custodyMode ? "codex" : "example";
  const adapter: HarnessAdapter = {driverKind, sessionEvents: true, nativeWork: true,
    ...(custodyMode ? {emptyConversation: true} : {}),
    ...(historyMode ? {executionProfiles: [{id: "interactive", runtime_lifetime: "session" as const, native_work: true, session_events: true,
      ...(custodyMode ? {retained_native_work_history: true, native_work_fork: true} : {}),
      ...(historyMode === "undeclared" ? {} : {native_work_history: "live_owner" as const})}],
      async readNativeWorkHistory() {
        if (historyMode === "changed") publish(work("child", "waiting"));
        if (historyMode === "lost") emit({event_type: "native.work.owner_lost", data: {reason: "native_exit"}});
        return {history_hash: "a".repeat(64), turn_count: 0, truncated: false, turns: []};
      }} : {}),
    async probe() {return {driver_kind: driverKind, installed: true, available: true, models: []};}, async validateStart() {},
    async startSession(input) {emit = input.emitSessionEvent!; return {adapter_session_id: "native", ...(custodyMode ? {native_thread_id: "native-root"} : {})};},
    async sendTurn(input) {publish(work()); return [{event_type: "turn.completed", turn_id: input.payload.turn_id, data: {final_output: {final_text: "done"}}}];},
    async cancelTurn() {return [];}, async stopSession() {return [];},
    async cancelNativeWork(input) {
      calls++;
      assert.equal(state.nativeWorkState("session")!.items[input.work.work_id]!.control?.phase, "pending", "intent is durable before dispatch");
      assert.equal(input.signal.aborted, false);
      if (loseOwnerDuringCancel) {
        emit({event_type: "native.work.owner_lost", data: {reason: "transport_lost"}});
        assert.equal(input.signal.aborted, true);
        return new Promise<void>(() => {});
      }
      if (lost) throw new Error("Lost native acknowledgement");
      if (!acknowledgementOnly) publish(work(input.work.work_id, "cancelled", input.work.parent_work_id));
    },
  };
  const config = RunnerConfigSchema.parse({runner_id: "runner", control_plane_url: "ws://localhost:1", workspaces: [{id: "workspace", path: cwd}], provider_instances: [{id: "provider", driver_kind: driverKind}]});
  const state = new JsonRunnerStateStore(path, {eventRetentionPerSession: 1});
  const makeManager = () => new HarnessSessionManager(config, {stateStore: new JsonRunnerStateStore(path, {eventRetentionPerSession: 1}), adapterRegistry: new HarnessAdapterRegistry([adapter])});
  const manager = new HarnessSessionManager(config, {stateStore: state, adapterRegistry: new HarnessAdapterRegistry([adapter])});
  const start: HcpSessionStartPayload = {session_id: "session", workspace_id: "workspace", cwd, provider_instance_id: "provider", driver_kind: driverKind, model_selection: {model: "example"}, sandbox_mode: "read_only", approval_policy: "ask", continue_session: false, mcp_servers: []};
  if (custodyMode) start.continuation_group_key = "root-conversation";
  await manager.startSession({...start, ...(historyMode ? {execution_profile: "interactive"} : {})});
  await manager.sendTurn({session_id: "session", turn_id: "turn", input: "run"});
  const operation = (operation: HcpConversationRequestPayload["operation"], command = "command", target = manager) => target.conversationOperation(command, hcpConversationRequestPayloadSchema.parse({session_id: "session", operation}));
  const read = async (target = manager) => {
    const result = hcpConversationResultPayloadSchema.parse(await operation({kind: "work", action: "read"}, "read", target));
    assert.equal(result.work?.action, "read");
    if (result.work?.action !== "read") throw new Error("Expected native work read");
    return result.work;
  };
  return {cwd, state, adapter, manager, makeManager, start, operation, read, work, publish, emit: (event: HarnessAdapterEvent) => emit(event),
    ownerLost: () => emit({event_type: "native.work.owner_lost", data: {reason: "native_exit"}}),
    loseOwnerDuringCancel: () => {loseOwnerDuringCancel = true;},
    get calls() {return calls;}, lose() {lost = true;}, acknowledgeOnly() {acknowledgementOnly = true;}, cleanup: () => rm(cwd, {recursive: true, force: true})};
}

test("child custody persists privately across restart and cannot be rebound or admitted by a lost owner", async () => {
  const f = await fixture(undefined, true);
  const proof = {source: "codex" as const, work_id: "child", native_reference: "native-child", origin_turn_id: "turn",
    root_native_reference: "native-root", parent_native_reference: "native-root", launch_native_reference: "native-launch"};
  const publish = (nativeWorkCustody = proof) => f.emit({event_type: "native.work.updated", data: {work: f.work("child", "waiting")}, nativeWorkCustody});
  try {
    publish();
    assert.deepEqual(f.state.nativeWorkState("session")!.custody!.child, proof);
    const reloaded = new JsonRunnerStateStore(join(f.cwd, "state.json"));
    assert.deepEqual(reloaded.nativeWorkState("session")!.custody!.child, proof);
    const events = reloaded.replayEventsAfter("session", reloaded.nextEventSequence("session") - 2)!;
    assert.equal(JSON.stringify(events).includes("native-launch"), false, "private custody never enters public events");
    // A duplicate public observation must still validate supplied admission evidence.
    assert.throws(() => publish({...proof, parent_native_reference: "foreign"}), /custody/);
    const state = f.state.nativeWorkState("session")!;
    state.custody!.child = {...proof, launch_native_reference: "replacement"};
    assert.throws(() => f.state.saveNativeWorkState("session", state), /cannot be replaced/);
    f.ownerLost();
    f.emit({event_type: "native.work.updated", data: {work: f.work("child", "completed")}});
    assert.deepEqual(f.state.nativeWorkState("session")!.custody!.child, proof);
  } finally {await f.cleanup();}
});

for (const scenario of ["confirmed", "foreign-root", "changed-execution", "lost-before-ack"] as const)
test(`native root dispatch admission is durable before acknowledgement (${scenario})`, async () => {
  const f = await fixture("supported", true);
  let admission = "";
  const emitted: import("@harness-control/protocol").HcpHarnessEventPayload[] = [];
  f.adapter.sendTurn = async input => {
    admission = input.beginNativeExecution!(scenario === "foreign-root" ? "foreign" : "native-root");
    const pending = new JsonRunnerStateStore(join(f.cwd, "state.json")).nativeWorkState("session")!.root_executions!.at(-1)!;
    assert.equal(pending.admission_id, admission); assert.equal(pending.native_execution_reference, undefined);
    if (scenario === "lost-before-ack") f.ownerLost();
    input.confirmNativeExecution!(admission, "native-execution");
    input.confirmNativeExecution!(admission, scenario === "changed-execution" ? "foreign-execution" : "native-execution");
    return [{event_type: "turn.completed", turn_id: input.payload.turn_id, data: {final_output: {final_text: "done"}}}];
  };
  try {
    const send = () => f.manager.sendTurn({session_id: "session", turn_id: "root-with-proof", input: "run"}, event => emitted.push(event));
    if (scenario === "confirmed") await send();
    else await assert.rejects(send(), scenario === "foreign-root" ? /confirmed root/ : scenario === "changed-execution" ? /changed its dispatch/ : /original live owner/);
    const roots = f.state.nativeWorkState("session")!.root_executions ?? [];
    assert.equal(roots.length, scenario === "foreign-root" ? 0 : 1);
    if (roots.length) assert.equal(roots[0]!.native_execution_reference, scenario === "lost-before-ack" ? undefined : "native-execution");
    assert.equal(emitted.filter(event => event.event_type === "native.execution.admitted").length,
      scenario === "confirmed" || scenario === "changed-execution" ? 1 : 0);
    if (scenario === "confirmed") {
      const state = f.state.nativeWorkState("session")!; state.root_executions![0]!.native_execution_reference = "replacement";
      assert.throws(() => f.state.saveNativeWorkState("session", state), /cannot be removed or replaced/);
    }
  } finally {await f.cleanup();}
});

test("lost root acknowledgement fences restart even without active children or an adapter uncertainty flag", async () => {
  const f = await fixture("supported", true);
  f.publish(f.work("child", "completed"));
  f.adapter.sendTurn = async input => {
    input.beginNativeExecution!("native-root");
    f.ownerLost();
    throw new Error("lost root ACK");
  };
  try {
    await assert.rejects(f.manager.sendTurn({session_id: "session", turn_id: "uncertain-root", input: "run"}), /lost root ACK/);
    assert.equal(f.state.nativeWorkState("session")!.closure_unconfirmed, true);
    assert.equal((await f.read()).closure_unconfirmed, true);
    await assert.rejects(f.makeManager().startSession({...f.start, session_id: "restart", execution_profile: "interactive", continue_session: true}), /unconfirmed|reclaim/i);
  } finally {await f.cleanup();}
});

for (const scenario of ["pause", "clear", "lost-ack", "wrong-generation", "stale"] as const)
test(`native goal controls retain exact command receipts (${scenario})`, async () => {
  const f = await fixture("supported", true);
  f.publish(f.work("child", "completed"));
  f.adapter.executionProfiles![0]!.native_goals = true;
  let calls = 0;
  const observation = {source: "native" as const, scope: "root" as const, native_reference: "native-root", objective: "Owned goal",
    native_created_at: 100, native_updated_at: 101, status: "paused" as const, tokens_used: 20, time_used_seconds: 2};
  f.adapter.controlNativeGoal = async input => {
    calls++;
    if (input.operation.action === "read") return {action: "read", source: "native", native_reference: "native-root", goal: observation};
    if (scenario === "stale") throw new Error("stale native generation");
    input.beginMutation!();
    const receipt = new JsonRunnerStateStore(join(f.cwd, "state.json")).nativeConversationForSession("session")!.conversation.goal_controls!.at(-1)!;
    assert.equal(receipt.phase, "pending");
    assert.equal(receipt.native_created_at, 100);
    if (scenario === "lost-ack") throw new Error("lost native ACK");
    return input.operation.action === "pause"
      ? {action: "pause", source: "native", native_reference: "native-root", target_native_created_at: scenario === "wrong-generation" ? 200 : 100,
          goal: {...observation, native_created_at: scenario === "wrong-generation" ? 200 : 100}}
      : {action: "clear", source: "native", native_reference: "native-root", target_native_created_at: 100, goal: null};
  };
  const operation = {kind: "goal" as const, action: scenario === "clear" ? "clear" as const : "pause" as const, expected_native_created_at: 100};
  try {
    const read = await f.operation({kind: "goal", action: "read"}, "goal-read");
    assert.equal(read.goal?.goal?.native_created_at, 100);
    assert.equal(f.state.nativeConversationForSession("session")!.conversation.goal_controls, undefined);
    if (scenario === "pause" || scenario === "clear") {
      const result = await f.operation(operation, "goal-control");
      assert.equal(result.goal?.action, operation.action);
      assert.equal(f.state.nativeConversationForSession("session")!.conversation.goal_controls![0]!.phase, "completed");
      assert.deepEqual(await f.operation(operation, "goal-control", f.makeManager()), result);
      assert.equal(calls, 2, "retained completed receipt is replayed without acquiring a native owner");
      await assert.rejects(f.operation({...operation, expected_native_created_at: 200}, "goal-control"), /different control parameters/);
    } else {
      await assert.rejects(f.operation(operation, "goal-control"), scenario === "stale" ? /stale native/ : /unknown outcome/);
      const receipt = f.state.nativeConversationForSession("session")!.conversation.goal_controls?.[0];
      assert.equal(receipt?.phase, scenario === "stale" ? undefined : "pending");
      if (scenario !== "stale") {
        await assert.rejects(f.operation(operation, "goal-control"), /will not be replayed/);
        await assert.rejects(f.operation(operation, "new-goal-control"), /uncertain/);
        await assert.rejects(async () => f.manager.sendTurn({session_id: "session", turn_id: "after-unknown", input: "run"}), /goal mutation|goal control/i);
        assert.equal(calls, 2);
        await f.operation({kind: "goal", action: "read"}, "inspect-after-unknown");
      }
    }
    f.ownerLost();
    await f.operation({kind: "goal", action: "read"}, "inspect-lost-owner");
    await assert.rejects(f.operation(operation, "mutate-lost-owner"), /original live conversation owner/);
  } finally {await f.cleanup();}
});

for (const scenario of ["confirmed", "without-ack", "foreign", "changed-status", "owner-lost"] as const)
test(`native phase completion requires its immutable acknowledged admission (${scenario})`, async () => {
  const f = await fixture("supported", true); f.publish(f.work("child", "completed"));
  f.adapter.executionProfiles![0]!.native_execution_outcomes = true;
  f.adapter.sendTurn = async input => {
    const admission = input.beginNativeExecution!("native-root");
    if (scenario !== "without-ack") input.confirmNativeExecution!(admission, "native-phase");
    if (scenario === "owner-lost") f.ownerLost();
    input.completeNativeExecution!(scenario === "foreign" ? "unowned" : admission, "completed", {final_text: "First phase finished"});
    input.completeNativeExecution!(admission, scenario === "changed-status" ? "failed" : "completed");
    return [{event_type: "turn.completed", turn_id: input.payload.turn_id, data: {final_output: {final_text: "Goal finished"}}}];
  };
  try {
    const run = () => f.manager.sendTurn({session_id: "session", turn_id: "phase-origin", input: "run"});
    if (scenario === "confirmed") {
      const events = await run(), retained = f.state.nativeWorkState("session")!.root_executions![0]!;
      assert.equal(retained.phase_status, "completed"); assert.equal(retained.requires_terminal_proof, true);
      assert.equal(events.filter(event => event.event_type === "native.execution.completed").length, 1);
      const outcome = events.find(event => event.event_type === "native.execution.completed")!.data as {native_execution_reference: string};
      assert.equal(outcome.native_execution_reference, "native-phase");
      retained.phase_status = "failed";
      assert.throws(() => f.state.saveNativeWorkState("session", {...f.state.nativeWorkState("session")!, root_executions: [retained]}), /cannot be removed or replaced/);
    } else {
      await assert.rejects(run(), scenario === "owner-lost" ? /original live owner/ : /acknowledged phase|original phase/);
      const retained = f.state.nativeWorkState("session")!.root_executions![0]!;
      assert.equal(retained.phase_status, scenario === "changed-status" ? "completed" : undefined);
      if (scenario === "owner-lost") {
        assert.equal(f.state.nativeWorkState("session")!.closure_unconfirmed, true);
        await assert.rejects(f.makeManager().startSession({...f.start, session_id: "restart", execution_profile: "interactive", continue_session: true}), /unconfirmed|reclaim/);
      }
    }
  } finally {await f.cleanup();}
});

for (const scenario of ["confirmed", "pending", "foreign-generation", "undeclared"] as const)
test(`native goal admission retains job ownership independently of the child inventory (${scenario})`, async () => {
  const f = await fixture("supported", true);
  f.publish(f.work("child", "completed"));
  const goal = {action: "start" as const, objective: "Finish an explicit goal", token_budget: 100};
  f.adapter.executionProfiles![0]!.native_goals = scenario !== "undeclared";
  let called = false;
  f.adapter.sendTurn = async input => {
    called = true;
    const admission = input.beginNativeGoal!("native-root", goal);
    const pending = new JsonRunnerStateStore(join(f.cwd, "state.json")).nativeWorkState("session")!.goals![0]!;
    assert.equal(pending.admission_id, admission); assert.equal(pending.phase, "pending");
    if (scenario === "pending") throw new Error("lost goal ACK");
    const record = {source: "native" as const, scope: "root" as const, admission_id: admission, origin_turn_id: input.payload.turn_id,
      native_reference: "native-root", objective: goal.objective, token_budget: 100, native_created_at: 100, native_updated_at: 101,
      tokens_used: 10, time_used_seconds: 1, status: "active" as const};
    input.confirmNativeGoal!(record);
    if (scenario === "foreign-generation") input.confirmNativeGoal!({...record, native_created_at: 200});
    else {
      const phase = input.beginNativeExecution!("native-root", admission, true);
      input.confirmNativeExecution!(phase, "autonomous-phase");
      input.confirmNativeGoal!({...record, native_updated_at: 102, status: "complete"});
    }
    return [{event_type: "turn.completed", turn_id: input.payload.turn_id, data: {final_output: {final_text: "done"}}}];
  };
  try {
    const send = async () => f.manager.sendTurn({session_id: "session", turn_id: "goal-origin", input: "Begin", goal});
    if (scenario === "confirmed") {
      const events = await send();
      const retained = new JsonRunnerStateStore(join(f.cwd, "state.json")).nativeWorkState("session")!;
      assert.equal(retained.goals![0]!.snapshot?.status, "complete");
      assert.equal(retained.root_executions![0]!.goal_admission_id, retained.goals![0]!.admission_id);
      assert.equal(events.filter(event => event.event_type === "native.goal.updated").length, 2);
      assert.equal((events.find(event => event.event_type === "native.execution.admitted")?.data as {goal_admission_id?: string}).goal_admission_id, retained.goals![0]!.admission_id);
    } else {
      await assert.rejects(send(), scenario === "pending" ? /lost goal ACK/ : scenario === "undeclared" ? /advertise native goal/ : /cannot be removed, replaced/);
      assert.equal(called, scenario !== "undeclared");
      if (scenario !== "undeclared") {
        const retained = f.state.nativeWorkState("session")!;
        const restarted = f.makeManager();
        await assert.rejects(restarted.startSession({...f.start, session_id: "resume-goal", execution_profile: "interactive", continue_session: true}), /unconfirmed|reclaim|pending/i);
        assert.equal(retained.goals![0]!.phase, scenario === "pending" ? "pending" : "confirmed");
        assert.equal(retained.goals![0]!.snapshot?.native_created_at, scenario === "pending" ? undefined : 100);
      }
    }
  } finally {await f.cleanup();}
});

for (const scenario of ["exact", "foreign-metadata", "changed-ack"] as const)
test(`resume admits a new origin for only the requested native goal generation (${scenario})`, async () => {
  const f = await fixture("supported", true);
  f.publish(f.work("child", "completed")); f.adapter.executionProfiles![0]!.native_goals = true;
  const request = {action: "resume" as const, expected_native_created_at: 100};
  const retained = {source: "native" as const, scope: "root" as const, native_reference: "native-root", objective: "Retained objective",
    native_created_at: scenario === "foreign-metadata" ? 200 : 100, native_updated_at: 101, status: "paused" as const,
    tokens_used: 70, time_used_seconds: 20, token_budget: 100};
  f.adapter.sendTurn = async input => {
    const id = input.beginNativeGoal!("native-root", request, retained);
    const receipt = new JsonRunnerStateStore(join(f.cwd, "state.json")).nativeWorkState("session")!.goals!.at(-1)!;
    assert.equal(receipt.expected_native_created_at, 100); assert.equal(receipt.phase, "pending");
    input.confirmNativeGoal!({...retained, admission_id: id, origin_turn_id: input.payload.turn_id,
      native_created_at: scenario === "changed-ack" ? 200 : 100});
    return [{event_type: "turn.completed", turn_id: input.payload.turn_id, data: {final_output: {final_text: "Paused"}}}];
  };
  try {
    const run = () => f.manager.sendTurn({session_id: "session", turn_id: "resumed-origin", input: "", goal: request});
    if (scenario === "exact") {
      await run();
      const admitted = f.state.nativeWorkState("session")!.goals![0]!;
      assert.equal(admitted.origin_turn_id, "resumed-origin"); assert.equal(admitted.objective, retained.objective);
      assert.equal(admitted.snapshot?.tokens_used, 70); assert.equal(admitted.snapshot?.token_budget, 100);
    } else {
      await assert.rejects(run(), scenario === "foreign-metadata" ? /exact inactive/ : /Invalid native goal admission/);
      assert.equal(f.state.nativeWorkState("session")!.goals?.[0]?.phase, scenario === "changed-ack" ? "pending" : undefined);
    }
  } finally {await f.cleanup();}
});

for (const lost of [false, true])
test(`graceful stop settles admitted goal evidence without reopening a lost owner (${lost})`, async () => {
  const f = await fixture("supported", true);
  f.publish(f.work("child", "completed")); f.adapter.executionProfiles![0]!.native_goals = true;
  let hooks!: import("./adapters/types.js").HarnessAdapterTurnInput;
  let finish!: () => void, ready!: () => void;
  const admitted = new Promise<void>(resolve => {ready = resolve;});
  let record!: import("@harness-control/protocol").HarnessNativeGoalRecord;
  f.adapter.sendTurn = async input => {
    hooks = input;
    const goal = {action: "start" as const, objective: "Stop race"};
    const admission = input.beginNativeGoal!("native-root", goal);
    record = {source: "native", scope: "root", admission_id: admission, origin_turn_id: input.payload.turn_id, native_reference: "native-root",
      objective: goal.objective, native_created_at: 100, native_updated_at: 100, status: "active", tokens_used: 0, time_used_seconds: 0};
    input.confirmNativeGoal!(record); ready();
    await new Promise<void>(resolve => {finish = resolve;});
    return [{event_type: "turn.cancelled", turn_id: input.payload.turn_id, data: {status: "cancelled", final_output: {exit_reason: "cancel_requested"}}}];
  };
  f.adapter.stopSession = async () => {
    if (lost) f.ownerLost();
    if (lost) {
      assert.throws(() => hooks.confirmNativeGoal!({...record, native_updated_at: 101, status: "paused"}), /no longer available/);
      assert.throws(() => hooks.beginNativeExecution!("native-root", record.admission_id, true), /original live owner/);
    } else {
      assert.throws(() => hooks.beginNativeExecution!("native-root"), /original live owner/);
      const phase = hooks.beginNativeExecution!("native-root", record.admission_id, true);
      hooks.confirmNativeExecution!(phase, "raced-autonomous-phase");
      hooks.confirmNativeGoal!({...record, native_updated_at: 101, status: "paused"});
    }
    finish(); return [];
  };
  try {
    const run = f.manager.sendTurn({session_id: "session", turn_id: "stop-origin", input: "run", goal: {action: "start", objective: "Stop race"}});
    await admitted;
    if (lost) await assert.rejects(f.manager.stopSession("session", "stop"), /unconfirmed/);
    else {await f.manager.stopSession("session", "stop"); assert.equal(f.manager.activeSessionCount(), 0);}
    await run;
    const retained = f.state.nativeWorkState("session")!;
    assert.equal(retained.goals![0]!.snapshot?.status, lost ? "active" : "paused");
    assert.equal(retained.closure_unconfirmed, lost ? true : undefined);
  } finally {finish?.(); await f.cleanup();}
});

test("public root identity and execution admissions use the physical root while private bindings remain opaque", async () => {
  const f = await fixture("supported", true);
  const originalStart = f.adapter.startSession;
  f.adapter.executionProfiles![0]!.empty_conversation = true;
  f.adapter.startSession = async input => {
    await originalStart(input);
    return {adapter_session_id: input.payload.session_id, native_thread_id: "opaque-binding", native_work_root_reference: "physical-root"};
  };
  f.adapter.sendTurn = async input => {
    const admission = input.beginNativeExecution!("physical-root");
    input.confirmNativeExecution!(admission, "native-turn");
    return [{event_type: "turn.completed", turn_id: input.payload.turn_id, data: {final_output: {final_text: "done"}}}];
  };
  try {
    const events = await f.manager.startSession({session_id: "physical", continuation_group_key: "physical-key", workspace_id: "workspace", cwd: f.cwd,
      provider_instance_id: "provider", driver_kind: f.adapter.driverKind, execution_profile: "interactive", model_selection: {model: "example"},
      approval_policy: "ask", sandbox_mode: "read_only", continue_session: false, mcp_servers: []});
    assert.equal((events.find(event => event.event_type === "session.configured")!.data as {native_reference: string}).native_reference, "physical-root");
    assert.equal(f.state.getNativeConversation("physical-key")!.native_thread_id, "opaque-binding");
    const sent = await f.manager.sendTurn({session_id: "physical", turn_id: "physical-turn", input: "run"});
    assert.equal((sent.find(event => event.event_type === "native.execution.admitted")!.data as {native_reference: string}).native_reference, "physical-root");
    assert.equal(f.state.nativeWorkState("physical")!.root_executions![0]!.native_reference, "physical-root");
  } finally {await f.cleanup();}
});

test("retained child history requires durable custody and does not restore a lost execution owner", async () => {
  const f = await fixture("supported", true);
  const proof = {source: "codex" as const, work_id: "child", native_reference: "native-child", origin_turn_id: "turn",
    root_native_reference: "native-root", parent_native_reference: "native-root", launch_native_reference: "native-launch"};
  let reads = 0;
  f.adapter.readRetainedNativeWorkHistory = async input => {
    reads++;
    assert.deepEqual(input.custody, proof);
    assert.equal(input.scope.cwd, await realpath(f.cwd));
    return {history_hash: "a".repeat(64), turn_count: 0, truncated: false, turns: []};
  };
  const request = {kind: "work", action: "history", owner: "retained", work_id: "child", expected_revision: 1} as const;
  try {
    await assert.rejects(f.operation(request), /no declared retained/);
    assert.equal(reads, 0);
    f.emit({event_type: "native.work.updated", data: {work: f.work("child", "waiting")}, nativeWorkCustody: proof});
    f.ownerLost();
    const revision = f.state.nativeWorkState("session")!.items.child!.revision;
    const restarted = f.makeManager();
    const before = await f.read(restarted);
    await assert.rejects(f.operation(request, "stale", restarted), /current native-work revision/);
    const result = await f.operation({...request, expected_revision: revision}, "retained", restarted);
    assert.equal(result.work?.action, "history");
    if (result.work?.action === "history") assert.equal(result.work.owner_status, "retained");
    assert.deepEqual(await f.read(restarted), before);
    assert.equal(restarted.activeSessionCount(), 0);
    await assert.rejects(f.operation({...request, owner: "live", expected_revision: revision}, "live", restarted), /no declared live/);
    assert.equal(reads, 1);
  } finally {await f.cleanup();}
});

for (const outcome of ["confirmed", "changed", "unavailable"] as const)
test(`lost child reconciliation preserves session uncertainty and durable receipts (${outcome})`, async () => {
  const f = await fixture("supported", true);
  const profile = f.adapter.executionProfiles![0]!;
  profile.native_work_terminal_reconciliation = true;
  const proof = {source: "codex", work_id: "child", native_reference: "native-child", origin_turn_id: "turn",
    root_native_reference: "native-root", parent_native_reference: "native-root", launch_native_reference: "launch",
    native_execution_reference: "native-execution"};
  let inspections = 0;
  f.adapter.reconcileNativeWork = async input => {
    inspections++; assert.deepEqual(input.custody, proof);
    if (outcome === "unavailable") throw new Error("Native terminal proof unavailable");
    if (outcome === "changed") f.emit({event_type: "native.work.updated", data: {work: f.work("child", "completed")}});
    return {status: "completed"};
  };
  try {
    f.emit({event_type: "native.work.updated", data: {work: f.work("child", "waiting")}, nativeWorkCustody: proof});
    await assert.rejects(f.operation({kind: "work", action: "reconcile", work_id: "child", expected_revision: 2}), /lost physical owner/);
    assert.equal(inspections, 0);
    f.ownerLost();
    const revision = f.state.nativeWorkState("session")!.items.child!.revision;
    const request = {kind: "work", action: "reconcile", work_id: "child", expected_revision: revision} as const;
    await assert.rejects(f.operation({...request, expected_revision: revision - 1}), /current child revision/);
    if (outcome === "confirmed") {
      const response = await f.operation(request, "reconcile");
      assert.equal(response.work?.action, "reconcile");
      if (response.work?.action === "reconcile") {
        assert.equal(response.work.owner_status, "unavailable"); assert.equal(response.work.session_closure, "unconfirmed");
        assert.equal(response.work.revision, revision + 1);
      }
      assert.equal(f.state.nativeWorkState("session")!.closure_unconfirmed, true);
      assert.deepEqual(await f.operation(request, "reconcile", f.makeManager()), response);
      assert.equal(inspections, 1);
      await assert.rejects(f.operation({...request, expected_revision: revision + 1}, "reconcile"), /different parameters/);
      const state = f.state.nativeWorkState("session")!; delete state.reconciliations;
      assert.throws(() => f.state.saveNativeWorkState("session", state), /receipts/);
    } else {
      await assert.rejects(f.operation(request, "reconcile"), outcome === "changed" ? /changed during/ : /unavailable/);
      assert.equal(f.state.nativeWorkState("session")!.reconciliations, undefined);
    }
    assert.equal(f.calls, 0, "reconciliation never repeats native cancellation");
  } finally {await f.cleanup();}
});

for (const outcome of ["confirmed", "projected", "lost", "precondition"] as const)
test(`child fork has durable independent ownership and never repeats unknown dispatch (${outcome})`, async () => {
  const f = await fixture("supported", true);
  if (outcome === "projected") f.adapter.publicNativeReference = reference => reference === "independent-fork" ? "public-child-fork" : reference;
  const proof = {source: "codex" as const, work_id: "child", native_reference: "native-child", origin_turn_id: "turn",
    root_native_reference: "native-root", parent_native_reference: "native-root", launch_native_reference: "native-launch"};
  let calls = 0;
  f.adapter.forkNativeWork = async input => {
    if (outcome === "precondition") throw new Error("Stale native history");
    input.beginMutation(); calls++;
    assert.equal(f.state.nativeWorkState("session")!.forks![0]!.phase, "pending");
    if (outcome === "lost") throw new Error("Lost fork response");
    return {native_reference: "independent-fork"};
  };
  const operation = {kind: "work", action: "fork", work_id: "child", expected_revision: 2,
    expected_history_hash: "a".repeat(64), target_session_id: "target", continuation_group_key: "fork-conversation"} as const;
  try {
    f.emit({event_type: "native.work.updated", data: {work: f.work("child", "completed")}, nativeWorkCustody: proof});
    if (outcome === "confirmed" || outcome === "projected") {
      const response = await f.operation(operation, "fork");
      assert.ok(response.work?.action === "fork");
      assert.equal(response.work.fork.native_reference, outcome === "projected" ? "public-child-fork" : "independent-fork");
      assert.equal(f.state.getNativeConversation("fork-conversation")!.native_thread_id, "independent-fork");
      assert.deepEqual(await f.operation(operation, "fork", f.makeManager()), response);
      assert.equal(calls, 1);
      await assert.rejects(f.operation({...operation, target_session_id: "foreign"}, "fork"), /different parameters/);
      await f.operation({kind: "work", action: "retire", work_id: "child", expected_revision: 2}, "retire-child");
      assert.deepEqual(await f.operation(operation, "fork", f.makeManager()), response);
    } else {
      await assert.rejects(f.operation(operation, "fork"), outcome === "lost" ? /unknown outcome/ : /Stale native/);
      if (outcome === "lost") {
        await assert.rejects(f.operation(operation, "fork", f.makeManager()), /will not be repeated/);
        const state = f.state.nativeWorkState("session")!;
        delete state.forks;
        assert.throws(() => f.state.saveNativeWorkState("session", state), /cannot be removed/);
        assert.equal(calls, 1);
      } else {assert.equal(f.state.nativeWorkState("session")!.forks, undefined); assert.equal(calls, 0);}
    }
    assert.equal((f.state.nativeWorkState("session")!.items.child ?? f.state.nativeWorkState("session")!.retired.child)!.status, "completed");
  } finally {await f.cleanup();}
});

test("native owner loss fences task controls without inventing terminal execution and permits closure proof", async () => {
  const f = await fixture();
  try {
    f.ownerLost();
    assert.equal((await f.read()).owner_status, "unavailable");
    assert.equal((await f.read()).items[0]!.owner_status, "unavailable");
    assert.equal((await f.read()).items[0]!.work.status, "running");
    await assert.rejects(f.operation({kind: "work", action: "cancel", work_id: "child", expected_revision: 1}), /no live native cancellation owner/);
    assert.equal(f.calls, 0);
    assert.throws(() => f.publish(f.work("new")), /cannot admit active work/);
    assert.throws(() => f.publish(f.work("new", "completed")), /cannot admit active work/);
    f.publish(f.work("child", "unknown"));
    await assert.rejects(f.manager.stopSession("session", "stop"), /closure is unconfirmed/);
    f.publish(f.work("child", "completed"));
    await f.manager.stopSession("session", "closed");
    assert.equal((await f.read(f.makeManager())).items[0]!.work.status, "completed");
    assert.throws(f.ownerLost, /owner is no longer active/);
  } finally {await f.cleanup();}
});

test("owner loss during native cancellation aborts promptly and preserves its pending fence", async () => {
  const f = await fixture();
  try {
    f.loseOwnerDuringCancel();
    const cancel = {kind: "work", action: "cancel", work_id: "child", expected_revision: 1} as const;
    await assert.rejects(f.operation(cancel, "cancel"), /unknown outcome/);
    assert.equal((await f.read()).owner_status, "unavailable");
    assert.equal((await f.read()).items[0]!.work.control?.phase, "pending");
    await assert.rejects(f.operation(cancel, "cancel"), /will not be repeated/);
    await assert.rejects(f.operation(cancel, "cancel", f.makeManager()), /will not be repeated/);
    assert.equal(f.calls, 1);
    f.publish(f.work("child", "cancelled"));
    await f.manager.stopSession("session", "closed");
  } finally {await f.cleanup();}
});

test("physical owner loss still fences cancellation when durable event persistence fails", async () => {
  const f = await fixture();
  const persist = f.state.persist.bind(f.state);
  try {
    f.state.persist = () => {throw new Error("Disk unavailable");};
    assert.throws(f.ownerLost, /Disk unavailable/);
    f.state.persist = persist;
    assert.equal((await f.read()).owner_status, "unavailable");
    await assert.rejects(f.operation({kind: "work", action: "cancel", work_id: "child", expected_revision: 1}), /no live native cancellation owner/);
    assert.equal(f.calls, 0);
  } finally {f.state.persist = persist; await f.cleanup();}
});

test("owner loss during cancellation publication prevents native dispatch", async () => {
  const f = await fixture();
  try {
    const unsubscribe = f.manager.subscribeEvents(event => {
      if (event.event_type === "native.work.updated" && (event.data as {work: {control?: {phase: string}}}).work.control?.phase === "pending") f.ownerLost();
    });
    const cancel = {kind: "work", action: "cancel", work_id: "child", expected_revision: 1} as const;
    await assert.rejects(f.operation(cancel, "cancel"), /ownership was lost/);
    unsubscribe();
    assert.equal(f.calls, 0);
    assert.equal((await f.read()).owner_status, "unavailable");
    await assert.rejects(f.operation(cancel, "cancel"), /will not be repeated/);
  } finally {await f.cleanup();}
});

test("failed cancellation persistence prevents native dispatch and leaves the prior revision", async () => {
  const f = await fixture();
  const persist = f.state.persist.bind(f.state);
  try {
    f.state.persist = () => {throw new Error("Disk unavailable");};
    await assert.rejects(f.operation({kind: "work", action: "cancel", work_id: "child", expected_revision: 1}), /Disk unavailable/);
    assert.equal(f.calls, 0);
    assert.equal(f.state.nativeWorkState("session")!.items.child!.revision, 1);
    assert.equal(f.state.nativeWorkState("session")!.items.child!.control, undefined);
  } finally {f.state.persist = persist; await f.cleanup();}
});

test("native cancellation acknowledgement does not invent terminal task completion", async () => {
  const f = await fixture();
  try {
    f.acknowledgeOnly();
    await f.operation({kind: "work", action: "cancel", work_id: "child", expected_revision: 1});
    const result = await f.read();
    assert.equal(result.items[0]!.work.status, "running");
    assert.equal(result.items[0]!.work.control?.phase, "accepted");
    await assert.rejects(f.manager.stopSession("session", "stop"), /closure is unconfirmed/);
  } finally {await f.cleanup();}
});

test("native work survives root completion and retention; cancellation is fenced and deduplicated", async () => {
  const f = await fixture();
  try {
    const before = await f.read();
    assert.equal(before.items[0]!.owner_status, "active");
    assert.equal(before.items[0]!.work.status, "running");
    const cancel = {kind: "work", action: "cancel", work_id: "child", expected_revision: 1} as const;
    await assert.rejects(f.operation({...cancel, expected_revision: 2}), /current native-work revision/);
    const result = await f.operation(cancel, "cancel");
    assert.equal(result.work?.action, "cancel");
    assert.deepEqual(await f.operation(cancel, "cancel"), result);
    assert.equal(f.calls, 1);
    const after = await f.read();
    assert.equal(after.items[0]!.work.status, "cancelled");
    assert.equal(after.items[0]!.work.control?.phase, "accepted");
    const restored = await f.read(f.makeManager());
    assert.equal(restored.items[0]!.owner_status, "unavailable");
    assert.equal(restored.items[0]!.work.status, "cancelled");
    await f.manager.stopSession("session", "done");
    const revision = (await f.read()).items[0]!.work.revision;
    await f.operation({kind: "work", action: "retire", work_id: "child", expected_revision: revision});
    assert.equal(f.state.hasSessionExit("session"), true);
    assert.deepEqual(await f.manager.stopSession("session", "duplicate"), []);
    assert.deepEqual(await f.makeManager().stopSession("session", "restart"), []);
  } finally {await f.cleanup();}
});

test("unknown native cancellation never repeats across retry or restart and retains the execution lease", async () => {
  const f = await fixture();
  try {
    f.lose();
    const cancel = {kind: "work", action: "cancel", work_id: "child", expected_revision: 1} as const;
    await assert.rejects(f.operation(cancel, "cancel"), /unknown outcome/);
    await assert.rejects(f.operation(cancel, "cancel"), /will not be repeated/);
    await assert.rejects(f.operation({...cancel, expected_revision: 2}, "new"), /requires reconciliation/);
    await assert.rejects(f.operation(cancel, "cancel", f.makeManager()), /will not be repeated/);
    assert.equal(f.calls, 1);
    await assert.rejects(f.manager.stopSession("session", "stop"), /closure is unconfirmed/);
    assert.equal(f.manager.activeSessionCount(), 1);
    assert.equal((await f.read()).owner_status, "unavailable");
    f.publish(f.work("child", "cancelled"));
    assert.equal((await f.operation(cancel, "cancel")).work?.action, "cancel");
    assert.equal(f.calls, 1);
    await f.manager.stopSession("session", "closed");
  } finally {await f.cleanup();}
});

test("owned task observations enforce identity, parentage, terminal status and cursor freshness", async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.publish({...f.work(), native_reference: "other"}), /identity and origin/);
    assert.throws(() => f.publish({...f.work("foreign"), origin_turn_id: "unadmitted"}), /admitted origin/);
    assert.throws(() => f.publish(f.work("orphan", "running", "constructor")), /owned parent/);
    f.publish(f.work("constructor", "running", "child"));
    f.publish(f.work("__proto__", "running", "constructor"));
    assert.equal((await f.read(f.makeManager())).total_count, 3);
    const first = await f.operation({kind: "work", action: "read", limit: 1});
    assert.equal(first.work?.action, "read");
    if (first.work?.action !== "read") throw new Error("Expected page");
    const cursor = first.work.next_cursor!;
    await f.operation({kind: "work", action: "read", cursor, limit: 1});
    f.publish(f.work("child", "completed"));
    await assert.rejects(f.operation({kind: "work", action: "read", cursor}), /changed|stale/i);
    assert.throws(() => f.publish(f.work()), /cannot return/);
    await assert.rejects(f.operation({kind: "work", action: "retire", work_id: "constructor", expected_revision: 1}), /Only completed/);
    await f.operation({kind: "work", action: "retire", work_id: "child", expected_revision: 2});
    f.publish(f.work("child", "completed")); // Late duplicate terminal proof is harmless.
    assert.throws(() => f.publish(f.work()), /retired/);
  } finally {await f.cleanup();}
});

test("terminal proof delivered during cancellation publication prevents native dispatch", async () => {
  const f = await fixture();
  try {
    let delivered = false;
    f.manager.subscribeEvents(event => {
      const work = (event.data as {work?: {control?: {phase?: string}}}).work;
      if (!delivered && work?.control?.phase === "pending") {delivered = true; f.publish(f.work("child", "completed"));}
    });
    const result = await f.operation({kind: "work", action: "cancel", work_id: "child", expected_revision: 1}, "cancel");
    assert.equal(result.work?.action === "cancel" && result.work.already_terminal, true);
    assert.equal(f.calls, 0);
  } finally {await f.cleanup();}
});

for (const mode of ["supported", "changed", "lost", "undeclared"] as const)
test(`owned native child history requires live declared unchanged ownership (${mode})`, async () => {
  const f = await fixture(mode);
  try {
    const request = {kind: "work" as const, action: "history" as const, work_id: "child", expected_revision: 1};
    await assert.rejects(f.operation({...request, expected_revision: 2}), /current native-work revision/);
    await assert.rejects(f.operation({...request, work_id: "foreign"}), /not owned/);
    if (mode === "supported") {
      const result = hcpConversationResultPayloadSchema.parse(await f.operation(request));
      assert.deepEqual(result.work, {action: "history", work_id: "child", revision: 1, source: "native", owner_status: "active",
        history: {history_hash: "a".repeat(64), turn_count: 0, truncated: false, turns: []}});
      f.ownerLost();
      await assert.rejects(f.operation(request), /no declared live native history owner/);
      await assert.rejects(f.operation(request, "offline", f.makeManager()), /no declared live native history owner/);
    } else await assert.rejects(f.operation(request), mode === "changed" ? /changed during/ : mode === "lost" ? /lost during/ : /no declared/);
    assert.equal(f.calls, 0);
  } finally {await f.cleanup();}
});
