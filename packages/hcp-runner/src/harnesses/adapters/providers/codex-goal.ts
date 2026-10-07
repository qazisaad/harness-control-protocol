import {z} from "zod";
import {HarnessAdapterError} from "../types.js";
import type {CodexRpc, RpcMessage} from "./codex-rpc.js";

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const codexGoalSchema = z.object({threadId: z.string().min(1).max(512),
  objective: z.string().min(1).max(128 * 1024),
  status: z.enum(["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"]),
  createdAt: integer, updatedAt: integer, timeUsedSeconds: integer, tokensUsed: integer,
  tokenBudget: integer.positive().nullable().optional()});
export type CodexGoal = z.infer<typeof codexGoalSchema>;
type Rpc = Pick<CodexRpc, "request">;
const response = z.object({goal: codexGoalSchema});
const failure = () => new HarnessAdapterError("native_goal_mismatch", "Codex did not confirm the admitted native goal and its original execution owner.");
/** Read-only storage lookup works before thread/resume and does not acquire an execution owner. */
export async function readCodexGoal(rpc: Rpc, threadId: string, signal: AbortSignal): Promise<CodexGoal | null> {
  const goal = z.object({goal: codexGoalSchema.nullable().optional()}).parse(
    await rpc.request("thread/goal/get", {threadId}, {signal})).goal ?? null;
  if (goal && goal.threadId !== threadId) throw failure();
  return goal;
}

/** A goal is an independently admitted native job, not a synthetic native turn ID.
 * The caller persists reserve/confirm before dispatch/activation. A lost ACK leaves
 * the reservation uncertain; a new process must never activate or recreate it.
 */
export class CodexGoalOwner {
  #goal: CodexGoal | undefined;
  #stopped = false;
  #activated = false;
  #reserved = false;
  #clearing = false;
  #activation: Promise<void> | undefined;
  constructor(readonly rpc: Rpc, readonly threadId: string,
    readonly hooks: {reserve(goal?: CodexGoal): void; confirm(goal: CodexGoal): void; updated(goal: CodexGoal): void}, readonly goalMutationOrigins = false) {}

