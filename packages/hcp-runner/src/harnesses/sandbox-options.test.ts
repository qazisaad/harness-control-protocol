import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtemp, mkdir, realpath, rm, symlink} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import type {HcpSessionStartPayload, HarnessSandboxOptions} from "@harness-control/protocol";
import {HarnessSessionManager, HarnessAdapterRegistry, type HarnessAdapter} from "./index.js";
import {RunnerConfigSchema} from "../config/index.js";

async function fixture(mode: "confirmed" | "missing" | "changed" = "confirmed") {
  const root = await mkdtemp(join(tmpdir(), "hcp-sandbox-options-")), cwd = join(root, "current"), extra = join(root, "extra");
  await mkdir(cwd);await mkdir(extra);
  const profiles = [{id: "interactive", runtime_lifetime: "session" as const, native_work: false, session_events: false,
    root_settings_readback: true, approval_prompt_filter: true, sandbox_options: ["network_access", "writable_roots"] as Array<"network_access" | "writable_roots">}];
  let starts = 0, received: HcpSessionStartPayload | undefined;
  const adapter: HarnessAdapter = {driverKind: "example", emptyConversation: true, liveHistoryRead: true, executionProfiles: profiles,
    conversationOperations: ["read"], async probe() {return {driver_kind: "example", installed: true, available: true, models: []};},
    async validateStart() {}, async startSession(input) {
      starts++;received = structuredClone(input.payload);
      return {adapter_session_id: input.payload.session_id, native_thread_id: "native",
        ...(mode === "missing" ? {} : {native_policy_readback: {source: "native" as const, execution_profile: "interactive",
          approval_policy: input.payload.approval_policy, sandbox_mode: input.payload.sandbox_mode,
          ...(input.payload.approval_options && "prompt_categories" in input.payload.approval_options ? {approval_options: {prompt_categories: {...input.payload.approval_options.prompt_categories,
            ...(mode === "changed" ? {permission_requests: !input.payload.approval_options.prompt_categories.permission_requests} : {})}}} : {}),
          ...(input.payload.approval_options && "permission_prompting" in input.payload.approval_options && mode !== "changed"
            ? {approval_options: structuredClone(input.payload.approval_options)} : {}),
          ...(input.payload.approval_options && "permission_rules" in input.payload.approval_options && mode !== "changed"
            ? {approval_options: structuredClone(input.payload.approval_options)} : {}),
          ...(input.payload.sandbox_options ? {sandbox_options: {...input.payload.sandbox_options,
            ...(mode === "changed" ? {network_access: !input.payload.sandbox_options.network_access} : {})}} : {})}})};
    }, async sendTurn() {return [];}, async cancelTurn() {return [];}, async stopSession() {return [];},
    async conversationOperation(input) {return {command_id: input.commandId, session_id: input.request.session_id, operation: "read", filesystem_undo: false,
      history: {history_hash: "a".repeat(64), turn_count: 0, truncated: false, turns: []}};},
  };
  const config = RunnerConfigSchema.parse({runner_id: "runner", control_plane_url: "ws://localhost:1", workspaces: [{id: "current", path: cwd}, {id: "extra", path: extra}],
    provider_instances: [{id: "provider", driver_kind: "example"}]});
  const manager = new HarnessSessionManager(config, {adapterRegistry: new HarnessAdapterRegistry([adapter])});
  const payload: HcpSessionStartPayload = {session_id: "session", workspace_id: "current", cwd, provider_instance_id: "provider", driver_kind: "example",
    sandbox_mode: "workspace_write", approval_policy: "ask", continue_session: false, execution_profile: "interactive", continuation_group_key: "conversation",
    model_selection: {model: "fixture"}, mcp_servers: [], sandbox_options: {network_access: false, writable_roots: [{workspace_id: "extra", path: extra}]}};
  return {root, cwd, extra, payload, manager, profiles, get starts() {return starts;}, get received() {return received;}, async close() {
    for (const id of ["session", "resume", "resume-confirmed"]) try {await manager.stopSession(id, "cleanup");} catch (error) {if ((error as {code?: string}).code !== "session_not_found") throw error;}
    await rm(root, {recursive: true, force: true});
  }};
}

test("extra roots require declared host workspaces and are canonical before native dispatch", async () => {
  const f = await fixture();
  try {
    const events = await f.manager.startSession(f.payload);
    assert.deepEqual(f.received?.sandbox_options, {network_access: false, writable_roots: [{workspace_id: "extra", path: await realpath(f.extra)}]});
    assert.deepEqual((events.find(event => event.event_type === "session.configured")!.data as {native_policy_readback: {sandbox_options: HarnessSandboxOptions}}).native_policy_readback.sandbox_options,
      f.received!.sandbox_options);
    await f.manager.stopSession("session", "retain");
    await assert.rejects(f.manager.startSession({...f.payload, session_id: "resume", continue_session: true, sandbox_options: {network_access: true,
      writable_roots: f.payload.sandbox_options!.writable_roots!}}), /binding|authority|configuration/i);
    assert.equal(f.starts, 1);
    await f.manager.startSession({...f.payload, session_id: "resume-confirmed", continue_session: true});assert.equal(f.starts, 2);
  } finally {await f.close();}
});

