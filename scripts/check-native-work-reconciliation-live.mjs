import assert from "node:assert/strict";
import {readFile, writeFile, rm} from "node:fs/promises";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {HarnessSessionManager} from "@harness-control/runner/harnesses";
import {RunnerConfigSchema} from "@harness-control/runner/config";
import {JsonRunnerStateStore} from "@harness-control/runner/state";

// This is an observation-loss fixture backed by installed native transcripts,
// not proof that a killed native process preserves its running descendants.
if (process.env.HCP_NATIVE_LIVE !== "1" || !process.env.HCP_LIVE_RECONCILIATION_STATE)
  throw new Error("Set HCP_NATIVE_LIVE=1 and HCP_LIVE_RECONCILIATION_STATE to a successful native-work acceptance state.");
const sourcePath = process.env.HCP_LIVE_RECONCILIATION_STATE;
const sourceBytes = await readFile(sourcePath, "utf8");
const source = new JsonRunnerStateStore(sourcePath);
const original = source.nativeWorkState("work");
const child = Object.values(original?.items ?? {}).find(work => work.kind === "agent" && work.status === "completed"
  && original.custody?.[work.work_id]?.source === "codex" && original.custody[work.work_id].native_execution_reference);
assert.ok(child, "The installed-native fixture needs a completed child with durable execution custody.");
const statePath = join(original.scope.cwd, `reconciliation-${randomUUID()}.json`);
await writeFile(statePath, sourceBytes, {mode: 0o600, flag: "wx"});
try {
  const fixture = new JsonRunnerStateStore(statePath);
  const observed = fixture.nativeWorkState("work");
  observed.items[child.work_id] = {...child, status: "unknown", revision: child.revision + 1, supports_cancel: false};
  observed.closure_unconfirmed = true;
  fixture.saveNativeWorkState("work", observed);
  const config = RunnerConfigSchema.parse({runner_id: "native-terminal-inspection", control_plane_url: "ws://localhost:1",
    workspaces: [{id: original.scope.workspace_id, path: original.scope.cwd}],
    provider_instances: [{id: original.scope.provider_instance_id, driver_kind: "codex"}]});
  const manager = () => new HarnessSessionManager(config, {stateStore: new JsonRunnerStateStore(statePath)});
  const owner = manager(), command = randomUUID();
  const request = {session_id: "work", operation: {kind: "work", action: "reconcile", work_id: child.work_id,
    expected_revision: child.revision + 1}};
  const result = await owner.conversationOperation(command, request);
  assert.equal(result.work.action, "reconcile"); assert.equal(result.work.status, "completed");
  assert.equal(result.work.owner_status, "unavailable"); assert.equal(result.work.session_closure, "unconfirmed");
  assert.equal(owner.activeSessionCount(), 0);
  assert.equal(owner.stateStore().nativeWorkState("work").closure_unconfirmed, true);
  const restarted = manager();
  assert.deepEqual(await restarted.conversationOperation(command, request), result);
  await assert.rejects(restarted.conversationOperation(randomUUID(), request), /current child revision/);
  await owner.close(); await restarted.close();
  assert.equal(await readFile(sourcePath, "utf8"), sourceBytes, "Native acceptance source state remains untouched.");
  console.log(JSON.stringify({driver: "codex", scenario: "installed-transcript-observation-loss", passed: [
    "exact-execution-terminal-proof", "lost-owner-remains-unavailable", "session-closure-remains-unconfirmed",
    "durable-reconciliation-replay", "stale-revision-refusal", "source-state-preserved"]}));
} finally {await rm(statePath, {force: true});}
