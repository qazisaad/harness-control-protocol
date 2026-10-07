// Opt-in authenticated native plan-input and rejection-feedback acceptance.
import assert from "node:assert/strict";
import {mkdtemp, realpath} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {setTimeout as delay} from "node:timers/promises";
import {WebSocketServer} from "ws";
import {HcpHostConnection, HcpNativeSessions} from "@harness-control/sdk";
import {HarnessSessionManager} from "@harness-control/runner/harnesses";
import {RunnerConnection} from "@harness-control/runner/connection";
import {RunnerConfigSchema} from "@harness-control/runner/config";
import {JsonRunnerStateStore} from "@harness-control/runner/state";
if (process.env.HCP_NATIVE_LIVE !== "1") throw new Error("Set HCP_NATIVE_LIVE=1 for controlled public Claude policy acceptance.");
const cwd = await realpath(await mkdtemp(join(tmpdir(), "hcp-native-claude-policy-control-"))), passed = [], events = [];
const server = new WebSocketServer({host: "127.0.0.1", port: 0}); await new Promise(resolve => server.once("listening", resolve));
let peer, owners, runner, failure, ready = false;let respond = () => {};
server.on("connection", socket => {
  peer = new HcpHostConnection({send(message) {socket.send(JSON.stringify(message));}}); owners = new HcpNativeSessions(peer);
  socket.on("message", raw => {try {
    const observation = peer.receive(raw.toString());
    if (observation.message.type === "host.hello") peer.accept({protocol_version: "hcp.v0", heartbeat_interval_seconds: 30});
    if (observation.message.type === "host.capabilities.updated") ready = true;
    if (observation.message.type === "harness.event") {
      if (!["applied", "duplicate"].includes(observation.reduction.outcome)) throw new Error("Native policy observation continuity changed.");
      events.push(observation.message.payload);respond(observation.message.payload);
    }
  } catch (error) {failure = error; socket.close();}}); socket.on("close", () => peer.disconnect());
});
const until = async predicate => {const deadline = Date.now() + 90000; while (!predicate()) {
  if (failure) throw failure; if (Date.now() > deadline) throw new Error("Native policy acceptance timed out."); await delay(20);
}};
const config = RunnerConfigSchema.parse({runner_id: "native-claude-policy", control_plane_url: `ws://127.0.0.1:${server.address().port}`,
  workspaces: [{id: "workspace", path: cwd}], provider_instances: [{id: "claude", driver_kind: "claude",
    ...(process.env.HCP_LIVE_CLAUDE_EXECUTABLE ? {executable_path: process.env.HCP_LIVE_CLAUDE_EXECUTABLE} : {})}]});