  get goal(): CodexGoal | undefined {return this.#goal && {...this.#goal};}
  get active(): boolean {return !this.#stopped && this.#activated && this.#goal?.status === "active";}

  async prepare(objective: string, tokenBudget: number | undefined, signal: AbortSignal): Promise<CodexGoal> {
    if (this.#goal || this.#stopped || this.#reserved) throw failure();
    z.string().min(1).max(128 * 1024).parse(objective);
    if (tokenBudget !== undefined) integer.positive().parse(tokenBudget);
    const prior = await readCodexGoal(this.rpc, this.threadId, signal);
    // Replacing any existing job requires a separate explicit clear operation.
    if (prior) throw new HarnessAdapterError("native_goal_exists", "Clear the existing native goal before admitting a replacement.");
    signal.throwIfAborted();
    this.#reserved = true;
    this.hooks.reserve();
    const goal = response.parse(await this.rpc.request("thread/goal/set", {
      threadId: this.threadId, objective, status: "paused", ...this.#origin("user"), ...(tokenBudget !== undefined ? {tokenBudget} : {}),
    }, {signal})).goal;
    if (goal.threadId !== this.threadId || goal.objective !== objective || goal.status !== "paused"
      || (goal.tokenBudget ?? undefined) !== tokenBudget) throw failure();
    this.hooks.confirm({...goal});
    this.#goal = goal;
    return {...goal};
  }

  async prepareResume(expectedCreatedAt: number, signal: AbortSignal): Promise<CodexGoal> {
    if (this.#goal || this.#stopped || this.#reserved) throw failure();
    integer.parse(expectedCreatedAt);
    const prior = await readCodexGoal(this.rpc, this.threadId, signal);
    if (!prior || prior.createdAt !== expectedCreatedAt || prior.status === "active" || prior.status === "complete")
      throw new HarnessAdapterError("native_goal_resume_mismatch", "Resume requires the requested inactive, unfinished native goal generation.");
    signal.throwIfAborted();
    this.#reserved = true;
    this.hooks.reserve({...prior});
    this.#goal = prior;
    // Resume preserves objective, budget and usage. It never invents a fresh job.
    if (prior.status !== "paused") await this.#setStatus("paused", signal);
    this.hooks.confirm({...this.#goal});
    return {...this.#goal};
  }

  /** Call only after the first root turn's native acknowledgement and callback admission. */
  activate(signal: AbortSignal): Promise<void> {
    if (this.#activation) return this.#activation;
    if (!this.#goal || this.#stopped || signal.aborted) return Promise.reject(failure());
    this.#activation = this.#setStatus("active", signal, "user").then(async () => {
      // Stop can race the activation ACK. Never leave that race running autonomously.
      if (this.#stopped) await this.#setStatus("paused", AbortSignal.timeout(10_000));
      else this.#activated = true;
    });
    return this.#activation;
  }

  async pause(force = false, origin: "user" | "automatic" = "automatic"): Promise<void> {
    this.#stopped = true;
    this.#activated = false;
    if (this.#activation) await this.#activation;
    if (this.#goal && (this.#goal.status === "active" || force && this.#goal.status !== "paused"))
      await this.#setStatus("paused", AbortSignal.timeout(10_000), origin);
  }

  async clear(signal: AbortSignal): Promise<void> {
    await this.pause();
    const prior = await readCodexGoal(this.rpc, this.threadId, signal);
    if (!prior) throw failure();
    this.#verify(prior);
    this.#clearing = true;
    await this.rpc.request("thread/goal/clear", {threadId: this.threadId, ...this.#origin("user")}, {signal});
    if (await readCodexGoal(this.rpc, this.threadId, signal)) throw failure();
    this.#goal = undefined;
  }

  observe(message: RpcMessage): boolean {
    if (message.method !== "thread/goal/updated" && message.method !== "thread/goal/cleared") return false;
    const binding = z.object({threadId: z.string()}).parse(message.params);
    if (binding.threadId !== this.threadId) return false;
    if (message.method === "thread/goal/cleared" && this.#clearing) return true;
    if (!this.#goal) throw failure();
    if (message.method === "thread/goal/cleared") {
      // A foreign clear cannot be confused with a successful owned completion.
      throw new HarnessAdapterError("native_goal_owner_lost", "The admitted native goal was cleared outside its execution owner.");
    }
    const goal = response.parse(message.params).goal;
    const current = this.#goal;
    if (goal.updatedAt < current.updatedAt) {
      // Admission/activation notifications can precede their ACK and be drained
      // after it. Ignore only verified historical snapshots of the same job.
      if (goal.threadId !== current.threadId || goal.createdAt !== current.createdAt || goal.objective !== current.objective
        || goal.tokenBudget !== current.tokenBudget || goal.tokensUsed > current.tokensUsed || goal.timeUsedSeconds > current.timeUsedSeconds)
        throw failure();
      return true;
    }
    this.#verify(goal);
    this.#goal = goal;
    this.hooks.updated({...goal});
    return true;
  }

  #verify(goal: CodexGoal): void {
    const admitted = this.#goal;
    if (!admitted || goal.threadId !== this.threadId || goal.createdAt !== admitted.createdAt
      || goal.objective !== admitted.objective || goal.tokenBudget !== admitted.tokenBudget
      || goal.updatedAt < admitted.updatedAt || goal.tokensUsed < admitted.tokensUsed
      || goal.timeUsedSeconds < admitted.timeUsedSeconds) throw failure();
  }
  #origin(origin: "user" | "automatic"): {origin?: "user" | "automatic"} {
    return this.goalMutationOrigins ? {origin} : {};
  }
  async #setStatus(status: "active" | "paused", signal: AbortSignal, origin: "user" | "automatic" = "automatic"): Promise<void> {
    // Re-read before any mutation; do not mutate a goal replaced by an external client.
    const prior = response.parse(await this.rpc.request("thread/goal/get", {threadId: this.threadId}, {signal})).goal;
    this.#verify(prior);
    this.#goal = prior;
    // A first phase may finish or exhaust the native job before activation's ACK.
    // Preserve that native outcome rather than turning it active again.
    if (status === "active" && prior.status !== "paused") {
      if (prior.status === "active") throw failure();
      this.hooks.updated({...prior});
      return;
    }
    const goal = response.parse(await this.rpc.request("thread/goal/set", {threadId: this.threadId, status, ...this.#origin(origin)}, {signal})).goal;
    this.#verify(goal);
    if (goal.status !== status && !(status === "active" && ["budgetLimited", "usageLimited", "blocked", "complete"].includes(goal.status)))
      throw new HarnessAdapterError("native_goal_status_mismatch", `Codex returned ${goal.status} after the owned ${status} request.`);
    this.#goal = goal;
    this.hooks.updated({...goal});
  }
}
