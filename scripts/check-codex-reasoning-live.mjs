import assert from "node:assert/strict";
import {mkdtemp, realpath} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {WebSocketServer} from "ws";
import {HcpHostConnection, projectHcpReasoningItems} from "@harness-control/sdk";
import {harnessTextDeltaEventDataSchema, harnessNativeReasoningContentSchema} from "@harness-control/protocol";
import {RunnerConnection} from "@harness-control/runner/connection";
import {RunnerConfigSchema} from "@harness-control/runner/config";
import {HarnessSessionManager} from "@harness-control/runner/harnesses";

if (process.env.HCP_CODEX_REASONING_LIVE !== "1") throw new Error("Set HCP_CODEX_REASONING_LIVE=1 for isolated native reasoning acceptance.");
const cwd = await realpath(await mkdtemp(join(tmpdir(), "hcp-native-reasoning-")));
const server = new WebSocketServer({host: "127.0.0.1", port: 0});
await new Promise((resolve, reject) => {server.once("listening", resolve);server.once("error", reject);});
const config = RunnerConfigSchema.parse({runner_id: "native-plan", control_plane_url: `ws://127.0.0.1:${server.address().port}`,
  workspaces: [{id: "workspace", path: cwd}], provider_instances: [{id: "codex", driver_kind: "codex"}]});
const manager = new HarnessSessionManager(config), events = [];
let peer, runner, ready, failed;
const connected = new Promise((resolve, reject) => {ready = resolve;failed = reject;});
server.on("connection", socket => {
  peer = new HcpHostConnection({send: message => socket.send(JSON.stringify(message))});
  socket.on("close", () => peer.disconnect());
  socket.on("message", raw => {try {
    const result = peer.receive(raw.toString());
    if (result.message.type === "host.hello") peer.accept({protocol_version: "hcp.v0", heartbeat_interval_seconds: 30});
    if (result.message.type === "host.capabilities.updated") ready();
    if (result.message.type === "harness.event" && result.reduction.outcome !== "duplicate") {
      assert.equal(result.reduction.outcome, "applied");events.push(result.message.payload);
    }
  } catch (error) {failed(error);}});
});
try {
  const provider = (await manager.providerDriverStatuses()).find(provider => provider.driver_kind === "codex");
  assert.equal(provider.execution_capabilities.execution_profiles.find(profile => profile.id === "interactive").native_reasoning_segments, true);
  const model = process.env.HCP_LIVE_CODEX_MODEL ?? provider.models.find(model => model.is_default)?.id;assert.ok(model);
  runner = new RunnerConnection({config, runnerVersion: "native-plan", harnessSessions: manager});await runner.connect();await connected;
  await peer.startSession({session_id: "plan", workspace_id: "workspace", cwd, provider_instance_id: "codex", driver_kind: "codex",
    execution_profile: "interactive", model_selection: {model, options: [{id: "reasoningSummary", value: "detailed"}]}, sandbox_mode: "read_only", approval_policy: "ask", continue_session: false, mcp_servers: []});
  assert.equal(events.some(event => event.event_type === "native.execution.admitted"), false);
  await peer.sendTurn({session_id: "plan", turn_id: "original", mode: "execute",
    input: "Mentally check whether 137 times 149 equals 20413 and explain the arithmetic in one short paragraph. Use no tools, files, shell, agents, network or questions."});
  const terminal = await peer.waitForSessionEvent("plan", event => event.turn_id === "original" &&
    ["turn.completed", "turn.failed", "turn.cancelled", "turn.aborted"].includes(event.event_type), {afterSequence: 0, timeoutMs: 60_000});
  assert.equal(terminal.event_type, "turn.completed", terminal.data.error?.code);
  assert.ok(events.some(event => event.event_type === "settings.effective" && event.data.source === "native" &&
    event.data.model_selection.options.some(option => option.id === "reasoningSummary" && option.value === "detailed")));
  const deltas = events.filter(event => event.event_type === "reasoning.delta").map(event => harnessTextDeltaEventDataSchema.parse(event.data));
  assert.ok(deltas.some(delta => delta.native_segment && delta.item_id && delta.native_execution_reference), JSON.stringify({
    reasoning_deltas: deltas.length,
    reasoning_items: events.filter(event => event.event_type === "item.completed" && event.data.item_type === "reasoning").map(event => ({
      native_item: Boolean(event.data.item_id), native_phase: Boolean(event.data.native_execution_reference),
      summary_parts: Array.isArray(event.data.content?.summary) ? event.data.content.summary.length : null,
      content_parts: Array.isArray(event.data.content?.content) ? event.data.content.content.length : null}))}));
  const reasoning = projectHcpReasoningItems(events, "plan", "original");assert.ok(reasoning.length);
  const item = reasoning.find(item => item.completed && item.item_id && item.native_execution_reference);assert.ok(item);
  const content = harnessNativeReasoningContentSchema.parse(item.completed_content);
  assert.ok(Array.isArray(content.summary));assert.ok(Array.isArray(content.content));
  const resolved = await peer.readReasoningItemsComplete("plan", events, "original");
  assert.equal(resolved.length, reasoning.length);
  assert.deepEqual(resolved.find(value => value.source.item_id === item.item_id && value.source.native_execution_reference === item.native_execution_reference)?.completed_content, content);
  assert.ok(item.segments.some(segment => segment.index !== undefined && ["summary", "content"].includes(segment.kind)));
  assert.equal(item.origin_turn_id, "original");
  assert.ok(events.some(event => event.event_type === "native.execution.completed" && event.data.native_execution_reference === item.native_execution_reference && event.data.status === "completed"));
  assert.ok(events.some(event => event.event_type === "item.completed" && event.data.item_id === item.item_id && event.data.item_type === "reasoning"));
  assert.equal(events.some(event => ["approval.requested", "user_input.requested", "native.work.updated"].includes(event.event_type)), false);
  for (const [turn_id, options, expected] of [["summary-disabled", [{id: "reasoningSummary", value: "none"}], "none"],
    ["summary-default", [], "auto"]]) {
    await peer.sendTurn({session_id: "plan", turn_id, mode: "execute", model_selection: {model, options},
      input: "Reply with exactly OK. Use no tools, files, shell, agents, network or questions."});
    const done = await peer.waitForSessionEvent("plan", event => event.turn_id === turn_id &&
      ["turn.completed", "turn.failed", "turn.cancelled", "turn.aborted"].includes(event.event_type), {afterSequence: 0, timeoutMs: 60_000});
    assert.equal(done.event_type, "turn.completed", done.data.error?.code);
    assert.ok(events.some(event => event.turn_id === turn_id && event.event_type === "settings.effective" &&
      event.data.model_selection.options.some(option => option.id === "reasoningSummary" && option.value === expected)));
  }
  await peer.stopSession({session_id: "plan"});const exited = await peer.waitForSessionEvent("plan", event => event.event_type === "session.exited", {afterSequence: 0});
  assert.equal(exited.event_type, "session.exited");
  console.log(JSON.stringify({driver: "codex", version: provider.version, cwd, passed: ["declared-native-reasoning-segments", "no-model-startup",
    "native-summary-selection-readback", "actual-native-reasoning-deltas", "actual-native-segment-index", "authoritative-summary-and-content-arrays", "exact-native-phase",
    "original-origin", "sdk-preview-and-final-separation", "sdk-complete-native-body", "no-tools-or-questions", "native-summary-disable-readback", "native-summary-default-reset-readback", "confirmed-unload"]}));
} finally {if (runner) await runner.close().catch(() => {});for (const socket of server.clients) socket.terminate();await new Promise(resolve => server.close(resolve));}
