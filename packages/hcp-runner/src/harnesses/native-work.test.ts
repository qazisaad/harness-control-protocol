import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtemp, rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {hcpConversationRequestPayloadSchema, hcpConversationResultPayloadSchema, type HarnessNativeWorkObservation, type HcpConversationRequestPayload, type HcpSessionStartPayload} from "@harness-control/protocol";
import {HarnessSessionManager, HarnessAdapterRegistry, type HarnessAdapter, type HarnessAdapterEvent} from "./index.js";
import {RunnerConfigSchema} from "../config/index.js";
import {JsonRunnerStateStore} from "../state/index.js";

async function fixture(historyMode?: "supported" | "changed" | "lost" | "undeclared") {
  const cwd = await mkdtemp(join(tmpdir(), "hcp-native-work-"));
  const path = join(cwd, "state.json");
  let emit!: (event: HarnessAdapterEvent) => void;
  let calls = 0;
  let lost = false;
  let acknowledgementOnly = false;
  let loseOwnerDuringCancel = false;
  const work = (work_id = "child", status: HarnessNativeWorkObservation["status"] = "running", parent_work_id?: string): HarnessNativeWorkObservation =>
    ({work_id, native_reference: `native-${work_id}`, origin_turn_id: "turn", kind: "task", background: true, status, supports_cancel: true, ...(parent_work_id ? {parent_work_id} : {})});
  const publish = (value: HarnessNativeWorkObservation) => emit({event_type: "native.work.updated", data: {work: value}});
  const adapter: HarnessAdapter = {driverKind: "example", sessionEvents: true, nativeWork: true,
    ...(historyMode ? {executionProfiles: [{id: "interactive", runtime_lifetime: "session" as const, native_work: true, session_events: true,
      ...(historyMode === "undeclared" ? {} : {native_work_history: "live_owner" as const})}],
      async readNativeWorkHistory() {
        if (historyMode === "changed") publish(work("child", "waiting"));
        if (historyMode === "lost") emit({event_type: "native.work.owner_lost", data: {reason: "native_exit"}});
        return {history_hash: "a".repeat(64), turn_count: 0, truncated: false, turns: []};
      }} : {}),
    async probe() {return {driver_kind: "example", installed: true, available: true, models: []};}, async validateStart() {},
    async startSession(input) {emit = input.emitSessionEvent!; return {adapter_session_id: "native"};},
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
  const config = RunnerConfigSchema.parse({runner_id: "runner", control_plane_url: "ws://localhost:1", workspaces: [{id: "workspace", path: cwd}], provider_instances: [{id: "provider", driver_kind: "example"}]});
  const state = new JsonRunnerStateStore(path, {eventRetentionPerSession: 1});
  const makeManager = () => new HarnessSessionManager(config, {stateStore: new JsonRunnerStateStore(path, {eventRetentionPerSession: 1}), adapterRegistry: new HarnessAdapterRegistry([adapter])});
  const manager = new HarnessSessionManager(config, {stateStore: state, adapterRegistry: new HarnessAdapterRegistry([adapter])});
  const start: HcpSessionStartPayload = {session_id: "session", workspace_id: "workspace", cwd, provider_instance_id: "provider", driver_kind: "example", model_selection: {model: "example"}, sandbox_mode: "read_only", approval_policy: "ask", continue_session: false, mcp_servers: []};
  await manager.startSession({...start, ...(historyMode ? {execution_profile: "interactive"} : {})});
  await manager.sendTurn({session_id: "session", turn_id: "turn", input: "run"});
  const operation = (operation: HcpConversationRequestPayload["operation"], command = "command", target = manager) => target.conversationOperation(command, hcpConversationRequestPayloadSchema.parse({session_id: "session", operation}));
  const read = async (target = manager) => {
    const result = hcpConversationResultPayloadSchema.parse(await operation({kind: "work", action: "read"}, "read", target));
    assert.equal(result.work?.action, "read");
    if (result.work?.action !== "read") throw new Error("Expected native work read");
    return result.work;
  };
  return {cwd, state, manager, makeManager, operation, read, work, publish,
    ownerLost: () => emit({event_type: "native.work.owner_lost", data: {reason: "native_exit"}}),
    loseOwnerDuringCancel: () => {loseOwnerDuringCancel = true;},
    get calls() {return calls;}, lose() {lost = true;}, acknowledgeOnly() {acknowledgementOnly = true;}, cleanup: () => rm(cwd, {recursive: true, force: true})};
}

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