const state = new JsonRunnerStateStore(join(cwd, "state.json")), manager = new HarnessSessionManager(config, {stateStore: state});
try {
  runner = new RunnerConnection({config, runnerVersion: "native-denial-acceptance", harnessSessions: manager, stateStore: state}); await runner.connect(); await until(() => ready);
  const feedback = "The controlled fixture declines this operation. Reply DECLINED_FIXTURE only and do not retry or call any tool.";
  const responses = [];
  respond = event => {if (event.event_type !== "approval.requested") return;
    const reply = (async () => {
      assert.equal(event.session_id, "policy");assert.equal(event.turn_id, "declined");assert.equal(event.data.rejection_feedback_supported, true);
      assert.equal(event.data.native_request.source, "native");assert.ok(event.data.native_request.call_reference);
      const details = JSON.parse(event.data.action).details;assert.equal(details.tool, "ExitPlanMode");assert.equal(typeof details.arguments.plan, "string");assert.match(details.arguments.plan, /Controlled fixture/i);
      await assert.rejects(peer.respondToApproval({session_id: "policy", turn_id: "wrong", request_id: event.data.request_id, action_hash: event.data.action_hash, decision: "decline", actor_id: "fixture", feedback}));
      await peer.respondToApproval({session_id: "policy", turn_id: "declined", request_id: event.data.request_id, action_hash: event.data.action_hash, decision: "decline", actor_id: "fixture", feedback});
    })();responses.push(reply);void reply.catch(error => {failure = error;});
  };
  await owners.open({session_id: "policy", workspace_id: "workspace", cwd, provider_instance_id: "claude", driver_kind: "claude", execution_profile: "interactive",
    model_selection: {model: process.env.HCP_LIVE_CLAUDE_MODEL ?? "sonnet"}, sandbox_mode: "danger_full_access", approval_policy: "ask", continue_session: false, continuation_group_key: "fixture", mcp_servers: [],
    configuration_inheritance: {user_settings: false, project_settings: false, hooks: false, mcp_servers: false, plugins: false}}, {readiness: "configured"});
  await peer.sendTurn({session_id: "policy", turn_id: "declined", mode: "plan", input: "Prepare a tiny proposed plan headed Controlled fixture with two steps: inspect the fixture, then report observations. This is planning only; do not implement it or execute shell commands. Use Write only if needed for the native plan file, then call ExitPlanMode exactly once. If declined, obey the supplied feedback and do not retry or use tools."});
  await until(() => events.some(event => event.turn_id === "declined" && ["turn.completed", "turn.failed", "turn.cancelled"].includes(event.event_type)));await Promise.all(responses);
  assert.equal(responses.length, 1);assert.equal(events.findLast(event => event.turn_id === "declined" && ["turn.completed", "turn.failed", "turn.cancelled"].includes(event.event_type)).event_type, "turn.completed");
  const request = events.find(event => event.event_type === "approval.requested");const resolved = events.find(event => event.event_type === "approval.resolved");assert.ok(resolved);assert.equal(resolved.data.request_id, request.data.request_id);assert.equal(resolved.data.feedback, feedback);assert.equal(resolved.data.decision, "decline");
  passed.push("actual-native-callback-and-scoped-public-denial", "wrong-root-feedback-refused", "feedback-preserved-in-confirmed-resolution");
  const proposals = await peer.readNativeProposalInputsComplete("policy", events, "declined");assert.ok(proposals.length);assert.ok(proposals.every(proposal => /Controlled fixture/i.test(proposal.plan)));assert.ok(proposals.some(proposal => proposal.source.native_proposal.native_item_reference === request.data.native_request.call_reference && proposal.source.native_proposal.request_reference === request.data.native_request.request_reference));passed.push("complete-actual-proposal-input-and-native-callback-identity");
  const terminal = events.findLast(event => event.turn_id === "declined" && event.event_type === "turn.completed");const output = await peer.readFinalTextComplete("policy", terminal.data.final_output);assert.equal(output.availability, "complete");assert.match(output.final_text, /DECLINED_FIXTURE/);passed.push("actual-model-observes-rejection-feedback");
  await assert.rejects(peer.respondToApproval({session_id: "policy", turn_id: "declined", request_id: request.data.request_id, action_hash: request.data.action_hash, decision: "accept", actor_id: "fixture"}));passed.push("resolved-callback-not-replayed");
  await peer.sendTurn({session_id: "policy", turn_id: "followup", input: "Reply USABLE only. Use no tools."});await until(() => events.some(event => event.turn_id === "followup" && ["turn.completed", "turn.failed", "turn.cancelled"].includes(event.event_type)));assert.equal(events.findLast(event => event.turn_id === "followup" && ["turn.completed", "turn.failed", "turn.cancelled"].includes(event.event_type)).event_type, "turn.completed");passed.push("same-owner-followup-after-denial");
  await owners.close("policy");assert.equal(owners.state("policy").phase, "closed");passed.push("confirmed-native-owner-closure");
  console.log(JSON.stringify({driver: "claude", scope: "authenticated-public-proposal-input-feedback", passed}));
} catch (error) {process.exitCode = 1;console.log(JSON.stringify({driver: "claude", passed, failed: true, code: typeof error?.code === "string" && /^[a-zA-Z0-9_]{1,128}$/.test(error.code) ? error.code : "acceptance_failed"}));}
finally {owners?.dispose();await runner?.close();await manager.close();for (const socket of server.clients) socket.terminate();await new Promise(resolve => server.close(resolve));}
