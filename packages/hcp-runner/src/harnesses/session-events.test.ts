import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtemp, rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {HcpSessionEventReducer, type HcpHarnessEventPayload, type HcpSessionStartPayload} from "@harness-control/protocol";
import {HarnessSessionManager, HarnessAdapterRegistry, type HarnessAdapter, type HarnessAdapterEvent} from "./index.js";
import {RunnerConfigSchema} from "../config/index.js";
import {JsonRunnerStateStore} from "../state/index.js";

const observation = (phase: string): HarnessAdapterEvent => ({event_type: "extension.example.observation", data: {summary: "Native observation", fields: {phase}}});

test("a reentrant observer has bounded publication admission and cannot block later observations", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "hcp-session-reentry-"));
  let emit!: (event: HarnessAdapterEvent) => void;
  const adapter: HarnessAdapter = {driverKind: "example", sessionEvents: true,
    async probe() {return {driver_kind: "example", installed: true, available: true, models: []};}, async validateStart() {},
    async startSession(input) {emit = input.emitSessionEvent!; return {adapter_session_id: "native"};},
    async sendTurn() {return [];}, async cancelTurn() {return [];}, async stopSession() {return [];} };
  const config = RunnerConfigSchema.parse({runner_id: "runner", control_plane_url: "ws://localhost:1", workspaces: [{id: "workspace", path: cwd}],
    provider_instances: [{id: "provider", driver_kind: "example"}]});
  const manager = new HarnessSessionManager(config, {stateStore: new JsonRunnerStateStore(join(cwd, "state.json")), adapterRegistry: new HarnessAdapterRegistry([adapter])});
  try {
    await manager.startSession({session_id: "session", workspace_id: "workspace", cwd, provider_instance_id: "provider", driver_kind: "example",
      model_selection: {model: "example"}, sandbox_mode: "read_only", approval_policy: "ask", continue_session: false, mcp_servers: []});
    const events: HcpHarnessEventPayload[] = [];
    const errors: unknown[] = [];
    manager.subscribeEvents(event => events.push(event));
    let count = 0;
    manager.subscribeEvents(() => emit(observation(String(++count))), error => errors.push(error));
    emit(observation("seed"));
    assert.equal(events.length, 128);
    assert.equal(errors.length, 1);
    assert.match(String(errors[0]), /backpressure|publication/i);
    assert.ok(events.every((event, index) => index === 0 || event.sequence === events[index - 1]!.sequence + 1));
    emit(observation("later"));
    assert.equal(events.length, 129);
    assert.equal((events.at(-1)!.data as {fields: {phase: string}}).fields.phase, "later");
    await manager.stopSession("session", "done");
  } finally {await rm(cwd, {recursive: true, force: true});}
});

test("session observations survive root completion, remain ordered under reentry and reject a closed owner", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "hcp-session-events-"));
  let emit!: (event: HarnessAdapterEvent) => void;
  const adapter: HarnessAdapter = {driverKind: "example", sessionEvents: true,
    async probe() {return {driver_kind: "example", installed: true, available: true, models: []};}, async validateStart() {},
    async startSession(input) {emit = input.emitSessionEvent!; emit(observation("startup")); return {adapter_session_id: "native"};},
    async sendTurn(input) {return [{event_type: "turn.completed", turn_id: input.payload.turn_id, data: {final_output: {final_text: "done"}}}];},
    async cancelTurn() {return [];}, async stopSession() {return [];} };
  const state = new JsonRunnerStateStore(join(cwd, "state.json"));
  const config = RunnerConfigSchema.parse({runner_id: "runner", control_plane_url: "ws://localhost:1", workspaces: [{id: "workspace", path: cwd}],
    provider_instances: [{id: "provider", driver_kind: "example"}]});
  const manager = new HarnessSessionManager(config, {stateStore: state, adapterRegistry: new HarnessAdapterRegistry([adapter])});
  const events: HcpHarnessEventPayload[] = [];
  let subscriberErrors = 0;
  manager.subscribeEvents(event => {if ((event.data as {fields?: {phase?: string}}).fields?.phase === "first") emit(observation("second"));});
  const unsubscribe = manager.subscribeEvents(event => events.push(event));
  manager.subscribeEvents(() => {throw new Error("Failed observer");}, () => {subscriberErrors++;});
  const start: HcpSessionStartPayload = {session_id: "session", workspace_id: "workspace", cwd, provider_instance_id: "provider", driver_kind: "example",
    model_selection: {model: "example"}, sandbox_mode: "read_only", approval_policy: "ask", continue_session: false, mcp_servers: []};
  try {
    const startup = await manager.startSession(start);
    assert.equal(startup[0]?.event_type, "session.started");
    assert.equal(startup.findIndex(event => event.event_type === "extension.example.observation"), 3);
    assert.equal(subscriberErrors, 1);
    await manager.sendTurn({session_id: "session", turn_id: "turn", input: "run"});
    const terminalIndex = events.findIndex(event => event.event_type === "turn.completed");
    emit(observation("first"));
    assert.equal(events[terminalIndex + 1]?.event_type, "extension.example.observation");
    assert.deepEqual(events.slice(-2).map(event => (event.data as {fields: {phase: string}}).fields.phase), ["first", "second"]);
    assert.throws(() => emit({event_type: "turn.completed", turn_id: "spoof", data: {final_output: {final_text: "invalid"}}}), /cannot publish root turns/);
    assert.throws(() => emit(observation("x".repeat(64 * 1024))), /bounded data/);
    const originalEnv = config.provider_instances[0]!.env;
    config.provider_instances[0]!.env = {ANOTHER_ACCOUNT: "true"};
    assert.throws(() => emit(observation("wrong-account")), /original provider configuration/);
    config.provider_instances[0]!.env = originalEnv;
    const reducer = new HcpSessionEventReducer();
    for (const event of events) assert.equal(reducer.applyEvent(event).outcome, "applied");
    const restored = new HarnessSessionManager(config, {stateStore: new JsonRunnerStateStore(join(cwd, "state.json")), adapterRegistry: new HarnessAdapterRegistry([adapter])});
    assert.deepEqual(restored.replayEventsAfter({sessions: [{session_id: "session", last_event_sequence: events[terminalIndex]!.sequence}]}).events,
      events.slice(terminalIndex + 1));
    await manager.stopSession("session", "done");
    assert.throws(() => emit(observation("late")), /owner is no longer active/);
    unsubscribe();
  } finally {await rm(cwd, {recursive: true, force: true});}
});
