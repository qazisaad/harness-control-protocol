import { MCP_REVIEW_META_KEY, mcpDelegatedReviewRequestSchema, mcpReviewActionBytes } from "@harness-control/protocol";
import { createHash, randomUUID } from "node:crypto";
import type { HcpHarnessEventPayload, HcpSessionStartPayload, HcpTurnSendPayload, HcpApprovalResponsePayload, HcpInputResponsePayload } from "@harness-control/protocol";
import type { RunnerStateStore } from "../state/index.js";
import type { PersistedMcpReview } from "../state/mcp-review.js";
import type { McpReviewGrant, McpToolCallResult } from "../mcp/McpAttachmentClient.js";
import { HarnessAdapterError, type HarnessMcpReviewer, type HarnessMcpReviewRequest, type HarnessMcpToolset } from "./adapters/types.js";
import { McpInputRequiredError, mcpInputExpiresAt, mcpInputReplySchema, mcpInputResponseParams, type McpInputReply } from "../mcp/input-required.js";

function operationExpiresAt(record: PersistedMcpReview): string {
  const outcome = record.outcome;
  if (outcome.phase === "input_waiting" || outcome.phase === "review_waiting") return mcpInputExpiresAt(outcome.pending, record.expires_at);
  if (outcome.phase === "input_resuming" || outcome.phase === "review_resuming") return mcpInputExpiresAt(outcome.reply.pending, record.expires_at);
  return record.expires_at;
}

/** Owns platform review within the existing durable runner session. */
export class HarnessMcpReview implements HarnessMcpReviewer {
  #waiting: {requestId: string; resolve: (grant: McpReviewGrant | null) => void} | undefined;
  #inputWaiting: {requestId: string; resolve: (reply: McpInputReply) => void} | undefined;
  readonly #interruption = new AbortController();

  constructor(private readonly store: RunnerStateStore, private readonly start: HcpSessionStartPayload,
    private readonly turn: HcpTurnSendPayload, private readonly publish: (event: HcpHarnessEventPayload) => void) {}

