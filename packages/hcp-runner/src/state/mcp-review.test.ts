import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MCP_REVIEW_META_KEY, type HcpHarnessEventPayload } from "@harness-control/protocol";
import { JsonRunnerStateStore, MemoryRunnerStateStore } from "./index.js";
import type { PersistedMcpReview } from "./mcp-review.js";
import { parseMcpPendingInput } from "../mcp/input-required.js";

function pending() {
  const action = JSON.stringify({kind: "mcp_tool", attachment_name: "selected", tool_name: "lookup", arguments: {query: "exact"}});
  const review: PersistedMcpReview = {
    start: {session_id: "session", workspace_id: "workspace", provider_instance_id: "codex", driver_kind: "codex",
      cwd: "/repo", sandbox_mode: "read_only", approval_policy: "full_access", continue_session: false,
      model_selection: {model: "model", options: []}, mcp_servers: []},
    turn: {session_id: "session", turn_id: "turn", input: "Find a record"},
    native_thread_id: "native-thread", native_turn_id: "native-turn", native_call_id: "native-call",
    request_id: "request", action_json: action, action_hash: createHash("sha256").update(action).digest("hex"),
    expires_at: "2026-09-20T00:00:00Z", outcome: {phase: "waiting"},
  };
  const event: HcpHarnessEventPayload = {session_id: "session", turn_id: "turn", sequence: 1,
    event_type: "approval.requested", created_at: "2026-09-19T00:00:00Z", data: {
      request_id: review.request_id, session_id: "session", turn_id: "turn", workspace_id: "workspace",
      provider_instance_id: "codex", driver_kind: "codex", request_type: "mcp_tool", risk_class: "medium",
      action, action_hash: review.action_hash, allowed_decisions: ["accept", "decline"],
      expires_at: review.expires_at, display: {title: "Review lookup"},
    }};
  return {review, event};
}

function decisionEvent(review: PersistedMcpReview, decision: "accept" | "decline"): HcpHarnessEventPayload {
  return {session_id: "session", turn_id: "turn", sequence: 2, event_type: "approval.resolved",
    created_at: "2026-09-19T00:01:00Z", data: {session_id: "session", turn_id: "turn", request_id: review.request_id,
      action_hash: review.action_hash, actor_id: "actor", decision, resolved_at: "2026-09-19T00:01:00Z"}};
}

