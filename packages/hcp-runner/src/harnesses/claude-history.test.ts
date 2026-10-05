import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdir, mkdtemp, rm, writeFile, appendFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {RunnerConfigSchema} from "../config/index.js";
import {claudeSessionHelper} from "./adapters/providers/claude-session-helper.js";
import {claudeConversation} from "./adapters/providers/claude-conversation.js";
import type {HarnessAdapterConversationInput} from "./adapters/types.js";

test("Claude SDK history, bounded forks and logical rollback preserve context without changing source files", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "hcp-claude-history-"));
  const home = join(cwd, "account");
  const sessionId = randomUUID();
  const ids = Array.from({length: 4}, () => randomUUID());
  const provider = RunnerConfigSchema.parse({runner_id: "runner", control_plane_url: "ws://localhost:1",
    provider_instances: [{id: "claude", driver_kind: "claude", home}]}).provider_instances[0]!;
  const directory = join(home, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  await mkdir(directory, {recursive: true});
  const source = ids.map((uuid, index) => ({uuid, parentUuid: ids[index - 1] ?? null,
    sessionId, cwd, timestamp: new Date().toISOString(), type: index % 2 ? "assistant" : "user",
    message: {role: index % 2 ? "assistant" : "user", content: [{type: "text", text: `message-${index}`}],
      ...(index % 2 ? {id: `msg-${index}`, model: "sonnet", stop_reason: "end_turn", stop_sequence: null,
        usage: {input_tokens: 1, output_tokens: 1}} : {})}}));
  await writeFile(join(directory, `${sessionId}.jsonl`), source.map(value => JSON.stringify(value)).join("\n") + "\n");
  let conversation: HarnessAdapterConversationInput["conversation"] = {last_session_id: "session", native_thread_id: sessionId,
    provider_instance_id: "claude", workspace_id: "workspace", cwd, binding_hash: "b".repeat(64),
    provider_binding_hash: "a".repeat(64), updated_at: new Date().toISOString()};
  const input = (operation: HarnessAdapterConversationInput["request"]["operation"], commandId = randomUUID()): HarnessAdapterConversationInput => ({
    commandId, request: {session_id: "session", operation}, conversation, provider,
    save: value => {conversation = value;}, beginMutation() {},
    publishContent() {throw new Error("Unexpected oversized content");}});
  try {
    let read = await claudeConversation(input({kind: "read"}));
    assert.equal(read.history?.turns.length, 2);
    const portable = read.history!.turns[0]!.portable_items!;
    assert.deepEqual(portable.map(item => item.type === "message" ? item.role : item.type), ["user", "assistant"]);
    const fork = await claudeConversation(input({kind: "fork", target_session_id: "child", continuation_group_key: "child-key",
      expected_history_hash: read.history!.history_hash, last_turn_id: read.history!.turns[0]!.id}));
    const child = await claudeSessionHelper(provider, cwd, {kind: "read", sessionId: fork.fork!.native_reference}) as {messages: unknown[]};
    assert.equal(child.messages.length, 2);
    await appendFile(join(directory, `${sessionId}.jsonl`), JSON.stringify({type: "custom-title", sessionId,
      customTitle: "metadata-only change", uuid: randomUUID(), timestamp: new Date().toISOString()}) + "\n");
    await assert.rejects(claudeConversation(input({kind: "rollback", num_turns: 1, expected_history_hash: read.history!.history_hash})), /Read the current history/);
    assert.equal(conversation.rollback, undefined);
    read = await claudeConversation(input({kind: "read"}));
    const commandId = randomUUID();
    const rollback = await claudeConversation(input({kind: "rollback", num_turns: 1, expected_history_hash: read.history!.history_hash}, commandId));
    assert.equal(rollback.history?.turns.length, 1);
    assert.notEqual(rollback.native_reference, sessionId);
    const duplicate = await claudeConversation(input({kind: "rollback", num_turns: 1, expected_history_hash: read.history!.history_hash}, commandId));
    assert.equal(duplicate.native_reference, rollback.native_reference);
    const original = await claudeSessionHelper(provider, cwd, {kind: "read", sessionId}) as {messages: unknown[]};
    assert.equal(original.messages.length, 4);
    await assert.rejects(claudeSessionHelper({...provider, home: join(cwd, "other-account")}, cwd, {kind: "read", sessionId}));
  } finally {await rm(cwd, {recursive: true, force: true});}
});
