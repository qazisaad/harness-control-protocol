import {realpath} from "node:fs/promises";
import {z} from "zod";
import type {HarnessNativeGoalOperation, HarnessNativeGoalResult, HarnessNativeGoalObservation} from "@harness-control/protocol";
import {HarnessAdapterError} from "../types.js";
import type {CodexRpc} from "./codex-rpc.js";
import {readCodexGoal, type CodexGoal, type CodexGoalOwner} from "./codex-goal.js";

export function projectCodexGoal(goal: CodexGoal): HarnessNativeGoalObservation {
  return {source: "native", scope: "root", native_reference: goal.threadId, objective: goal.objective,
    native_created_at: goal.createdAt, native_updated_at: goal.updatedAt,
    status: ({active: "active", paused: "paused", blocked: "blocked", usageLimited: "usage_limited", budgetLimited: "budget_limited", complete: "complete"} as const)[goal.status],
    tokens_used: goal.tokensUsed, time_used_seconds: goal.timeUsedSeconds,
    ...(goal.tokenBudget != null ? {token_budget: goal.tokenBudget} : {})};
}

/** Caller owns the original transport or lends a read-only inspector; mutation requires its durable fence. */
export async function controlCodexGoal(input: {rpc: Pick<CodexRpc, "request">; threadId: string; cwd: string;
  operation: HarnessNativeGoalOperation; goalMutationOrigins?: boolean | undefined; signal: AbortSignal; beginMutation?: () => void; owner?: CodexGoalOwner}): Promise<HarnessNativeGoalResult> {
  const {rpc, threadId, operation, signal} = input;
  const userOrigin = input.goalMutationOrigins ? {origin: "user" as const} : {};
  const verifyWorkspace = async () => {
    const native = z.object({thread: z.object({id: z.string(), cwd: z.string()})}).parse(
      await rpc.request("thread/read", {threadId, includeTurns: false}, {signal})).thread;
    if (native.id !== threadId || await realpath(native.cwd) !== await realpath(input.cwd))
      throw new HarnessAdapterError("native_goal_binding", "Native goal controls require the original conversation and canonical workspace.");
  };
  await verifyWorkspace();
  const prior = await readCodexGoal(rpc, threadId, signal);
  if (operation.action === "read") {
    await verifyWorkspace();
    return {source: "native", native_reference: threadId, action: "read", goal: prior && projectCodexGoal(prior)};
  }
  if (!prior || prior.createdAt !== operation.expected_native_created_at)
    throw new HarnessAdapterError("native_goal_changed", "Read the current native goal generation before mutating it.");
  if (!input.beginMutation)
    throw new HarnessAdapterError("native_goal_owner_unavailable", "Native goal mutations require a live owner and a durable command fence.");
  if (input.owner && input.owner.goal?.createdAt !== prior.createdAt)
    throw new HarnessAdapterError("native_goal_owner_unavailable", "The active native goal has no confirmed matching execution admission.");
  signal.throwIfAborted(); input.beginMutation();
  if (operation.action === "pause") {
    if (input.owner) await input.owner.pause(true, "user");
    else await rpc.request("thread/goal/set", {threadId, status: "paused", ...userOrigin}, {signal});
    const actual = await readCodexGoal(rpc, threadId, signal);
    if (!actual || actual.createdAt !== prior.createdAt || actual.objective !== prior.objective || actual.tokenBudget !== prior.tokenBudget
      || actual.status !== "paused" || actual.updatedAt < prior.updatedAt || actual.tokensUsed < prior.tokensUsed || actual.timeUsedSeconds < prior.timeUsedSeconds)
      throw new HarnessAdapterError("native_goal_mismatch", "Codex did not confirm the exact native paused goal.");
    await verifyWorkspace();
    return {source: "native", native_reference: threadId, action: "pause", target_native_created_at: prior.createdAt,
      goal: {...projectCodexGoal(actual), status: "paused"}};
  }
  if (input.owner) await input.owner.clear(signal);
  else {
    await rpc.request("thread/goal/clear", {threadId, ...userOrigin}, {signal});
    if (await readCodexGoal(rpc, threadId, signal))
      throw new HarnessAdapterError("native_goal_mismatch", "Codex did not confirm removal of the exact native goal.");
  }
  await verifyWorkspace();
  return {source: "native", native_reference: threadId, action: "clear", target_native_created_at: prior.createdAt, goal: null};
}
