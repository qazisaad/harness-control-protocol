import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtemp, realpath, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import type {Query, Options} from "@anthropic-ai/claude-agent-sdk";
import {PersistentClaudeSession} from "./claude-session.js";
import {confirmClaudeDirectories, confirmClaudeModel} from "./claude-effort.js";
import {claudeNativeModel, selectedEffort, validateNativeStart} from "./native-turn.js";
import type {HarnessAdapterStartInput} from "../types.js";
import {RunnerConfigSchema} from "../../../config/index.js";

function settingsStream(settings: unknown): Query {
  return {async getSettings() {return settings;}} as unknown as Query;
}

test("Claude directory readback requires the exact single flag layer and effective permissions", async () => {
  const dirs = ["/repo/b", "/repo/a"];
  const confirmed = {sources: [{source: "flagSettings", settings: {disableAllHooks: true, permissions: {additionalDirectories: ["/repo/a", "/repo/b"]}}}],
    effective: {permissions: {additionalDirectories: ["/repo/a", "/repo/b"]}}};
  await confirmClaudeDirectories(settingsStream(confirmed), dirs);
  for (const settings of [
    {sources: [{source: "flagSettings", settings: {permissions: {additionalDirectories: ["/repo/a"]}}}], effective: {permissions: {additionalDirectories: dirs}}},
    {sources: [{source: "flagSettings", settings: {permissions: {additionalDirectories: dirs}}}], effective: {permissions: {additionalDirectories: ["/repo/a"]}}},
    {sources: [], effective: {permissions: {additionalDirectories: dirs}}},
    {sources: [{source: "flagSettings", settings: {}}, {source: "flagSettings", settings: {}}]},
  ]) await assert.rejects(confirmClaudeDirectories(settingsStream(settings), dirs), /additional permitted directories/);
});

test("Claude context window selects the native [1m] suffix and requires matching readback", async () => {
  assert.equal(claudeNativeModel({model: "opus", options: [{id: "contextWindow", value: "1m"}]}), "opus[1m]");
  assert.equal(claudeNativeModel({model: "opus[1m]", options: [{id: "contextWindow", value: "default"}]}), "opus");
  assert.equal(claudeNativeModel({model: "opus"}), "opus");
  assert.equal(selectedEffort({model: "opus", options: [{id: "contextWindow", value: "1m"}, {id: "effort", value: "high"}]}, "claude"), "high");
  assert.throws(() => selectedEffort({model: "opus", options: [{id: "contextWindow", value: "2m"}]}, "claude"), /default or 1m/);
  assert.equal(await confirmClaudeModel(settingsStream({applied: {model: "claude-opus-5-5[1m]"}}), "opus[1m]"), "claude-opus-5-5[1m]");
  await assert.rejects(confirmClaudeModel(settingsStream({applied: {model: "claude-opus-5-5"}}), "opus[1m]"), /context window/);
  await assert.rejects(confirmClaudeModel(settingsStream({applied: {model: "claude-opus-5-5[1m]"}}), "opus"), /context window/);
});

test("Claude roots are permission-scoped: full access, no network authority, interactive only", () => {
  const config = RunnerConfigSchema.parse({runner_id: "runner", control_plane_url: "ws://localhost:1", provider_instances: [{id: "claude", driver_kind: "claude"}]});
  const payload = {session_id: "s", workspace_id: "w", cwd: "/repo", provider_instance_id: "claude", driver_kind: "claude", model_selection: {model: "opus"},
    approval_policy: "ask" as const, sandbox_mode: "danger_full_access" as const, execution_profile: "interactive", continue_session: false, mcp_servers: [],
    sandbox_options: {writable_roots: [{workspace_id: "x", path: "/extra"}]}};
  validateNativeStart({payload, provider: config.provider_instances[0]!}, "claude");
  for (const changed of [{execution_profile: "isolated"}, {sandbox_options: {network_access: false, writable_roots: payload.sandbox_options.writable_roots}},
    {sandbox_options: {network_access: false}}])
    assert.throws(() => validateNativeStart({payload: {...payload, ...changed}, provider: config.provider_instances[0]!}, "claude"));
});

for (const scenario of ["confirmed", "missing"] as const)
test(`Claude startup proves permission directories before any input (${scenario})`, async () => {
  const root = await mkdtemp(join(tmpdir(), "hcp-claude-dirs-"));
  let closed = false, wake: (() => void) | undefined, promptCount = 0, opened: Options | undefined;
  const output = async function* () {while (!closed) await new Promise<void>(resolve => {wake = resolve;});};
  const config = RunnerConfigSchema.parse({runner_id: "runner", control_plane_url: "ws://localhost:1",
    workspaces: [{id: "workspace", path: root}], provider_instances: [{id: "claude", driver_kind: "claude"}]});
  const extra = await realpath(root);
  const start: HarnessAdapterStartInput = {provider: config.provider_instances[0]!,
    payload: {session_id: "s", workspace_id: "workspace", cwd: root, provider_instance_id: "claude", driver_kind: "claude",
      model_selection: {model: "opus", options: [{id: "contextWindow", value: "1m"}]}, approval_policy: "auto_edits", sandbox_mode: "danger_full_access",
      execution_profile: "interactive", continue_session: false, mcp_servers: [], sandbox_options: {writable_roots: [{workspace_id: "workspace", path: extra}]}},
    emitSessionEvent() {}, registerSessionInteractions() {}};
  const runtime = new PersistentClaudeSession(start, ({prompt, options}) => {
    opened = options;
    void (async () => {for await (const _message of prompt) promptCount++;})();
    const declared = (options?.settings as {permissions?: {additionalDirectories?: string[]}} | undefined)?.permissions?.additionalDirectories ?? [];
    return Object.assign(output(), {
      async initializationResult() {return {};},
      async getSettings() {
        const directories = scenario === "missing" ? [] : declared;
        return {applied: {model: `${String(options?.model).replace("[1m]", "")}-native[1m]`, effort: null},
          sources: [{source: "flagSettings", settings: {disableAllHooks: true, permissions: {additionalDirectories: directories}}}],
          effective: {permissions: {additionalDirectories: directories}}};
      },
      close() {closed = true; wake?.();},
    }) as unknown as Query;
  });
  try {
    if (scenario === "confirmed") {
      assert.deepEqual(await runtime.confirmDirectories(), {source: "native", execution_profile: "interactive", approval_policy: "auto_edits",
        sandbox_options: {writable_roots: [{workspace_id: "workspace", path: extra}]}, sandbox_mode: "danger_full_access"});
      assert.equal(opened?.model, "opus[1m]");
      assert.deepEqual((opened?.settings as {permissions: unknown}).permissions, {additionalDirectories: [extra]});
    } else await assert.rejects(runtime.confirmDirectories(), /additional permitted directories/);
    assert.equal(promptCount, 0);
  } finally {await runtime.stop(); await rm(root, {recursive: true, force: true});}
});
