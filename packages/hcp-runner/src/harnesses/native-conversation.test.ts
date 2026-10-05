import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeConversationOperation } from "./native-conversation.js";
import type { NativeConversation } from "../state/index.js";
import { ProviderInstanceConfigSchema } from "../config/index.js";

for (const historyMode of ["legacy", "paginated"] as const) test(`${historyMode} history rollback keeps immutable intent and never repeats a mutation`, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "hcp-history-test-"));
  const executable = join(cwd, "codex-fixture.mjs"), historyFile = join(cwd, "history.json"), callsFile = join(cwd, "calls.jsonl");
  const thread = {id: "native-thread", historyMode, turns: [1,2,3].map(number => ({id: `turn-${number}`, status: "completed", items: [{id: `item-${number}`, type: "agentMessage", text: `Answer ${number}`}]}))};
  await writeFile(historyFile, JSON.stringify(thread));
  await writeFile(executable, `#!/usr/bin/env node
import {readFileSync, writeFileSync, appendFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
const historyFile = process.env.HCP_TEST_HISTORY, callsFile = process.env.HCP_TEST_CALLS;
createInterface({input: process.stdin}).on('line', line => {
  const request = JSON.parse(line); if (request.id === undefined) return;
  appendFileSync(callsFile, JSON.stringify(request)+'\\n');
  const thread = JSON.parse(readFileSync(request.params?.threadId === 'forked-thread' ? historyFile+'.fork' : historyFile)); let result = {};
  if (request.method === 'config/read') result = {config: {mcp_servers: {private: {}}, plugins: {private: {}}}};
  if (request.method === 'thread/read' || request.method === 'thread/resume') result = {thread};
  if (request.method === 'thread/turns/list') {
    const offset = Number(request.params.cursor ?? 0), ordered = [...thread.turns].reverse();
    const size = Math.min(2, request.params.limit);
    result = {data: ordered.slice(offset, offset+size), nextCursor: offset+size < ordered.length ? String(offset+size) : null};
  }
  if (request.method === 'thread/fork') {
    const end = request.params.lastTurnId ? thread.turns.findIndex(turn => turn.id === request.params.lastTurnId)+1 : thread.turns.length;
    const forked = {...thread, id: 'forked-thread', turns: thread.turns.slice(0, end)};
    writeFileSync(historyFile+'.fork', JSON.stringify(forked));
    result = {thread: forked.historyMode === 'paginated' ? {...forked, turns: []} : forked};
  }
  if (request.method === 'thread/rollback' || request.method === 'thread/revert') {
    const retained = request.method === 'thread/rollback' ? thread.turns.length-request.params.numTurns : thread.turns.findIndex(turn => turn.id === request.params.beforeTurnId);
    thread.turns = thread.turns.slice(0, retained); writeFileSync(historyFile, JSON.stringify(thread));
    result = {thread: request.method === 'thread/revert' ? {...thread, turns: []} : thread};
  }
  process.stdout.write(JSON.stringify({id: request.id, result})+'\\n');
});
`, {mode: 0o700});
  const provider = ProviderInstanceConfigSchema.parse({id: "codex", driver_kind: "codex", enabled: true, executable_path: executable, env: {HCP_TEST_HISTORY: historyFile, HCP_TEST_CALLS: callsFile}});
  let state: NativeConversation = {native_thread_id: thread.id, binding_hash: "a".repeat(64), provider_binding_hash: "b".repeat(64), updated_at: new Date().toISOString(), last_session_id: "session", provider_instance_id: "codex", workspace_id: "workspace", cwd};
  const save = (next: NativeConversation) => {state = next;};
  try {
    const read = await nativeConversationOperation("read", {session_id: "session", operation: {kind: "read"}}, state, provider, save);
    const page = await nativeConversationOperation("page", {session_id: "session", operation: {kind: "read", limit: 1}}, state, provider, save);
    assert.equal(page.history!.turns[0]?.id, "turn-3");
    const older = await nativeConversationOperation("older", {session_id: "session", operation: {kind: "read", limit: 1, cursor: page.history!.next_cursor!}}, state, provider, save);
    assert.equal(older.history!.turns[0]?.id, "turn-2");
    const request = {session_id: "session", operation: {kind: "rollback" as const, num_turns: 1, expected_history_hash: read.history!.history_hash}};
    await assert.rejects(nativeConversationOperation("stale", {...request, operation: {...request.operation, expected_history_hash: "0".repeat(64)}}, state, provider, save), /changed/);
    assert.equal(state.rollback, undefined);
    let fences = 0;
    const fork = await nativeConversationOperation("fork", {session_id: "session", operation: {kind: "fork", target_session_id: "fork-session",
      continuation_group_key: "fork-key", expected_history_hash: read.history!.history_hash, last_turn_id: "turn-2"}}, state, provider, save, () => {fences++;});
    assert.equal(fences, 1);
    assert.equal(fork.fork?.native_reference, "forked-thread");
    assert.equal(JSON.parse(await readFile(historyFile, "utf8")).turns.length, 3);
    const result = await nativeConversationOperation("rollback-one", request, state, provider, save);
    assert.equal(result.history!.turn_count, 2); assert.equal(result.filesystem_undo, false);
    await assert.rejects(nativeConversationOperation("stale-page", {session_id: "session", operation: {kind: "read", cursor: page.history!.next_cursor!}}, state, provider, save), /restart pagination/);
    const duplicate = await nativeConversationOperation("rollback-one", request, state, provider, save);
    assert.deepEqual(duplicate, result);
    const calls = (await readFile(callsFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const mutations = calls.filter(call => ["thread/revert", "thread/rollback"].includes(call.method));
    assert.equal(mutations.length, 1);
    assert.equal(mutations[0].method, historyMode === "paginated" ? "thread/revert" : "thread/rollback");
    const resume = calls.find(call => call.method === "thread/resume");
    assert.equal(resume.params.sandbox, "read-only");
    assert.deepEqual(resume.params.config.mcp_servers, {private: {enabled: false}});
    state = {...state, rollback: {...state.rollback!, phase: "pending", command_id: "lost", target_hash: "e".repeat(64)}};
    await assert.rejects(nativeConversationOperation("lost", request, state, provider, save), /will not be repeated/);
    await assert.rejects(nativeConversationOperation("different", request, state, provider, save), /must be reconciled/);
  } finally {await rm(cwd, {recursive: true, force: true});}
});
