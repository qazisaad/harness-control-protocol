import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp, readFile, rm, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, relative} from "node:path";
import {test} from "node:test";
import {OwnedHarnessInputFileStore, type HarnessInputFileScope} from "./input-files.js";
import {HarnessSessionManager, HarnessAdapterRegistry, type HarnessAdapter} from "./index.js";
import {RunnerConfigSchema} from "../config/index.js";
import {MemoryRunnerStateStore} from "../state/index.js";
import {harnessInputFileOperationSchema, hcpTurnSendPayloadSchema, type HarnessInputFileReference, type HcpSessionStartPayload} from "@harness-control/protocol";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "hcp-files-test-"));
  const cwd = join(root, "workspace");
  const {mkdir} = await import("node:fs/promises");
  await mkdir(cwd);
  const directory = join(root, "store");
  const scope: HarnessInputFileScope = {owner: "conversation:chat", provider_instance_id: "provider", provider_binding_hash: "a".repeat(64), workspace_id: "workspace", cwd};
  const store = new OwnedHarnessInputFileStore(directory);
  const bytes = Buffer.from("owned attachment\n");
  const description = {filename: "report.txt", mime_type: "text/plain", byte_length: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex")};
  const create = (command = "create") => store.operation(scope, command, {kind: "input_file", request: {action: "create", ...description}});
  const append = (reference: HarnessInputFileReference) => store.operation(scope, "append", {kind: "input_file", request: {action: "append", file_id: reference.file_id, offset: 0, data_base64: bytes.toString("base64")}});
  const sealed = () => {const reference = create().reference; append(reference); store.operation(scope, "seal", {kind: "input_file", request: {action: "seal", file_id: reference.file_id}}); return reference;};
  return {root, cwd, directory, scope, store, bytes, description, create, append, sealed, cleanup: () => rm(root, {recursive: true, force: true})};
}

test("chunk retry survives store restart and conflicting offsets or metadata cannot change the upload", async () => {
  const f = await fixture();
  try {
    const reference = f.create().reference;
    assert.deepEqual(f.create().reference, reference);
    assert.throws(() => f.store.operation(f.scope, "create", {kind: "input_file", request: {action: "create", ...f.description, filename: "other.txt"}}), /different file metadata/);
    f.append(reference);
    const restored = new OwnedHarnessInputFileStore(f.directory);
    const repeat = restored.operation(f.scope, "retry", {kind: "input_file", request: {action: "append", file_id: reference.file_id, offset: 0, data_base64: f.bytes.toString("base64")}});
    assert.equal(repeat.received_bytes, f.bytes.length);
    assert.throws(() => restored.operation(f.scope, "conflict", {kind: "input_file", request: {action: "append", file_id: reference.file_id, offset: 0, data_base64: Buffer.alloc(f.bytes.length, 1).toString("base64")}}), /exact upload offset/);
    assert.equal(restored.operation(f.scope, "seal", {kind: "input_file", request: {action: "seal", file_id: reference.file_id}}).state, "sealed");
  } finally {await f.cleanup();}
});

test("partial, hash-mismatched and modified sealed files never reach native context", async () => {
  const f = await fixture();
  try {
    const reference = f.create().reference;
    assert.throws(() => f.store.operation(f.scope, "seal", {kind: "input_file", request: {action: "seal", file_id: reference.file_id}}), /SHA-256/);
    assert.throws(() => f.store.materialize(f.scope, [{reference, delivery: "file_context"}]), /unavailable/);
    f.append(reference);
    f.store.operation(f.scope, "seal", {kind: "input_file", request: {action: "seal", file_id: reference.file_id}});
    await writeFile(join(f.directory, `${reference.file_id}.bin`), "corrupted");
    assert.throws(() => f.store.materialize(f.scope, [{reference, delivery: "file_context"}]), /integrity/);
  } finally {await f.cleanup();}
});

test("workspace paths, provider identities, conversation owners and forged metadata cannot authorize a file", async () => {
  const f = await fixture();
  try {
    const reference = f.sealed();
    for (const scope of [{...f.scope, owner: "conversation:other"}, {...f.scope, cwd: f.root}, {...f.scope, workspace_id: "other"}, {...f.scope, provider_binding_hash: "b".repeat(64)}])
      assert.throws(() => f.store.materialize(scope, [{reference, delivery: "file_context"}]), /unavailable/);
    assert.throws(() => f.store.materialize(f.scope, [{reference: {...reference, filename: "forged.txt"}, delivery: "file_context"}]), /unavailable/);
    assert.throws(() => f.store.materialize(f.scope, [{reference, delivery: "native"}]), /native document input/);
  } finally {await f.cleanup();}
});

