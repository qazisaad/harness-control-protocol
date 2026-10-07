import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtemp, mkdir, realpath, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {ProviderInstanceConfigSchema} from "../../../config/index.js";
import {initializeCodexConversation} from "./codex-runtime.js";
import {validateNativeStart} from "./native-turn.js";
import type {CodexRpc} from "./codex-rpc.js";

async function fixture(mode: "confirmed" | "network-changed" | "network-missing" | "extra-root" | "missing-root") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hcp-codex-sandbox-"))), extra = join(root, "extra"), foreign = join(root, "foreign");
  await mkdir(extra);await mkdir(foreign);
  const input: Parameters<typeof initializeCodexConversation>[0] = {startPayload: {session_id: "session", workspace_id: "workspace", cwd: root,
    provider_instance_id: "provider", driver_kind: "codex", sandbox_mode: "workspace_write", approval_policy: "auto_edits", continue_session: false,
    execution_profile: "interactive", model_selection: {model: "model"}, mcp_servers: [], sandbox_options: {network_access: false, writable_roots: [{workspace_id: "extra", path: extra}]}},
    provider: ProviderInstanceConfigSchema.parse({id: "provider", driver_kind: "codex"}), session: {adapter_session_id: "session"}, mcpServers: []};
  const calls: {method: string; params: unknown}[] = [];
  const rpc = {notify() {}, async request(method: string, params: unknown) {
    calls.push({method, params});
    if (method === "initialize") return {};
    if (method === "config/read") return {config: {}};
    if (method === "mcpServerStatus/list") return {data: [], nextCursor: null};
    if (method === "thread/start") return {thread: {id: "native"}, approvalPolicy: "on-request", approvalsReviewer: "user",
      sandbox: {type: "workspaceWrite", writableRoots: mode === "missing-root" ? [root] : mode === "extra-root" ? [root, extra, foreign] : [root, extra],
        ...(mode === "network-missing" ? {} : {networkAccess: mode === "network-changed"}), excludeTmpdirEnvVar: true, excludeSlashTmp: true}};
    throw new Error("Unexpected native dispatch.");
  }} as unknown as CodexRpc;
  return {input, calls, rpc, root, extra, async close() {await rm(root, {recursive: true, force: true});}};
}

test("Codex initializes exactly the authorized roots and network flag before any model admission", async () => {
  const f = await fixture("confirmed");
  try {
    const result = await initializeCodexConversation(f.input, f.input.startPayload.model_selection, f.rpc);
    assert.equal(result.started.sandbox.networkAccess, false);assert.deepEqual(result.started.sandbox.writableRoots, [f.root, f.extra]);
    const config = (f.calls.find(call => call.method === "thread/start")!.params as {config: Record<string, unknown>}).config;
    assert.deepEqual(config["sandbox_workspace_write.writable_roots"], [f.extra]);assert.equal(config["sandbox_workspace_write.network_access"], false);
    assert.equal(f.calls.some(call => call.method === "turn/start"), false);
  } finally {await f.close();}
});

for (const mode of ["network-changed", "network-missing", "extra-root", "missing-root"] as const)
test(`Codex rejects unconfirmed sandbox authority before any model admission (${mode})`, async () => {
  const f = await fixture(mode);
  try {
    await assert.rejects(initializeCodexConversation(f.input, f.input.startPayload.model_selection, f.rpc), /requested workspace/);
    assert.equal(f.input.session.native_thread_id, undefined);assert.equal(f.calls.some(call => call.method === "turn/start"), false);
  } finally {await f.close();}
});

test("isolated and read-only profiles cannot silently accept unsupported sandbox options", async () => {
  const f = await fixture("confirmed");
  try {
    for (const payload of [{...f.input.startPayload, execution_profile: "isolated"}, {...f.input.startPayload, sandbox_mode: "read_only" as const}])
      assert.throws(() => validateNativeStart({payload, provider: f.input.provider}, "codex"), /enforcement and readback/);
    assert.throws(() => validateNativeStart({payload: {...f.input.startPayload, driver_kind: "claude"}, provider: f.input.provider}, "claude"), /enforcement and readback/);
    assert.equal(f.calls.length, 0);
  } finally {await f.close();}
});

for (const changed of [false, true]) test(`Codex prompt filters require exact initialized native category readback (${changed ? "changed" : "confirmed"})`, async () => {
  const f = await fixture("confirmed");
  const categories = {sandbox_escalation: false, execution_rules: true, skill_execution: false, permission_requests: false, mcp_elicitation: true};
  f.input.startPayload.approval_options = {prompt_categories: categories};
  const original = f.rpc.request.bind(f.rpc);
  f.rpc.request = async (method, params) => {
    const response = await original(method, params);
    if (method === "thread/start") {
      const granular = {sandbox_approval: changed, rules: true, skill_approval: false, request_permissions: false, mcp_elicitations: true};
      assert.deepEqual((params as {approvalPolicy: unknown}).approvalPolicy, {granular: {...granular, sandbox_approval: false}});
      return {...response as Record<string, unknown>, approvalPolicy: {granular}};
    }
    return response;
  };
  try {
    if (changed) {await assert.rejects(initializeCodexConversation(f.input, f.input.startPayload.model_selection, f.rpc), /requested execution policy/);
      assert.equal(f.input.session.native_thread_id, undefined);}
    else assert.deepEqual((await initializeCodexConversation(f.input, f.input.startPayload.model_selection, f.rpc)).started.approvalPolicy,
      {granular: {sandbox_approval: false, rules: true, skill_approval: false, request_permissions: false, mcp_elicitations: true}});
    assert.equal(f.calls.some(call => call.method === "turn/start"), false);
  } finally {await f.close();}
});

test("native prompt filters refuse unsupported direct native profiles before launch", async () => {
  const f = await fixture("confirmed");
  const {sandbox_options: _sandbox, ...base} = f.input.startPayload;
  const payload = {...base, approval_options: {prompt_categories: {sandbox_escalation: false, execution_rules: false,
    skill_execution: false, permission_requests: false, mcp_elicitation: false}}};
  try {
    assert.throws(() => validateNativeStart({payload: {...payload, execution_profile: "isolated"}, provider: f.input.provider}, "codex"), /Native approval options/);
    assert.throws(() => validateNativeStart({payload, provider: f.input.provider}, "claude"), /Native approval options/);
    assert.throws(() => validateNativeStart({payload: {...payload, approval_policy: "ask"}, provider: f.input.provider}, "codex"), /Native approval options/);
    assert.equal(f.calls.length, 0);
  } finally {await f.close();}
});