  async request(request: HarnessMcpReviewRequest, signal: AbortSignal): Promise<McpReviewGrant | null> {
    signal.throwIfAborted();
    const review = this.#newOperation(request, {phase: "waiting"});
    const expiry = Date.parse(review.expires_at);
    const event = this.#event("approval.requested", {request_id: review.request_id, session_id: this.start.session_id,
      turn_id: this.turn.turn_id, workspace_id: this.start.workspace_id, provider_instance_id: this.start.provider_instance_id,
      driver_kind: this.start.driver_kind, request_type: "mcp_tool", risk_class: "medium", action: review.action_json, action_hash: review.action_hash,
      allowed_decisions: ["accept", "decline"], expires_at: review.expires_at, display: {title: `Run ${request.tool_name}`}});
    this.store.saveMcpReview(review, event);
    return new Promise<McpReviewGrant | null>((resolve, reject) => {
      const finish = (grant: McpReviewGrant | null): void => {cleanup(); resolve(grant);};
      const abort = (): void => {cleanup(); reject(new HarnessAdapterError("mcp_review_interrupted", "MCP review was interrupted."));};
      const timer = setTimeout(abort, Math.max(0, expiry - Date.now()));
      const cleanup = (): void => {
        clearTimeout(timer); signal.removeEventListener("abort", abort);
        this.#waiting = undefined;
      };
      this.#waiting = {requestId: review.request_id, resolve: finish};
      signal.addEventListener("abort", abort, {once: true});
      if (signal.aborted) {abort(); return;}
      try {this.publish(event);} catch (error: unknown) {cleanup(); reject(error);}
    });
  }

  #newOperation(request: HarnessMcpReviewRequest, outcome: PersistedMcpReview["outcome"]): PersistedMcpReview {
    const attachment = this.start.mcp_servers.find(item => item.name === request.attachment_name);
    if (!attachment || attachment.transport !== "streamable_http" || !attachment.expires_at || !attachment.lease_id) {
      throw new HarnessAdapterError("mcp_review_attachment_invalid", "Platform review requires a leased HTTP attachment.");
    }
    const expiry = Date.parse(attachment.expires_at);
    if (expiry <= Date.now()) throw new HarnessAdapterError("mcp_review_expired", "The MCP attachment expired before review.");
    const previous = this.store.getMcpReview(this.start.session_id);
    if (previous) {
      if (!["completed", "declined"].includes(previous.outcome.phase)) {
        throw new HarnessAdapterError("mcp_review_pending", "The previous MCP operation has not resolved.");
      }
      this.store.clearMcpReview(this.start.session_id, previous.request_id);
    }
    const action = JSON.stringify({kind: "mcp_tool", attachment_name: request.attachment_name,
      tool_name: request.tool_name, arguments: request.arguments});
    const actionBytes = mcpReviewActionBytes(action);
    return {start: this.start, turn: this.turn,
      native_thread_id: request.native_thread_id, native_turn_id: request.native_turn_id, native_call_id: request.native_call_id,
      request_id: randomUUID(), action_json: action, action_hash: createHash("sha256").update(actionBytes).digest("hex"),
      expires_at: new Date(Math.min(expiry, Date.now() + 300000)).toISOString(), outcome};
  }

  validateDecision(response: HcpApprovalResponsePayload): void {this.#decision(response);}

  #decision(response: HcpApprovalResponsePayload): PersistedMcpReview {
    const review = this.store.getMcpReview(this.start.session_id);
    if (review?.outcome.phase === "review_waiting" || review?.outcome.phase === "review_resuming") {
      const outcome = review.outcome;
      if (response.session_id !== this.start.session_id || response.turn_id !== this.turn.turn_id ||
          response.request_id !== outcome.input_request_id || response.action_hash !== outcome.action_hash ||
          !["accept", "decline"].includes(response.decision) || Date.parse(operationExpiresAt(review)) <= Date.now()) {
        throw new HarnessAdapterError("mcp_review_binding_invalid", "Approval does not match the active child request.");
      }
      if (outcome.phase === "review_resuming" && (response.decision !== outcome.decision || response.actor_id !== outcome.actor_id)) {
        throw new HarnessAdapterError("mcp_review_decision_conflict", "The child request already has another decision.");
      }
      return review;
    }
    if (!review || response.session_id !== this.start.session_id || response.turn_id !== this.turn.turn_id ||
        response.request_id !== review.request_id || response.action_hash !== review.action_hash ||
        !["accept", "decline"].includes(response.decision) || Date.parse(review.expires_at) <= Date.now()) {
      throw new HarnessAdapterError("mcp_review_binding_invalid", "Approval does not match the active MCP request.");
    }
    const phase = response.decision === "accept" ? "dispatching" : "declined";
    if (review.outcome.phase !== "waiting") {
      if ((review.outcome.phase === phase || (review.outcome.phase === "completed" && phase === "dispatching")) &&
          review.outcome.actor_id === response.actor_id) return review;
      throw new HarnessAdapterError("mcp_review_decision_conflict", "The MCP request already has another decision.");
    }
    return review;
  }

  decide(response: HcpApprovalResponsePayload): PersistedMcpReview {
    const review = this.#decision(response);
    if (review.outcome.phase === "review_waiting") return this.#decideDelegated(review, response);
    if (review.outcome.phase !== "waiting") return review;
    const phase = response.decision === "accept" ? "dispatching" : "declined";
    const updated: PersistedMcpReview = {...review, outcome: {phase, actor_id: response.actor_id}};
    const event = this.#event("approval.resolved", {...response, resolved_at: new Date().toISOString()});
    this.store.saveMcpReview(updated, event);
    try {
      this.publish(event);
    } finally {
      if (this.#waiting?.requestId === review.request_id) {
        this.#waiting.resolve(phase === "dispatching" ? {request_id: review.request_id, action_json: review.action_json} : null);
      }
    }
    return updated;
  }

  #decideDelegated(review: PersistedMcpReview, response: HcpApprovalResponsePayload): PersistedMcpReview {
    const outcome = review.outcome;
    if (outcome.phase !== "review_waiting" || (response.decision !== "accept" && response.decision !== "decline")) {
      throw new HarnessAdapterError("mcp_review_binding_invalid", "No matching child review is waiting.");
    }
    const delegated = mcpDelegatedReviewRequestSchema.parse(outcome.pending._meta?.[MCP_REVIEW_META_KEY]);
    const reply = mcpInputReplySchema.parse({pending: outcome.pending, responses: {
      [delegated.input_request_id]: {action: response.decision,
        ...(response.decision === "accept" ? {content: {request_id: outcome.input_request_id, action_json: outcome.action_json}} : {})},
    }});
    const {pending: _, ...binding} = outcome;
    const updated: PersistedMcpReview = {...review, outcome: {...binding, phase: "review_resuming",
      reply, actor_id: response.actor_id, decision: response.decision}};
    const event = this.#event("approval.resolved", {...response, resolved_at: new Date().toISOString()});
    this.store.saveMcpReview(updated, event);
    try {this.publish(event);} finally {
      if (this.#inputWaiting?.requestId === outcome.input_request_id) this.#inputWaiting.resolve(reply);
    }
    return updated;
  }

  async complete(grant: McpReviewGrant, result: McpToolCallResult): Promise<void> {
    const review = this.store.getMcpReview(this.start.session_id);
    if (!review || review.request_id !== grant.request_id || review.action_json !== grant.action_json || review.outcome.phase !== "dispatching") {
      throw new HarnessAdapterError("mcp_review_result_mismatch", "Tool result has another reviewed operation binding.");
    }
    this.store.saveMcpReview({...review, outcome: {phase: "completed", actor_id: review.outcome.actor_id, result_json: JSON.stringify(result)}});
  }

  async invoke(request: HarnessMcpReviewRequest, callTool: HarnessMcpToolset["callTool"], signal: AbortSignal,
    grant?: McpReviewGrant, continuation?: McpInputReply): Promise<McpToolCallResult> {
    signal = AbortSignal.any([signal, this.#interruption.signal]);
    let reply = continuation;
    for (;;) {
      signal.throwIfAborted();
      const retained = this.store.getMcpReview(this.start.session_id);
      if (!reply && !grant && retained?.native_call_id === request.native_call_id && retained.native_turn_id === request.native_turn_id) {
        throw new HarnessAdapterError("mcp_input_replay_denied", "The MCP operation already has retained state.");
      }
      if (reply || grant) {
        if (!retained || retained.native_call_id !== request.native_call_id || retained.native_thread_id !== request.native_thread_id ||
            retained.native_turn_id !== request.native_turn_id || Date.parse(operationExpiresAt(retained)) <= Date.now() ||
            retained.action_json !== JSON.stringify({kind: "mcp_tool", attachment_name: request.attachment_name,
              tool_name: request.tool_name, arguments: request.arguments}) ||
            (grant && (retained.request_id !== grant.request_id || retained.action_json !== grant.action_json)) ||
            (!reply && retained.outcome.phase !== "dispatching") ||
            (reply && (retained.outcome.phase === "input_resuming" || retained.outcome.phase === "review_resuming") && Boolean(retained.outcome.review_actor_id) !== Boolean(grant)) ||
            (reply && ((retained.outcome.phase !== "input_resuming" && retained.outcome.phase !== "review_resuming") || JSON.stringify(retained.outcome.reply) !== JSON.stringify(reply)))) {
          throw new HarnessAdapterError("mcp_input_binding_invalid", "Input continuation does not match the original MCP operation.");
        }
      }
      let result: McpToolCallResult;
      try {result = await callTool(request.tool_name, request.arguments, grant, reply);}
      catch (error: unknown) {
        if (!(error instanceof McpInputRequiredError)) throw error;
        reply = await this.#waitForInput(request, error, signal);
        continue;
      }
      if (retained && (reply || grant)) {
        if (retained.outcome.phase !== "dispatching" && retained.outcome.phase !== "input_resuming" && retained.outcome.phase !== "review_resuming") {
          throw new HarnessAdapterError("mcp_input_phase_invalid", "MCP operation is not dispatching.");
        }
        this.store.saveMcpReview({...retained, outcome: {phase: "completed", actor_id: retained.outcome.actor_id,
          result_json: JSON.stringify(result)}});
      }
      return result;
    }
  }

  async #waitForInput(request: HarnessMcpReviewRequest, error: McpInputRequiredError, signal: AbortSignal): Promise<McpInputReply> {
    const hint = error.pending._meta?.[MCP_REVIEW_META_KEY];
    const delegated = hint === undefined ? undefined : mcpDelegatedReviewRequestSchema.parse(hint);
    const properties: Record<string, unknown> = Object.fromEntries(Object.entries(error.pending.inputRequests ?? {}).map(([key, input]) => {
      if (input.method !== "elicitation/create") {
        throw new HarnessAdapterError("mcp_input_capability_unavailable", "This runner does not yet support the requested MCP input capability.");
      }
      const form = "requestedSchema" in input.params;
      return [key, {title: input.params.message,
        ...(!form && "url" in input.params ? {description: `Open ${input.params.url}, complete the requested action, then confirm.`} : {}), oneOf: [
        {title: form ? "Provide input" : "I have completed this step", type: "object", properties: {
          action: {type: "string", const: "accept", default: "accept"},
          ...("requestedSchema" in input.params ? {content: input.params.requestedSchema} : {}),
        }, required: form ? ["action", "content"] : ["action"], additionalProperties: false},
        ...["decline", "cancel"].map(action => ({title: action === "decline" ? "Decline" : "Cancel", type: "object",
          properties: {action: {type: "string", const: action, default: action}}, required: ["action"], additionalProperties: false})),
      ]}];
    }));
    const previous = this.store.getMcpReview(this.start.session_id);
    const sameCall = previous?.native_call_id === request.native_call_id && previous.native_turn_id === request.native_turn_id;
    const priorOutcome = sameCall ? previous.outcome : undefined;
    const reviewActor = priorOutcome?.phase === "dispatching" ? priorOutcome.actor_id
      : priorOutcome?.phase === "input_resuming" || priorOutcome?.phase === "review_resuming" ? priorOutcome.review_actor_id : undefined;
    const round = priorOutcome?.phase === "input_resuming" || priorOutcome?.phase === "review_resuming" ? priorOutcome.protocol_round + 1 : 1;
    let outcome: Extract<PersistedMcpReview["outcome"], {phase: "input_waiting" | "review_waiting"}> = {phase: "input_waiting", input_request_id: randomUUID(), protocol_round: round,
      pending: error.pending, ...(reviewActor === undefined ? {} : {review_actor_id: reviewActor})};
    if (delegated) {
      if (Object.keys(error.pending.inputRequests ?? {}).length !== 1 || !Object.hasOwn(error.pending.inputRequests ?? {}, delegated.input_request_id)) {
        throw new HarnessAdapterError("mcp_review_binding_invalid", "Child approval must identify its sole pending input.");
      }
      const action = JSON.stringify({kind: "mcp_tool", attachment_name: request.attachment_name,
        tool_name: request.tool_name, arguments: request.arguments, delegated_subject: delegated.subject});
      const actionHash = createHash("sha256").update(mcpReviewActionBytes(action)).digest("hex");
      mcpInputResponseParams({pending: error.pending, responses: {[delegated.input_request_id]: {
        action: "accept", content: {request_id: outcome.input_request_id, action_json: action},
      }}});
      outcome = {...outcome, phase: "review_waiting", action_json: action, action_hash: actionHash};
    }
    const record = sameCall ? {...previous, outcome} : this.#newOperation(request, outcome);
    const expiresAt = operationExpiresAt(record);
    const event = outcome.phase === "review_waiting" ? this.#event("approval.requested", {
      request_id: outcome.input_request_id, session_id: this.start.session_id, turn_id: this.turn.turn_id,
      workspace_id: this.start.workspace_id, provider_instance_id: this.start.provider_instance_id, driver_kind: this.start.driver_kind,
      request_type: "mcp_tool", risk_class: "medium", action: outcome.action_json, action_hash: outcome.action_hash,
      allowed_decisions: ["accept", "decline"], expires_at: expiresAt, display: {title: `Run ${delegated!.subject.tool_name}`},
    }) : this.#event("input.requested", {request_id: outcome.input_request_id, session_id: this.start.session_id,
      turn_id: this.turn.turn_id, prompt: `Provide input for ${request.tool_name}`, input_kind: "form", required: true,
      redaction: "none", expires_at: expiresAt,
      form_schema: {type: "object", properties, required: Object.keys(properties), additionalProperties: false}});
    this.store.saveMcpReview(record, event);
    return new Promise<McpInputReply>((resolve, reject) => {
      const cleanup = (): void => {clearTimeout(timer); signal.removeEventListener("abort", abort); this.#inputWaiting = undefined;};
      const abort = (): void => {cleanup(); reject(new HarnessAdapterError("mcp_input_interrupted", "MCP input was interrupted or expired."));};
      const timer = setTimeout(abort, Math.max(0, Date.parse(expiresAt) - Date.now()));
      this.#inputWaiting = {requestId: outcome.input_request_id, resolve: value => {cleanup(); resolve(value);}};
      signal.addEventListener("abort", abort, {once: true});
      if (signal.aborted) {abort(); return;}
      try {this.publish(event);} catch (publishError: unknown) {cleanup(); reject(publishError);}
    });
  }

  validateInputResponse(response: HcpInputResponsePayload): void {this.#inputReply(response);}

  #inputReply(response: HcpInputResponsePayload): {
    record: PersistedMcpReview;
    outcome: Extract<PersistedMcpReview["outcome"], {phase: "input_waiting" | "input_resuming"}>;
    reply: McpInputReply;
  } {
    const record = this.store.getMcpReview(this.start.session_id);
    if (!record || response.session_id !== this.start.session_id || response.turn_id !== this.turn.turn_id ||
        Date.parse(operationExpiresAt(record)) <= Date.now() ||
        (record.outcome.phase !== "input_waiting" && record.outcome.phase !== "input_resuming") ||
        record.outcome.input_request_id !== response.request_id) {
      throw new HarnessAdapterError("mcp_input_binding_invalid", "Input does not match the active MCP request.");
    }
    const outcome = record.outcome;
    const pending = outcome.phase === "input_waiting" ? outcome.pending : outcome.reply.pending;
    if (response.cancelled && response.value !== undefined) throw new HarnessAdapterError("mcp_input_invalid", "Cancelled input cannot include values.");
    const responses = response.cancelled ? Object.fromEntries(Object.keys(pending.inputRequests ?? {}).map(key => [key, {action: "cancel"}])) : response.value;
    const reply = mcpInputReplySchema.parse({pending, responses});
    return {record, outcome, reply};
  }

  respondToInput(response: HcpInputResponsePayload): PersistedMcpReview {
    const {record, outcome, reply} = this.#inputReply(response);
    if (outcome.phase === "input_resuming") {
      if (outcome.actor_id === response.actor_id && JSON.stringify(outcome.reply) === JSON.stringify(reply)) return record;
      throw new HarnessAdapterError("mcp_input_conflict", "The MCP input already has another response.");
    }
    const updated: PersistedMcpReview = {...record, outcome: {phase: "input_resuming", input_request_id: outcome.input_request_id,
      protocol_round: outcome.protocol_round, reply, actor_id: response.actor_id,
      ...(outcome.review_actor_id === undefined ? {} : {review_actor_id: outcome.review_actor_id})}};
    const event = this.#event("input.resolved", {request_id: response.request_id, session_id: response.session_id,
      turn_id: response.turn_id, actor_id: response.actor_id, cancelled: response.cancelled ?? false, resolved_at: new Date().toISOString()});
    this.store.saveMcpReview(updated, event);
    try {this.publish(event);} finally {
      if (this.#inputWaiting?.requestId === response.request_id) this.#inputWaiting.resolve(reply);
    }
    return updated;
  }


  interrupt(): void {this.#interruption.abort();}

  #event(type: "approval.requested" | "approval.resolved" | "input.requested" | "input.resolved", data: Record<string, unknown>): HcpHarnessEventPayload {
    return {session_id: this.start.session_id, turn_id: this.turn.turn_id,
      sequence: this.store.nextEventSequence(this.start.session_id), event_type: type, created_at: new Date().toISOString(), data};
  }
}