test("MCP continuation and approval event survive restart together in private storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "hcp-review-"));
  const path = join(root, "state.json");
  try {
    const {review, event} = pending();
    new JsonRunnerStateStore(path).saveMcpReview(review, event);
    const restarted = new JsonRunnerStateStore(path);
    assert.deepEqual(restarted.getMcpReview("session"), review);
    assert.deepEqual(restarted.replayEventsAfter("session", 0), [event]);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const dispatching: PersistedMcpReview = {...review, outcome: {phase: "dispatching", actor_id: "actor"}};
    assert.throws(() => restarted.saveMcpReview(dispatching), /transition/);
    restarted.saveMcpReview(dispatching, decisionEvent(review, "accept"));
    const duringCall = new JsonRunnerStateStore(path);
    assert.equal(duringCall.getMcpReview("session")?.outcome.phase, "dispatching");
    assert.throws(() => duringCall.saveMcpReview(review), /transition/);
    const completed: PersistedMcpReview = {...review, outcome: {phase: "completed", actor_id: "actor", result_json: '{"is_error":false}'}};
    duringCall.saveMcpReview(completed);
    const afterCall = new JsonRunnerStateStore(path);
    assert.deepEqual(afterCall.getMcpReview("session"), completed);
    assert.throws(() => afterCall.clearMcpReview("session", "another-request"), /identity/);
    afterCall.clearMcpReview("session", "request");
    assert.equal(new JsonRunnerStateStore(path).getMcpReview("session"), undefined);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test("a failed durable write publishes neither the private continuation nor its event", () => {
  class FailingStore extends MemoryRunnerStateStore {
    override persist(): void { throw new Error("disk unavailable"); }
  }
  const {review, event} = pending();
  const store = new FailingStore();
  assert.throws(() => store.saveMcpReview(review, event), /disk unavailable/);
  assert.equal(store.getMcpReview("session"), undefined);
  assert.equal(store.nextEventSequence("session"), 1);
});

test("review bindings and decisions cannot be changed after persistence", () => {
  const {review, event} = pending();
  const store = new MemoryRunnerStateStore();
  assert.throws(() => store.saveMcpReview(review), /waiting event/);
  store.saveMcpReview(review, event);
  assert.throws(() => store.saveMcpReview({...review, native_thread_id: "another"}), /transition/);
  store.saveMcpReview({...review, outcome: {phase: "declined", actor_id: "actor"}}, decisionEvent(review, "decline"));
  assert.throws(() => store.saveMcpReview({...review, outcome: {phase: "dispatching", actor_id: "actor"}}), /transition/);
});

test("the durable review decision and its published actor must agree", () => {
  const {review, event} = pending();
  const store = new MemoryRunnerStateStore();
  store.saveMcpReview(review, event);
  const updated: PersistedMcpReview = {...review, outcome: {phase: "dispatching", actor_id: "actor"}};
  assert.throws(() => store.saveMcpReview(updated, decisionEvent(review, "decline")), /decision differs/);
  assert.throws(() => store.saveMcpReview({...updated, outcome: {phase: "dispatching", actor_id: "other"}}, decisionEvent(review, "accept")), /decision differs/);
  assert.equal(store.getMcpReview("session")?.outcome.phase, "waiting");
  assert.equal(store.nextEventSequence("session"), 2);
});

function inputEvent(review: PersistedMcpReview, sequence: number): HcpHarnessEventPayload {
  const outcome = review.outcome;
  assert.ok(outcome.phase === "input_waiting" || outcome.phase === "input_resuming");
  return {session_id: "session", turn_id: "turn", sequence, created_at: "2026-09-19T00:01:00Z",
    event_type: outcome.phase === "input_waiting" ? "input.requested" : "input.resolved",
    data: {request_id: outcome.input_request_id, session_id: "session", turn_id: "turn",
      ...(outcome.phase === "input_waiting" ? {prompt: "Continue?", input_kind: "form", required: true, redaction: "none"}
        : {actor_id: outcome.actor_id, resolved_at: "2026-09-19T00:01:00Z"})}};
}

for (const reviewed of [false, true]) {
  for (const decision of ["accept", "decline"] as const) {
    test(`delegated ${decision} survives storage restart without replacing the parent (reviewed=${reviewed})`, async () => {
      const directory = await mkdtemp(join(tmpdir(), "hcp-child-review-"));
      const path = join(directory, "state.json");
      try {
        const {review, event} = pending();
        const store = new JsonRunnerStateStore(path);
        let sequence = 1;
        if (reviewed) {
          store.saveMcpReview(review, event);
          store.saveMcpReview({...review, outcome: {phase: "dispatching", actor_id: "actor"}}, decisionEvent(review, "accept"));
          sequence = 3;
        }
        const subject = {operation_id: "child", tool_name: "update", arguments: {id: "record"}, binding: "server-binding"};
        const action = JSON.stringify({...JSON.parse(review.action_json), delegated_subject: subject});
        const hash = createHash("sha256").update(action).digest("hex");
        const pendingInput = parseMcpPendingInput({requestState: "retained-worker", inputRequests: {child: {
          method: "elicitation/create", params: {message: "Approve child?", requestedSchema: {type: "object", properties: {
            request_id: {type: "string"}, action_json: {type: "string"},
          }, required: ["request_id", "action_json"]}},
        }}, _meta: {[MCP_REVIEW_META_KEY]: {kind: "delegated", input_request_id: "child", subject}}});
        const outcome = {phase: "review_waiting" as const, input_request_id: "child-review", protocol_round: 1,
          action_json: action, action_hash: hash, pending: pendingInput, ...(reviewed ? {review_actor_id: "actor"} : {})};
        const waiting: PersistedMcpReview = {...review, outcome};
        const requested: HcpHarnessEventPayload = {...event, sequence: sequence++, data: {...event.data,
          request_id: outcome.input_request_id, action, action_hash: hash}};
        assert.throws(() => store.saveMcpReview({...waiting, outcome: {...outcome, action_hash: "0".repeat(64)}}, requested), /pending subject/);
        const altered = JSON.stringify({...JSON.parse(action), tool_name: "other-parent"});
        assert.throws(() => store.saveMcpReview({...waiting, outcome: {...outcome, action_json: altered,
          action_hash: createHash("sha256").update(altered).digest("hex")}}, requested), /parent operation/);
        store.saveMcpReview(waiting, requested);
        const restarted = new JsonRunnerStateStore(path);
        assert.deepEqual(restarted.getMcpReview("session"), waiting);
        const {pending: _, ...round} = outcome;
        const resuming: PersistedMcpReview = {...review, outcome: {...round, phase: "review_resuming", actor_id: "child-reviewer", decision,
          reply: {pending: pendingInput, responses: {child: {action: decision,
            ...(decision === "accept" ? {content: {request_id: "child-review", action_json: action}} : {})}}}}};
        const resolved: HcpHarnessEventPayload = {...decisionEvent(review, decision), sequence: sequence++, data: {
          session_id: "session", turn_id: "turn", request_id: "child-review", action_hash: hash,
          actor_id: "child-reviewer", decision, resolved_at: "2026-09-19T00:01:00Z",
        }};
        assert.ok(resuming.outcome.phase === "review_resuming");
        const resumingOutcome = resuming.outcome;
        assert.throws(() => restarted.saveMcpReview({...resuming, outcome: {...resumingOutcome,
          reply: {pending: pendingInput, responses: {child: {action: "accept", content: {
            request_id: review.request_id, action_json: review.action_json,
          }}}}}}, resolved), /recorded decision/);
        restarted.saveMcpReview(resuming, resolved);
        const resumed = new JsonRunnerStateStore(path);
        assert.deepEqual(resumed.getMcpReview("session"), resuming);
        assert.throws(() => resumed.saveMcpReview(waiting, requested), /replay/);
        const terminal: PersistedMcpReview = {...review, outcome: {phase: "completed", actor_id: "child-reviewer", result_json: "{}"}};
        resumed.saveMcpReview(terminal);
        assert.deepEqual(new JsonRunnerStateStore(path).getMcpReview("session"), terminal);
      } finally {await rm(directory, {recursive: true, force: true});}
    });
  }
}

for (const reviewed of [false, true]) {
  test(`MCP input rounds persist under the original operation (reviewed=${reviewed})`, async () => {
    const root = await mkdtemp(join(tmpdir(), "hcp-input-"));
    const path = join(root, "state.json");
    try {
      const {review, event} = pending();
      const store = new JsonRunnerStateStore(path);
      let sequence = 1;
      if (reviewed) {
        store.saveMcpReview(review, event);
        store.saveMcpReview({...review, outcome: {phase: "dispatching", actor_id: "reviewer"}},
          {...decisionEvent(review, "accept"), data: {...decisionEvent(review, "accept").data, actor_id: "reviewer"}});
        sequence = 3;
      }
      const pendingInput = parseMcpPendingInput({requestState: "opaque", inputRequests: {q: {
        method: "elicitation/create", params: {message: "Continue?", requestedSchema: {type: "object", properties: {}}},
      }}});
      const input: PersistedMcpReview = {...review, outcome: {phase: "input_waiting", input_request_id: "input-1",
        protocol_round: 1, pending: pendingInput, ...(reviewed ? {review_actor_id: "reviewer"} : {})}};
      assert.throws(() => store.saveMcpReview(input), /waiting event|transition/);
      store.saveMcpReview(input, inputEvent(input, sequence++));
      const restarted = new JsonRunnerStateStore(path);
      assert.deepEqual(restarted.getMcpReview("session"), input);
      assert.equal(JSON.stringify(restarted.replayEventsAfter("session", 0)).includes("opaque"), false);
      const resuming: PersistedMcpReview = {...input, outcome: {phase: "input_resuming", input_request_id: "input-1",
        protocol_round: 1, reply: {pending: pendingInput, responses: {q: {action: "cancel"}}}, actor_id: "responder",
        ...(reviewed ? {review_actor_id: "reviewer"} : {})}};
      assert.throws(() => restarted.saveMcpReview(resuming), /transition/);
      const resolvedEvent = inputEvent(resuming, sequence++);
      assert.throws(() => restarted.saveMcpReview(resuming, {...resolvedEvent, data: {...resolvedEvent.data, actor_id: "other"}}), /decision differs/);
      restarted.saveMcpReview(resuming, resolvedEvent);
      assert.throws(() => restarted.saveMcpReview(input, inputEvent(input, sequence)), /transition/);
      assert.throws(() => restarted.saveMcpReview(resuming, resolvedEvent), /transition/);
      const second: PersistedMcpReview = {...input, outcome: {...input.outcome, phase: "input_waiting", pending: pendingInput,
        input_request_id: "input-2", protocol_round: 2}};
      restarted.saveMcpReview(second, inputEvent(second, sequence++));
      const resumedAgain: PersistedMcpReview = {...resuming, outcome: {...resuming.outcome, phase: "input_resuming",
        reply: {pending: pendingInput, responses: {q: {action: "decline"}}}, actor_id: "responder",
        input_request_id: "input-2", protocol_round: 2}};
      restarted.saveMcpReview(resumedAgain, inputEvent(resumedAgain, sequence++));
      const terminal: PersistedMcpReview = {...review, outcome: {phase: "completed", actor_id: "responder", result_json: '{"is_error":false}'}};
      restarted.saveMcpReview(terminal);
      assert.deepEqual(new JsonRunnerStateStore(path).getMcpReview("session"), terminal);
      assert.throws(() => restarted.saveMcpReview(second, inputEvent(second, sequence)), /transition/);
    } finally {await rm(root, {recursive: true, force: true});}
  });
}
