import assert from "node:assert/strict";
import {mkdtemp, readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash, randomUUID} from "node:crypto";
import {HarnessSessionManager} from "@harness-control/runner/harnesses";
import {RunnerConfigSchema} from "@harness-control/runner/config";
import {JsonRunnerStateStore} from "@harness-control/runner/state";

if (process.env.HCP_NATIVE_LIVE !== "1") throw new Error("Set HCP_NATIVE_LIVE=1 for authenticated model checks.");
const driver = process.env.HCP_LIVE_PROVIDER ?? "codex";
assert.ok(["codex", "claude", "opencode"].includes(driver));
const cwd = await mkdtemp(join(tmpdir(), "hcp-live-input-files-"));
const statePath = join(cwd, "state.json");
const config = RunnerConfigSchema.parse({runner_id: "input-acceptance", control_plane_url: "ws://localhost:1",
  workspaces: [{id: "workspace", path: cwd}], provider_instances: [{id: driver, driver_kind: driver}]});
let manager = new HarnessSessionManager(config, {stateStore: new JsonRunnerStateStore(statePath)});
const status = (await manager.providerDriverStatuses()).find(value => value.driver_kind === driver);
assert.ok(status?.execution_capabilities?.file_inputs?.delivery.includes("file_context"));
const model = driver === "opencode" ? process.env.HCP_LIVE_OPENCODE_MODEL ?? "opencode-go/glm-5.3-flash" :
  status.models.find(value => value.is_default)?.id ?? status.models[0]?.id;
assert.ok(model);
const start = {session_id: "first", workspace_id: "workspace", provider_instance_id: driver, driver_kind: driver,
  cwd, sandbox_mode: "danger_full_access", approval_policy: "full_access", continue_session: false,
  continuation_group_key: "files", execution_profile: "interactive", model_selection: {model}, mcp_servers: [],
  configuration_inheritance: driver === "codex" ? {mcp_servers: false, plugins: false} :
    {user_settings: false, project_settings: false, hooks: false, mcp_servers: false, plugins: false}};
const passed = [];
let nativePath;
try {
  await manager.startSession(start);
  const marker = randomUUID();
  const bytes = Buffer.from(`This attachment contains an acceptance marker: ${marker}\n`);
  const operation = {kind: "input_file", request: {action: "create", filename: "note.txt", mime_type: "text/plain",
    byte_length: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex")}};
  const create = await manager.conversationOperation("create", {session_id: "first", operation});
  const reference = create.input_file.reference;
  assert.deepEqual(await manager.conversationOperation("create", {session_id: "first", operation}), create);
  passed.push("create-before-first-prompt", "idempotent-create");
  for (const request of [{action: "append", file_id: reference.file_id, offset: 0, data_base64: bytes.toString("base64")},
    {action: "seal", file_id: reference.file_id}])
    await manager.conversationOperation(request.action, {session_id: "first", operation: {kind: "input_file", request}});
  await assert.rejects(manager.sendTurn({session_id: "first", turn_id: "unsupported-native", input: "must not execute",
    files: [{reference, delivery: "native"}]}), error => error?.code === "input_file_delivery_unsupported");
  passed.push("verified-upload", "native-document-refused-before-dispatch");
  const read = async (session, turn) => {
    const events = await manager.sendTurn({session_id: session, turn_id: turn,
      input: "Read the attached file using your native file tool. Reply only with its acceptance marker.", files: [{reference, delivery: "file_context"}]});
    const terminal = events.findLast(event => ["turn.completed", "turn.failed", "turn.cancelled"].includes(event.event_type));
    assert.equal(terminal?.event_type, "turn.completed");
    assert.ok(JSON.stringify(terminal.data).includes(marker));
    assert.ok(events.some(event => event.event_type === "item.completed" || event.event_type === "command.completed" || event.event_type === "mcp_tool.completed"));
  };
  await read("first", "read");
  nativePath = join(cwd, ".hcp-inputs", reference.file_id, "input.txt");
  assert.equal(await readFile(nativePath, "utf8"), bytes.toString());
  await assert.rejects(manager.conversationOperation("release-used", {session_id: "first", operation: {kind: "input_file", request: {action: "release", file_id: reference.file_id}}}), error => error?.code === "input_file_retained");
  passed.push("native-file-tool-read", "history-retention-fence");
  await manager.stopSession("first", "reopen");
  assert.equal(await readFile(nativePath, "utf8"), bytes.toString());
  const forked = process.env.HCP_LIVE_FORK === "1";
  if (forked) {
    const history = await manager.conversationOperation("read-before-fork", {session_id: "first", operation: {kind: "read"}});
    await manager.conversationOperation("fork-with-files", {session_id: "first", operation: {kind: "fork", target_session_id: "reopened",
      continuation_group_key: "files-fork", expected_history_hash: history.history.history_hash}});
    await manager.conversationOperation("retire-source", {session_id: "first", operation: {kind: "retire"}});
    assert.equal(await readFile(nativePath, "utf8"), bytes.toString());
    passed.push("native-fork-pins-inherited-file", "source-retirement-preserves-fork-file");
  }
  manager = new HarnessSessionManager(config, {stateStore: new JsonRunnerStateStore(statePath)});
  await manager.startSession({...start, session_id: "reopened", ...(forked ? {continuation_group_key: "files-fork"} : {}), continue_session: true});
  await read("reopened", "read-again");
  passed.push(forked ? "fork-file-read-after-source-retirement-and-restart" : "same-conversation-files-after-restart");
  await manager.stopSession("reopened", "retire");
  await manager.conversationOperation("retire", {session_id: "reopened", operation: {kind: "retire"}});
  await assert.rejects(readFile(nativePath), error => error?.code === "ENOENT");
  passed.push("idle-retirement-cleans-owned-file");
} finally {
  for (const session of ["first", "reopened"]) {
    try {await manager.stopSession(session, "cleanup");}
    catch (error) {if (error?.code !== "session_not_found") throw error;}
  }
}
console.log(JSON.stringify({driver, passed, cwd}));
