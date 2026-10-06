import { afterEach, it } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultHarnessAdapterRegistry } from "./adapters/registry.js";
import { RunnerConfigSchema } from "../config/index.js";
import { hcpSessionStartPayloadSchema, type HcpSessionStartPayload } from "@harness-control/protocol";

const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map(path => rm(path, {recursive: true, force: true}))); });

it("the installed Codex runner separates task input and instructions on start and resume", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "p2a-harness-instructions-")); folders.push(cwd);
  const executable = join(cwd, "codex.cjs"), record = join(cwd, "requests.jsonl");
  await writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
require('node:readline').createInterface({input: process.stdin}).on('line', line => {
  const request = JSON.parse(line); if (request.id === undefined) return;
  fs.appendFileSync(process.env.RECORD, JSON.stringify(request)+'\\n');
  let result = {};
  if (request.method === 'config/read') result = {config: {mcp_servers: {personal: {enabled: true}}}};
  if (request.method === 'thread/start' || request.method === 'thread/resume') result = {thread: {id: 'native-thread'}, sandbox: {type: 'readOnly'}, approvalPolicy: 'never'};
  if (request.method === 'mcpServerStatus/list') result = {data: [{name: 'personal', runtimeStatus: 'disabled', tools: {}}], nextCursor: null};
  if (request.method === 'thread/loaded/list') result = {data: [], nextCursor: null};
  if (request.method === 'turn/start') result = {turn: {id: 'native-turn'}};
  send({id: request.id, result});
  if (request.method === 'turn/start') {
    send({method: 'turn/started', params: {threadId: 'native-thread', turn: {id: 'native-turn'}}});
    send({method: 'item/completed', params: {threadId: 'native-thread', turnId: 'native-turn', item: {id: 'answer', type: 'agentMessage', text: 'done'}}});
    send({method: 'turn/completed', params: {threadId: 'native-thread', turn: {id: 'native-turn', status: 'completed', error: null}}});
  }
});
`);
  await chmod(executable, 0o755);
  const provider = RunnerConfigSchema.parse({runner_id: "test", control_plane_url: "ws://localhost:8787", workspaces: [{id: "repo", path: cwd}],
    provider_instances: [{id: "codex", driver_kind: "codex", executable_path: executable, env: {RECORD: record}}]}).provider_instances[0];
  assert.ok(provider);
  const registry = createDefaultHarnessAdapterRegistry();
  try {
    for (const [index, instructions] of ["Focus on security", "Updated instructions", undefined].entries()) {
      const startPayload = hcpSessionStartPayloadSchema.parse({session_id: `session-${index}`, workspace_id: "repo", provider_instance_id: "codex",
        driver_kind: "codex", cwd, sandbox_mode: "read_only", approval_policy: "full_access", continue_session: index > 0,
        ...(index > 0 ? {continuation_group_key: "chat"} : {}), ...(instructions !== undefined ? {instructions} : {}), model_selection: {model: "test"}, mcp_servers: []}) as HcpSessionStartPayload;
      const terminal = await registry.require("codex").sendTurn({startPayload, provider,
        session: {adapter_session_id: startPayload.session_id, ...(index > 0 ? {native_thread_id: "native-thread"} : {})},
        payload: {session_id: startPayload.session_id, turn_id: `turn-${index}`, input: "Review this code"}});
      assert.equal(terminal.at(-1)?.event_type, "turn.completed");
    }
  } finally { await registry.close(); }
  const calls = (await readFile(record, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const starts = calls.filter(call => ["thread/start", "thread/resume"].includes(call.method));
  assert.deepEqual(starts.map(call => call.params.developerInstructions), ["Focus on security", "Updated instructions", ""]);
  assert.deepEqual(starts.map(call => call.method), ["thread/start", "thread/resume", "thread/resume"]);
  assert.ok(starts.every(call => call.params.config.mcp_servers.personal.enabled === false));
  assert.ok(calls.filter(call => call.method === "turn/start").every(call => call.params.input[0].text === "Review this code"));
});
