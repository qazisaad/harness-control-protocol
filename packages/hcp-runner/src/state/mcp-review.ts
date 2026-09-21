import { mcpReviewActionBytes, MCP_REVIEW_MAX_ACTION_BYTES, MCP_REVIEW_MAX_REQUEST_ID_LENGTH } from "@harness-control/protocol";
import { hcpSessionStartPayloadSchema, hcpTurnSendPayloadSchema, type HcpSessionStartPayload, type HcpTurnSendPayload, type HcpHarnessEventPayload } from "@harness-control/protocol";
import { z } from "zod";
import { mcpInputReplySchema, mcpPendingInputSchema } from "../mcp/input-required.js";

const inputRound = {
  input_request_id: z.string().min(1).max(MCP_REVIEW_MAX_REQUEST_ID_LENGTH),
  protocol_round: z.number().int().min(1).max(9),
  review_actor_id: z.string().min(1).optional(),
};

export const persistedMcpReviewSchema = z.object({
  start: hcpSessionStartPayloadSchema,
  turn: hcpTurnSendPayloadSchema,
  native_thread_id: z.string().min(1),
  native_turn_id: z.string().min(1),
  native_call_id: z.string().min(1),
  request_id: z.string().min(1).max(MCP_REVIEW_MAX_REQUEST_ID_LENGTH),
  action_json: z.string().min(1).max(MCP_REVIEW_MAX_ACTION_BYTES).superRefine((value, ctx) => {
    try {mcpReviewActionBytes(value);} catch {ctx.addIssue({code: "custom", message: "Invalid or oversized MCP review action."});}
  }),
  action_hash: z.string().regex(/^[a-f0-9]{64}$/),
  expires_at: z.string().datetime({offset: true}),
  outcome: z.discriminatedUnion("phase", [
    z.object({phase: z.literal("waiting")}).strict(),
    z.object({phase: z.literal("dispatching"), actor_id: z.string().min(1)}).strict(),
    z.object({phase: z.literal("declined"), actor_id: z.string().min(1)}).strict(),
    z.object({phase: z.literal("input_waiting"), ...inputRound, pending: mcpPendingInputSchema}).strict(),
    z.object({phase: z.literal("input_resuming"), ...inputRound, reply: mcpInputReplySchema, actor_id: z.string().min(1)}).strict(),
    z.object({phase: z.literal("completed"), actor_id: z.string().min(1), result_json: z.string().refine(value => Buffer.byteLength(value, "utf8") <= 1024 * 1024, "Review result exceeds 1 MiB.")}).strict(),
  ]),
}).strict().refine(value => value.start.session_id === value.turn.session_id,
  "MCP continuation requires matching session and turn identities.")
  .transform(value => ({...value, start: value.start as HcpSessionStartPayload, turn: value.turn as HcpTurnSendPayload}));

export type PersistedMcpReview = z.infer<typeof persistedMcpReviewSchema>;

/** One operation owns approval, protocol input rounds and terminal delivery. */
export function validateMcpTransition(previous: PersistedMcpReview | undefined, next: PersistedMcpReview,
  event?: HcpHarnessEventPayload): void {
  const outcome = next.outcome;
  const old = previous?.outcome;
  if (!previous) {
    const initial = outcome.phase === "waiting" || (outcome.phase === "input_waiting" &&
      outcome.protocol_round === 1 && outcome.review_actor_id === undefined);
    if (!initial || !event) throw new Error("A new MCP continuation requires its waiting event.");
  } else {
    const {outcome: _, ...binding} = previous;
    const {outcome: __, ...nextBinding} = next;
    if (JSON.stringify(binding) !== JSON.stringify(nextBinding)) throw new Error("MCP continuation transition changed its binding.");
    if (JSON.stringify(old) === JSON.stringify(outcome) && !event) return;
    let advances = false;
    if (old?.phase === "waiting") {
      advances = (outcome.phase === "dispatching" || outcome.phase === "declined") && event !== undefined;
    } else if (old?.phase === "dispatching") {
      advances = (outcome.phase === "completed" && outcome.actor_id === old.actor_id && !event) ||
        (outcome.phase === "input_waiting" && outcome.protocol_round === 1 && outcome.review_actor_id === old.actor_id && event !== undefined);
    } else if (old?.phase === "input_waiting" && outcome.phase === "input_resuming") {
      advances = outcome.input_request_id === old.input_request_id && outcome.protocol_round === old.protocol_round &&
        outcome.review_actor_id === old.review_actor_id && JSON.stringify(outcome.reply.pending) === JSON.stringify(old.pending) && event !== undefined;
    } else if (old?.phase === "input_resuming") {
      advances = (outcome.phase === "completed" && outcome.actor_id === old.actor_id && !event) ||
        (outcome.phase === "input_waiting" && outcome.protocol_round === old.protocol_round + 1 &&
          outcome.input_request_id !== old.input_request_id && outcome.review_actor_id === old.review_actor_id && event !== undefined);
    }
    if (!advances) throw new Error("MCP continuation transition would change or replay its operation.");
  }
  if (!event) return;
  const input = outcome.phase === "input_waiting" || outcome.phase === "input_resuming";
  const requested = outcome.phase === "waiting" || outcome.phase === "input_waiting";
  const expectedType = input ? (requested ? "input.requested" : "input.resolved")
    : (requested ? "approval.requested" : "approval.resolved");
  const requestId = input ? outcome.input_request_id : next.request_id;
  if (event.session_id !== next.start.session_id || event.turn_id !== next.turn.turn_id ||
      event.event_type !== expectedType || !("request_id" in event.data) || event.data.request_id !== requestId ||
      !("session_id" in event.data) || event.data.session_id !== next.start.session_id ||
      !("turn_id" in event.data) || event.data.turn_id !== next.turn.turn_id) {
    throw new Error("MCP event differs from its private continuation.");
  }
  if (input) {
    if (outcome.phase === "input_resuming" && (!("actor_id" in event.data) || event.data.actor_id !== outcome.actor_id)) {
      throw new Error("MCP input decision differs from its private continuation.");
    }
    return;
  }
  if (!("action_hash" in event.data) || event.data.action_hash !== next.action_hash ||
      (requested && (!("action" in event.data) || event.data.action !== next.action_json))) {
    throw new Error("MCP review event differs from its private continuation.");
  }
  if (outcome.phase !== "waiting" && (!("actor_id" in event.data) || event.data.actor_id !== outcome.actor_id ||
      !("decision" in event.data) || event.data.decision !== (outcome.phase === "declined" ? "decline" : "accept"))) {
    throw new Error("MCP review decision differs from its private continuation.");
  }
}