test("delivered inputs survive reopening and cannot be released while history may reference them", async () => {
  const f = await fixture();
  try {
    const reference = f.sealed();
    const context = f.store.materialize(f.scope, [{reference, delivery: "file_context"}]);
    const path = JSON.parse(context.slice(context.indexOf("[{")))[0].path as string;
    assert.equal(await readFile(path, "utf8"), f.bytes.toString());
    const restored = new OwnedHarnessInputFileStore(f.directory);
    assert.equal(restored.materialize(f.scope, [{reference, delivery: "file_context"}]), context);
    assert.throws(() => restored.operation(f.scope, "release", {kind: "input_file", request: {action: "release", file_id: reference.file_id}}), /retire the idle conversation/);
    await writeFile(join(f.cwd, ".hcp-inputs", reference.file_id, "unrelated.txt"), "keep");
    restored.retire(f.scope);
    await assert.rejects(readFile(path), /ENOENT/);
    assert.equal(await readFile(join(f.cwd, ".hcp-inputs", reference.file_id, "unrelated.txt"), "utf8"), "keep");
  } finally {await f.cleanup();}
});

test("a symlink attachment root cannot redirect writes outside the authorized workspace", async () => {
  const f = await fixture();
  try {
    const reference = f.sealed();
    await symlink(f.directory, join(f.cwd, ".hcp-inputs"), "junction");
    assert.throws(() => f.store.materialize(f.scope, [{reference, delivery: "file_context"}]), /exact regular path/);
    await assert.rejects(readFile(join(f.directory, reference.file_id, "input.txt")), /ENOENT/);
  } finally {await f.cleanup();}
});

test("forks retain shared native history paths until every owning conversation is retired", async () => {
  const f = await fixture();
  try {
    const reference = f.sealed();
    const context = f.store.materialize(f.scope, [{reference, delivery: "file_context"}]);
    const path = JSON.parse(context.slice(context.indexOf("[{")))[0].path as string;
    f.store.fork(f.scope, "conversation:fork");
    f.store.retire(f.scope);
    assert.equal(await readFile(path, "utf8"), f.bytes.toString());
    const forkScope = {...f.scope, owner: "conversation:fork"};
    const reopened = new OwnedHarnessInputFileStore(f.directory);
    assert.equal(reopened.materialize(forkScope, [{reference, delivery: "file_context"}]), context);
    assert.throws(() => reopened.materialize(f.scope, [{reference, delivery: "file_context"}]), /unavailable/);
    reopened.retire(forkScope);
    await assert.rejects(readFile(path), /ENOENT/);
  } finally {await f.cleanup();}
});

test("relative private directories are canonicalized and independent stores cannot collide in one workspace", async () => {
  const f = await fixture();
  try {
    const reopened = new OwnedHarnessInputFileStore(relative(process.cwd(), f.directory));
    assert.equal(reopened.directory, f.directory);
    const other = new OwnedHarnessInputFileStore(join(f.root, "other-store"));
    const first = f.create().reference;
    const second = other.operation(f.scope, "create", {kind: "input_file", request: {action: "create", ...f.description}}).reference;
    assert.notEqual(first.file_id, second.file_id);
  } finally {await f.cleanup();}
});

test("upload quotas reserve declared lengths and release unused uploads without evicting history", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 8; i++) f.store.operation(f.scope, `large-${i}`, {kind: "input_file", request: {action: "create", ...f.description, byte_length: 32 * 1024 * 1024}});
    assert.throws(() => f.create(), /store is full/);
    const reference = f.store.operation(f.scope, "large-0", {kind: "input_file", request: {action: "create", ...f.description, byte_length: 32 * 1024 * 1024}}).reference;
    assert.equal(f.store.operation(f.scope, "release", {kind: "input_file", request: {action: "release", file_id: reference.file_id}}).state, "released");
    assert.equal(f.create().state, "uploading");
  } finally {await f.cleanup();}
});