test("undeclared options and unsupported readback refuse before native launch", async () => {
  const f = await fixture();
  try {
    f.profiles[0]!.sandbox_options = ["network_access"];
    await assert.rejects(f.manager.startSession(f.payload), /has not declared/);assert.equal(f.starts, 0);
    f.profiles[0]!.sandbox_options = ["network_access", "writable_roots"];f.profiles[0]!.root_settings_readback = false;
    await assert.rejects(f.manager.startSession(f.payload), /has not declared/);assert.equal(f.starts, 0);
  } finally {await f.close();}
});

test("outside roots, unknown workspaces, canonical duplicates and symlink escapes refuse before launch", async () => {
  const f = await fixture();
  try {
    const alias = join(f.extra, "alias"), escape = join(f.cwd, "escape");await symlink(f.extra, alias);await symlink(f.extra, escape);
    for (const writable_roots of [[{workspace_id: "current", path: f.extra}], [{workspace_id: "unknown", path: f.extra}],
      [{workspace_id: "current", path: escape}], [{workspace_id: "extra", path: f.extra}, {workspace_id: "extra", path: alias}]])
      await assert.rejects(f.manager.startSession({...f.payload, sandbox_options: {writable_roots}}));
    assert.equal(f.starts, 0);
  } finally {await f.close();}
});

for (const mode of ["missing", "changed"] as const) test(`requested sandbox options cannot substitute for native proof (${mode})`, async () => {
  const f = await fixture(mode);
  try {await assert.rejects(f.manager.startSession(f.payload), /readback|authorized execution configuration/);assert.equal(f.starts, 1);}
  finally {await f.close();}
});

test("declared options cannot turn read-only authority into an additional write grant", async () => {
  const f = await fixture();
  try {await assert.rejects(f.manager.startSession({...f.payload, sandbox_mode: "read_only"}), /workspace-write authority/);assert.equal(f.starts, 0);}
  finally {await f.close();}
});

const promptCategories = {sandbox_escalation: false, execution_rules: true, skill_execution: false, permission_requests: false, mcp_elicitation: true};
test("native rejection of unapproved permissions requires declared enforcement and binds retained authority", async () => {
  const f = await fixture(), {sandbox_options: _sandbox, ...base} = f.payload;
  const selected = {...base, approval_policy: "ask" as const, approval_options: {permission_prompting: "reject_unapproved" as const}};
  try {
    await assert.rejects(f.manager.startSession(selected), /declared enforcement/);assert.equal(f.starts, 0);
    Object.assign(f.profiles[0]!, {native_permission_prompting: "reject_unapproved" as const});
    for (const approval_policy of ["auto_edits", "full_access"] as const)
      await assert.rejects(f.manager.startSession({...selected, approval_policy}), /matching authority/);
    await assert.rejects(f.manager.startSession({...selected, approval_reviewer: "native_auto"}), /matching authority|automatic/);
    assert.equal(f.starts, 0);await f.manager.startSession(selected);assert.equal(f.starts, 1);
    await f.manager.stopSession("session", "retain");
    const {approval_options: _options, ...changed} = selected;
    await assert.rejects(f.manager.startSession({...changed, session_id: "changed", continue_session: true}), /binding|scope|policy changed/);
    await f.manager.startSession({...selected, session_id: "exact-resume", continue_session: true});assert.equal(f.starts, 2);
  } finally {await f.close();}
});
for (const mode of ["missing", "changed"] as const) test(`native permission rejection requires exact startup readback (${mode})`, async () => {
  const f = await fixture(mode), {sandbox_options: _sandbox, ...base} = f.payload;
  Object.assign(f.profiles[0]!, {native_permission_prompting: "reject_unapproved" as const});
  try {await assert.rejects(f.manager.startSession({...base, approval_policy: "ask", approval_options: {permission_prompting: "reject_unapproved"}}),
    /readback|authorized execution configuration/);assert.equal(f.starts, 1);} finally {await f.close();}
});
test("generic native prompt filters require declared support and cannot bypass their named approval base", async () => {
  const f = await fixture();
  const {sandbox_options: _sandbox, ...base} = f.payload;
  const payload = {...base, approval_policy: "auto_edits" as const, approval_options: {prompt_categories: promptCategories}};
  try {
    f.profiles[0]!.approval_prompt_filter = false;
    await assert.rejects(f.manager.startSession(payload), /declared enforcement/);assert.equal(f.starts, 0);
    f.profiles[0]!.approval_prompt_filter = true;
    await assert.rejects(f.manager.startSession({...payload, approval_policy: "full_access"}), /on-request/);assert.equal(f.starts, 0);
    await f.manager.startSession(payload);assert.equal(f.starts, 1);
    await f.manager.stopSession("session", "retain");
    await assert.rejects(f.manager.startSession({...payload, session_id: "resume", continue_session: true,
      approval_options: {prompt_categories: {...promptCategories, sandbox_escalation: true}}}), /binding|scope|policy changed/);
    assert.equal(f.starts, 1);
    await f.manager.startSession({...payload, session_id: "resume-confirmed", continue_session: true});assert.equal(f.starts, 2);
  } finally {await f.close();}
});
for (const mode of ["missing", "changed"] as const) test(`native prompt filters require exact native readback (${mode})`, async () => {
  const f = await fixture(mode);
  const {sandbox_options: _sandbox, ...base} = f.payload;
  try {await assert.rejects(f.manager.startSession({...base, approval_policy: "auto_edits",
    approval_options: {prompt_categories: promptCategories}}), /readback|authorized execution configuration/);assert.equal(f.starts, 1);}
  finally {await f.close();}
});

