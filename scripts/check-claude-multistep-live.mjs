import assert from "node:assert/strict";
import {mkdtemp, readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {HarnessSessionManager} from "@harness-control/runner/harnesses";
import {RunnerConfigSchema} from "@harness-control/runner/config";

if (process.env.HCP_NATIVE_LIVE !== "1") throw new Error("Set HCP_NATIVE_LIVE=1 for authenticated native acceptance.");
const cwd = await mkdtemp(join(tmpdir(), "hcp-live-claude-multistep-"));
const config = RunnerConfigSchema.parse({runner_id: "multistep-acceptance", control_plane_url: "ws://localhost:1",
  workspaces: [{id: "workspace", path: cwd}], provider_instances: [{id: "claude", driver_kind: "claude"}]});
const manager = new HarnessSessionManager(config), events = [], responses = [], passed = [];
const marker = randomUUID(), first = join(cwd, "first.txt"), second = join(cwd, "second.txt");
const commands = [`printf '%s' '${marker}' > '${first}'`, `test -f '${first}' && printf '%s' '${marker}' > '${second}'`];
const unsubscribe = manager.subscribeEvents(event => {
  events.push(event);
  if (event.event_type !== "approval.requested") return;
  const details = JSON.parse(event.data.action).details;
  const allowed = commands.includes(details.arguments?.command);
  responses.push(manager.respondToMcpReview({session_id: "session", turn_id: event.turn_id, request_id: event.data.request_id,
    action_hash: event.data.action_hash, decision: allowed ? "accept" : "decline", actor_id: "acceptance"}));
});
try {
  await manager.startSession({session_id: "session", workspace_id: "workspace", provider_instance_id: "claude", driver_kind: "claude", cwd,
    model_selection: {model: process.env.HCP_LIVE_CLAUDE_MODEL ?? "sonnet"}, execution_profile: "interactive",
    sandbox_mode: "danger_full_access", approval_policy: "ask", continue_session: false, mcp_servers: []});
  await manager.sendTurn({session_id: "session", turn_id: "root", input:
    `Use exactly two separate Bash tool calls, sequentially. First execute exactly: ${commands[0]}\nWait for that tool's result, then execute exactly: ${commands[1]}\nDo not combine the calls or use any other tool. Reply DONE after both succeed.`});
  await Promise.all(responses);
  assert.equal(events.findLast(event => event.turn_id === "root" && ["turn.completed", "turn.failed", "turn.cancelled"].includes(event.event_type))?.event_type, "turn.completed");
  assert.equal(await readFile(first, "utf8"), marker); passed.push("first-tool-effect");
  assert.equal(await readFile(second, "utf8"), marker); passed.push("second-tool-effect");
  assert.equal(events.filter(event => event.turn_id === "root" && event.event_type === "approval.requested").length, 2); passed.push("both-root-approvals");
  assert.equal(events.filter(event => event.turn_id === "root" && event.event_type === "item.started" && event.data.item_type === "tool_call").length, 2); passed.push("both-root-tool-events");
  await manager.sendTurn({session_id: "session", turn_id: "followup", input: "Reply STILL_USABLE only. Use no tools."});
  assert.equal(events.findLast(event => event.turn_id === "followup" && event.event_type === "turn.completed")?.event_type, "turn.completed"); passed.push("usable-followup");
  await manager.stopSession("session", "acceptance-unload"); passed.push("safe-unload");
  console.log(JSON.stringify({driver: "claude", cwd, passed}));
} catch (error) {console.log(JSON.stringify({driver: "claude", cwd, passed, failed: true, code: error?.code ?? "acceptance_failure",
  approvals: events.filter(event => event.event_type === "approval.requested").length,
  root_tool_events: events.filter(event => event.turn_id === "root" && event.event_type === "item.started").length,
  session_outputs: events.filter(event => event.event_type === "native.output.updated").length})); process.exitCode = 1;}
finally {unsubscribe(); try {await manager.stopSession("session", "acceptance-cleanup");} catch {process.exitCode = 1;}}
