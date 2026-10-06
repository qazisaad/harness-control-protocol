import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtemp, rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {HarnessSessionManager, HarnessAdapterRegistry, type HarnessAdapter} from "./index.js";
import {RunnerConfigSchema} from "../config/index.js";

test("concurrent root admission and stale cancellation preserve the admitted owner and reusable rejected ID", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "hcp-root-admission-"));
  let release!: () => void;
  const called: string[] = [], cancelled: string[] = [];
  const adapter: HarnessAdapter = {driverKind: "example", durableMcpContinuation: true,
    async probe() {return {driver_kind: "example", installed: true, available: true, models: []};},
    async validateStart() {}, async startSession() {return {adapter_session_id: "native"};},
    async sendTurn(input) {
      called.push(input.payload.turn_id);
      await new Promise<void>(resolve => {release = resolve;});
      return [{event_type: "turn.completed", data: {final_output: {final_text: "done"}}}];
    }, async cancelTurn(input) {cancelled.push(input.turnId); return [];}, async stopSession() {return [];},
  };
  const manager = new HarnessSessionManager(RunnerConfigSchema.parse({runner_id: "runner", control_plane_url: "ws://localhost:1",
    workspaces: [{id: "workspace", path: cwd}], provider_instances: [{id: "provider", driver_kind: "example"}]}), {adapterRegistry: new HarnessAdapterRegistry([adapter])});
  try {
    await manager.startSession({session_id: "session", workspace_id: "workspace", cwd, provider_instance_id: "provider", driver_kind: "example",
      model_selection: {model: "example"}, sandbox_mode: "read_only", approval_policy: "ask", continue_session: false, mcp_servers: []});
    const turn = (turn_id: string) => manager.sendTurn({session_id: "session", turn_id, input: "run"});
    const first = turn("first");
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(async () => turn("second"), /already has an admitted root turn/);
    assert.deepEqual(called, ["first"]);
    release(); await first;
    const second = turn("second");
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(await manager.cancelTurn("session", "first"), []);
    assert.deepEqual(cancelled, []);
    release();
    assert.ok((await second).some(event => event.event_type === "turn.completed"));
    assert.deepEqual(called, ["first", "second"]);
  } finally {await manager.stopSession("session", "test complete"); await rm(cwd, {recursive: true, force: true});}
});