test("native builtin availability requires a declared unique profile selection and binds continuation custody", async () => {
  const f = await fixture();
  const {sandbox_options: _sandbox, ...base} = f.payload;
  const selected = {...base, tool_selection: {native_builtin_tools: ["Read"]}};
  try {
    await assert.rejects(f.manager.startSession(selected), /exact unique builtin/);assert.equal(f.starts, 0);
    Object.assign(f.profiles[0]!, {native_tool_selection: {scope: "root_builtins", tools: ["Read", "Glob"]}});
    for (const native_builtin_tools of [["Bash"], ["Read", "Read"]])
      await assert.rejects(f.manager.startSession({...selected, tool_selection: {native_builtin_tools}}), /exact unique builtin/);
    assert.equal(f.starts, 0);
    await f.manager.startSession(selected);assert.deepEqual(f.received?.tool_selection, selected.tool_selection);
    await f.manager.stopSession("session", "retain");
    await assert.rejects(f.manager.startSession({...selected, session_id: "resume", continue_session: true,
      tool_selection: {native_builtin_tools: ["Read", "Glob"]}}), /binding|scope|policy changed/);assert.equal(f.starts, 1);
    await f.manager.startSession({...selected, session_id: "resume-confirmed", continue_session: true});assert.equal(f.starts, 2);
  } finally {await f.close();}
});

const permissionRules = [{permission: "*", pattern: "*", action: "deny" as const}, {permission: "read", pattern: "*", action: "allow" as const}];
test("generic ordered policies require declared native vocabulary, exact readback and unchanged continuation", async () => {
  const f = await fixture(), {sandbox_options: _sandbox, ...base} = f.payload;
  const selected = {...base, approval_options: {permission_rules: permissionRules}};
  try {
    await assert.rejects(f.manager.startSession(selected), /declared enforcement/);assert.equal(f.starts, 0);
    Object.assign(f.profiles[0]!, {native_permission_rules: {scope: "root", matching: "ordered_glob", permissions: ["*", "read"]}});
    await assert.rejects(f.manager.startSession({...selected, approval_options: {permission_rules: [...permissionRules,
      {permission: "future_tool", pattern: "*", action: "allow"}]}}), /declared enforcement/);
    for (const approval_policy of ["auto_edits", "full_access"] as const)
      await assert.rejects(f.manager.startSession({...selected, approval_policy}), /matching authority/);
    await assert.rejects(f.manager.startSession({...selected, approval_reviewer: "native_auto"}), /matching authority/);
    assert.equal(f.starts, 0);await f.manager.startSession(selected);assert.equal(f.starts, 1);
    await f.manager.stopSession("session", "retain");
    await assert.rejects(f.manager.startSession({...selected, session_id: "changed", continue_session: true,
      approval_options: {permission_rules: [{permission: "*", pattern: "*", action: "allow"}]}}), /binding|scope|policy changed/);
    await f.manager.startSession({...selected, session_id: "resume-confirmed", continue_session: true});assert.equal(f.starts, 2);
  } finally {await f.close();}
});
for (const mode of ["missing", "changed"] as const) test(`ordered native permissions require exact native readback (${mode})`, async () => {
  const f = await fixture(mode), {sandbox_options: _sandbox, ...base} = f.payload;
  Object.assign(f.profiles[0]!, {native_permission_rules: {scope: "root", matching: "ordered_glob", permissions: ["*", "read"]}});
  try {await assert.rejects(f.manager.startSession({...base, approval_options: {permission_rules: permissionRules}}), /readback|authorized execution configuration/);
    assert.equal(f.starts, 1);} finally {await f.close();}
});