test("wire input rejects paths, invalid display names, oversized chunks and files on compaction", () => {
  const description = {filename: "file.txt", mime_type: "text/plain", byte_length: 1, sha256: "a".repeat(64)};
  for (const change of [{filename: "../escape"}, {path: "/etc/passwd"}, {filename: "line\nname"}, {byte_length: 33 * 1024 * 1024}])
    assert.equal(harnessInputFileOperationSchema.safeParse({kind: "input_file", request: {action: "create", ...description, ...change}}).success, false);
  assert.equal(harnessInputFileOperationSchema.safeParse({kind: "input_file", request: {action: "append", file_id: "b".repeat(64), offset: 0, data_base64: Buffer.alloc(65538).toString("base64")}}).success, false);
  assert.equal(hcpTurnSendPayloadSchema.safeParse({session_id: "session", turn_id: "turn", input: "", action: "compact", files: [{reference: {...description, file_id: "b".repeat(64)}, delivery: "file_context"}]}).success, false);
});

test("manager uploads before native conversation creation, projects only selected inputs and retains across reopen", async () => {
  const f = await fixture();
  let nativeTurns = 0;
  const seen: string[] = [];
  const adapter: HarnessAdapter = {driverKind: "example", fileContextInputs: true,
    async probe() {return {driver_kind: "example", installed: true, available: true, models: []};}, async validateStart() {},
    async startSession() {return {adapter_session_id: "native"};}, async sendTurn(input) {
      nativeTurns++; seen.push(input.payload.input); input.persistNativeThread?.("native");
      return [{event_type: "turn.completed", turn_id: input.payload.turn_id, data: {final_output: {final_text: "ok"}}}];
    }, async stopSession() {return [];}, async cancelTurn() {return [];}};
  const config = RunnerConfigSchema.parse({runner_id: "files", control_plane_url: "ws://localhost:1", workspaces: [{id: "workspace", path: f.cwd}], provider_instances: [{id: "provider", driver_kind: "example"}]});
  const state = new MemoryRunnerStateStore();
  const manager = () => new HarnessSessionManager(config, {stateStore: state, inputFileStore: f.store, adapterRegistry: new HarnessAdapterRegistry([adapter])});
  let runner = manager();
  const start: HcpSessionStartPayload = {session_id: "first", workspace_id: "workspace", provider_instance_id: "provider", driver_kind: "example", cwd: f.cwd, sandbox_mode: "read_only", approval_policy: "ask", model_selection: {model: "example"}, mcp_servers: [], continue_session: false, continuation_group_key: "chat"};
  try {
    await runner.startSession(start);
    const created = await runner.conversationOperation("create", {session_id: "first", operation: {kind: "input_file", request: {action: "create", ...f.description}}});
    const reference = created.input_file!.reference;
    assert.equal(nativeTurns, 0);
    for (const request of [{action: "append" as const, file_id: reference.file_id, offset: 0, data_base64: f.bytes.toString("base64")}, {action: "seal" as const, file_id: reference.file_id}])
      await runner.conversationOperation(request.action, {session_id: "first", operation: {kind: "input_file", request}});
    await assert.rejects(runner.sendTurn({session_id: "first", turn_id: "native-unsupported", input: "no", files: [{reference, delivery: "native"}]}), /native document input/);
    assert.equal(nativeTurns, 0);
    await runner.sendTurn({session_id: "first", turn_id: "one", input: "read", files: [{reference, delivery: "file_context"}]});
    assert.match(seen[0]!, /Attached file context/);
    await runner.stopSession("first", "reopen");
    runner = manager();
    await runner.startSession({...start, session_id: "second", continue_session: true});
    await runner.sendTurn({session_id: "second", turn_id: "two", input: "no attachment"});
    assert.equal(seen[1], "no attachment");
    await runner.sendTurn({session_id: "second", turn_id: "three", input: "read", files: [{reference, delivery: "file_context"}]});
    assert.equal(seen[2], seen[0]);
    await runner.stopSession("second", "retire");
    await runner.conversationOperation("retire", {session_id: "second", operation: {kind: "retire"}});
    const nativePath = JSON.parse(seen[0]!.slice(seen[0]!.indexOf("[{")))[0].path as string;
    await assert.rejects(readFile(nativePath), /ENOENT/);
    await assert.rejects(readFile(join(f.directory, `${reference.file_id}.bin`)), /ENOENT/);
  } finally {await f.cleanup();}
});
