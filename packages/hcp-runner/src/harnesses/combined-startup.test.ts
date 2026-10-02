import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import type { HcpHarnessEventPayload, HcpSessionStartPayload } from "@harness-control/protocol";
import { HarnessSessionManager } from "./index.js";
import { HarnessAdapterRegistry, type HarnessAdapter } from "./adapters.js";
import { RunnerConfigSchema } from "../config/index.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "hcp-combined-start-"));
  const entered = deferred(), ready = deferred();
  let turns = 0;
  const adapter: HarnessAdapter = {
    driverKind: "test",
    async probe() { return {provider_instance_id: "test", driver_kind: "test", installed: true, available: true, status: "ready", models: []}; },
    async validateStart() {},
    async startSession(input) { entered.resolve(); await ready.promise; return {adapter_session_id: input.payload.session_id}; },
    async sendTurn(input) { turns++; return [{event_type: "turn.completed", turn_id: input.payload.turn_id, data: {status: "completed", final_output: {final_text: "OK"}}}]; },
    async cancelTurn() { return []; },
    async stopSession() { return []; },
  };
  const config = RunnerConfigSchema.parse({runner_id: "runner", control_plane_url: "ws://127.0.0.1:8787",
    workspaces: [{id: "repo", path: cwd}], provider_instances: [{id: "test", driver_kind: "test"}]});
  const manager = new HarnessSessionManager(config, {adapterRegistry: new HarnessAdapterRegistry([adapter])});
  const payload: HcpSessionStartPayload = {session_id: "session", workspace_id: "repo", provider_instance_id: "test",
    driver_kind: "test", cwd, sandbox_mode: "read_only", approval_policy: "full_access", continue_session: false,
    model_selection: {model: "model"}, mcp_servers: [],
    first_turn: {turn_id: "first", input: "Hello", not_after: new Date(Date.now() + 60_000).toISOString()}};
  const events: HcpHarnessEventPayload[] = [];
  const cleanup = async () => { if (manager.activeSessionCount()) await manager.stopSession(payload.session_id, "test cleanup"); await rm(cwd, {recursive: true, force: true}); };
  return {manager, payload, entered, ready, events, cleanup, turns: () => turns};
}

test("combined startup dispatches one locally sequenced first turn and rejects duplicate physical turns", async () => {
  const f = await fixture();
  try {
    const start = f.manager.startSession(f.payload);
    await f.entered.promise; f.ready.resolve();
    f.events.push(...await start);
    await f.manager.sendFirstTurn(f.payload, event => f.events.push(event));
    assert.equal(f.turns(), 1);
    assert.ok(f.events.findIndex(event => event.event_type === "session.started") < f.events.findIndex(event => event.event_type === "turn.started"));
    assert.equal(f.events.filter(event => event.event_type === "turn.completed").length, 1);
    assert.throws(() => f.manager.sendFirstTurn(f.payload, () => {}), /already exists/);
    assert.equal(f.turns(), 1);
  } finally { await f.cleanup(); }
});

for (const mode of ["cancel", "stop", "expiry"] as const) {
  test(`${mode} during initialization prevents first-turn execution and closes the session`, async () => {
    const f = await fixture();
    try {
      const start = f.manager.startSession(f.payload);
      await f.entered.promise;
      let stop: Promise<HcpHarnessEventPayload[]> | undefined;
      if (mode === "cancel") await f.manager.cancelTurn(f.payload.session_id, "first");
      if (mode === "stop") stop = f.manager.stopSession(f.payload.session_id, "Stop during startup");
      if (mode === "expiry") f.payload.first_turn!.not_after = new Date(Date.now() - 1).toISOString();
      f.ready.resolve();
      await start;
      if (stop) await stop;
      await f.manager.sendFirstTurn(f.payload, event => f.events.push(event));
      const journal = f.manager.replayEventsAfter({sessions: [{session_id: f.payload.session_id, last_event_sequence: 0}]}).events;
      assert.equal(f.turns(), 0);
      assert.equal(journal.filter(event => event.event_type === "turn.cancelled").length, 1);
      assert.equal(journal.at(-1)?.event_type, "session.exited");
      assert.equal(f.manager.activeSessionCount(), 0);
    } finally { f.ready.resolve(); await f.cleanup(); }
  });
}

test("another turn's cancellation cannot cancel the admitted startup", async () => {
  const f = await fixture();
  try {
    const start = f.manager.startSession(f.payload);
    await f.entered.promise;
    await assert.rejects(f.manager.cancelTurn(f.payload.session_id, "another"), /another startup turn/);
    f.ready.resolve(); await start;
    await f.manager.sendFirstTurn(f.payload, () => {});
    assert.equal(f.turns(), 1);
  } finally { f.ready.resolve(); await f.cleanup(); }
});
