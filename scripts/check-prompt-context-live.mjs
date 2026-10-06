import assert from "node:assert/strict";
import {mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {HarnessSessionManager} from "@harness-control/runner/harnesses";
import {RunnerConfigSchema} from "@harness-control/runner/config";
import {JsonRunnerStateStore} from "@harness-control/runner/state";

if (process.env.HCP_NATIVE_LIVE !== "1") throw new Error("Set HCP_NATIVE_LIVE=1 for authenticated acceptance.");
const driver = process.env.HCP_LIVE_PROVIDER ?? "codex";
assert.ok(["codex", "claude", "opencode"].includes(driver));
const cwd = await mkdtemp(join(tmpdir(), "hcp-live-prompt-context-"));
const path = join(cwd, "state.json");
const config = RunnerConfigSchema.parse({runner_id: "context-acceptance", control_plane_url: "ws://localhost:1",
  workspaces: [{id: "workspace", path: cwd}], provider_instances: [{id: driver, driver_kind: driver}]});
let manager = new HarnessSessionManager(config, {stateStore: new JsonRunnerStateStore(path)});
const status = (await manager.providerDriverStatuses()).find(value => value.driver_kind === driver);
assert.equal(status?.execution_capabilities?.prompt_context, true);
const model = driver === "opencode" ? process.env.HCP_LIVE_OPENCODE_MODEL ?? "opencode-go/glm-5.3-flash" :
  status.models.find(value => value.is_default)?.id ?? status.models[0]?.id;
assert.ok(model);
const start = {session_id: "context", workspace_id: "workspace", provider_instance_id: driver, driver_kind: driver,
  cwd, sandbox_mode: "danger_full_access", approval_policy: "ask", continue_session: false,
  continuation_group_key: "context", execution_profile: "interactive", model_selection: {model}, mcp_servers: [],
  configuration_inheritance: driver === "codex" ? {mcp_servers: false, plugins: false} :
    {user_settings: false, project_settings: false, hooks: false, mcp_servers: false, plugins: false}};
const passed = [];
const marker = randomUUID();
const context = {delivery: "prompt_context", messages: [{role: "user", content: `Handoff marker: ${marker}`},
  {role: "assistant", content: `I retained the handoff marker ${marker}.`}]};
try {
  await manager.startSession(start);
  const events = await manager.sendTurn({session_id: "context", turn_id: "first", input: "What was the handoff marker? Reply with it only. Use no tools.", context});
  const terminal = events.findLast(event => ["turn.completed", "turn.failed", "turn.cancelled"].includes(event.event_type));
  assert.equal(terminal?.event_type, "turn.completed"); assert.ok(JSON.stringify(terminal.data).includes(marker));
  const prepared = events.find(event => event.event_type === "context.input.prepared");
  assert.equal(prepared?.data.source, "app"); assert.equal(prepared?.data.delivery, "prompt_context"); assert.equal(prepared?.data.message_count, 2);
  passed.push("first-prompt-context-recall", "explicit-app-provenance", "prepared-context-turn-ownership");
  await manager.stopSession("context", "reopen");
  manager = new HarnessSessionManager(config, {stateStore: new JsonRunnerStateStore(path)});
  await manager.startSession({...start, session_id: "reopened", continue_session: true});
  const recalled = await manager.sendTurn({session_id: "reopened", turn_id: "recall", input: "Repeat the handoff marker from our earlier conversation. Reply only with it. Use no tools."});
  const ended = recalled.findLast(event => ["turn.completed", "turn.failed", "turn.cancelled"].includes(event.event_type));
  assert.equal(ended?.event_type, "turn.completed"); assert.ok(JSON.stringify(ended.data).includes(marker));
  assert.equal(recalled.some(event => event.event_type === "context.input.prepared"), false);
  passed.push("native-conversation-recall-after-restart", "no-implicit-context-reinjection");
} finally {
  for (const session of ["context", "reopened"]) {
    try {await manager.stopSession(session, "cleanup");}
    catch (error) {if (error?.code !== "session_not_found") throw error;}
  }
}
console.log(JSON.stringify({driver, passed, cwd}));
