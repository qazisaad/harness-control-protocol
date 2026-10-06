import assert from "node:assert/strict";
import {mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {CodexRpc} from "../packages/hcp-runner/dist/harnesses/adapters/providers/codex-rpc.js";
import {updateCodexRootSettings} from "../packages/hcp-runner/dist/harnesses/adapters/providers/codex-settings.js";

if (process.env.HCP_NATIVE_LIVE !== "1") throw new Error("Set HCP_NATIVE_LIVE=1 for native settings acceptance.");
const cwd = await mkdtemp(join(tmpdir(), "hcp-codex-settings-component-"));
const rpc = new CodexRpc("codex", cwd, process.env);
const passed = [];
try {
  await rpc.request("initialize", {clientInfo: {name: "hcp-settings-acceptance", version: "0.4.10"}, capabilities: {experimentalApi: true}});
  rpc.notify("initialized");
  const catalog = await rpc.request("model/list", {});
  const model = catalog.data.find(value => value.isDefault)?.model ?? catalog.data[0]?.model;
  assert.ok(model);
  const config = (await rpc.request("config/read", {cwd, includeLayers: false})).config;
  const started = await rpc.request("thread/start", {cwd, model, ephemeral: false, sandbox: "danger-full-access", approvalPolicy: "never", approvalsReviewer: "user",
    config: {mcp_servers: Object.fromEntries(Object.keys(config.mcp_servers ?? {}).map(name => [name, {enabled: false}])),
      plugins: Object.fromEntries(Object.keys(config.plugins ?? {}).map(name => [name, {enabled: false}])), "features.apps": false}});
  const threadId = started.thread.id;
  for (const effort of ["low", "high", null]) {
    const settings = await updateCodexRootSettings(rpc, {threadId, model, ...(effort ? {effort} : {}),
      mode: "default", cwd, approvalPolicy: "never", sandbox: started.sandbox}, AbortSignal.timeout(10000));
    assert.equal(settings.model, model); assert.equal(settings.approvalPolicy, "never"); assert.equal(settings.approvalsReviewer, "user");
    assert.equal(settings.cwd, cwd); assert.equal(settings.sandboxPolicy.type, "dangerFullAccess");
    assert.equal(settings.collaborationMode.settings.reasoning_effort, effort);
    if (effort) assert.equal(settings.effort, effort);
    passed.push(effort ? `effective-effort-${effort}` : "explicit-collaboration-effort-reset");
    // Only public setting values are recorded; no inherited config, auth or instructions.
    console.log(JSON.stringify({effort, effective_effort: settings.effort, mode: settings.collaborationMode.mode}));
  }
  console.log(JSON.stringify({driver: "codex", passed, cwd}));
} finally {await rpc.process.stop();}
