// Source-only native control acceptance. Public authorization/receipt integration remains a separate gate.
import assert from "node:assert/strict";
import {mkdtemp, realpath, writeFileSync} from "node:fs";
import {promisify} from "node:util";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {RunnerConfigSchema} from "../packages/hcp-runner/src/config/index.js";
import {ClaudeHarnessAdapter} from "../packages/hcp-runner/src/harnesses/adapters/providers/claude.js";
import type {HcpSessionStartPayload} from "@harness-control/protocol";
import {BoundedHarnessContentStore} from "../packages/hcp-runner/src/harnesses/content-store.js";

if (process.env.HCP_NATIVE_LIVE !== "1") throw new Error("Set HCP_NATIVE_LIVE=1 for controlled Claude in-place policy acceptance.");
const cwd = await promisify(realpath)(await promisify(mkdtemp)(join(tmpdir(), "hcp-native-claude-idle-policy-")));
const provider = RunnerConfigSchema.parse({runner_id: "idle-policy", control_plane_url: "ws://localhost:1",
  workspaces: [{id: "workspace", path: cwd}], provider_instances: [{id: "claude", driver_kind: "claude",
    ...(process.env.HCP_LIVE_CLAUDE_EXECUTABLE ? {executable_path: process.env.HCP_LIVE_CLAUDE_EXECUTABLE} : {})}]}).provider_instances[0]!;
const adapter = new ClaudeHarnessAdapter(), passed: string[] = [];
const content = new BoundedHarnessContentStore();
const publishContent = (value: unknown) => content.publish({session_id: "session", provider_instance_id: "claude",
  provider_binding_hash: "source-only-fixture", workspace_id: "workspace", cwd}, value);
let admitted = false;
try {
  const status = await adapter.probe(provider); assert.match(status.version!, /2\.1\.289/);
  const model = status.models.find(model => model.is_default)?.id ?? status.models[0]?.id; assert.ok(model);
  let payload: HcpSessionStartPayload = {session_id: "session", workspace_id: "workspace", cwd, provider_instance_id: "claude", driver_kind: "claude",
    execution_profile: "interactive", model_selection: {model}, sandbox_mode: "danger_full_access", approval_policy: "ask", continuation_group_key: "fixture",
    policy_control_authority: {allowed_selections: (["ask", "auto_edits", "full_access"] as const).map(approval_policy => ({approval_policy, approval_reviewer: "user" as const}))},
    continue_session: false, mcp_servers: [], configuration_inheritance: {user_settings: false, project_settings: false,
      hooks: false, mcp_servers: false, plugins: false}};
  const session = await adapter.startSession({payload, provider, publishContent, registerSessionInteractions() {}, emitSessionEvent() {}}); admitted = true;
  const nativeId = session.native_thread_id; assert.ok(nativeId);
  const run = async (turnId: string) => {
    const events = await adapter.sendTurn({startPayload: payload, provider, session, publishContent, payload: {session_id: "session", turn_id: turnId, input: "/goal"}});
    if (!events.some(event => event.event_type === "turn.completed")) {
      const failure = events.find(event => event.event_type === "turn.failed")?.data.error;
      const code = failure && typeof failure === "object" && "code" in failure ? failure.code : undefined;
      throw new Error(`Native primitive local command failed (${typeof code === "string" && /^[a-z_]{1,80}$/.test(code) ? code : "unclassified"}).`);
    }
    assert.equal(session.native_thread_id, nativeId);
  };
  await run("initial-local-command"); passed.push("initial-native-owner-and-local-command");
  let revision = 0;
  for (const approval_policy of ["full_access", "auto_edits", "ask"] as const) {
    const next = {...payload, approval_policy}; let phase: "pending" | "completed" | undefined;
    const readback = await adapter.updateNativePolicy({sessionId: "session", nextPayload: next, signal: new AbortController().signal,
      beginMutation() {phase = "pending"; writeFileSync(join(cwd, `policy-${revision}.json`), JSON.stringify({phase, revision, approval_policy}), {mode: 0o600});},
      commit(readback) {assert.equal(phase, "pending"); assert.equal(readback.approval_policy, approval_policy);
        writeFileSync(join(cwd, `policy-${revision}.json`), JSON.stringify({phase: "completed", revision, readback}), {mode: 0o600}); phase = "completed";}});
    assert.equal(readback.source, "native"); assert.equal(phase, "completed"); payload = next; revision++;
    await run(`after-policy-${revision}`); passed.push(`fresh-native-${approval_policy}-status-and-same-owner-command`);
  }
  console.log(JSON.stringify({driver: "claude", version: status.version, scope: "source-only-native-policy-primitive", passed}));
} finally {if (admitted) await adapter.stopSession({sessionId: "session", reason: "fixture complete"}); await adapter.close();}
