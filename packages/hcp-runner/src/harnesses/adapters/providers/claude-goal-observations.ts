import {createHash} from "node:crypto";
import {z} from "zod";
import {HarnessAdapterError} from "../types.js";

const text = z.string().max(128 * 1024);
const identity = z.string().min(1).max(512);
const content = z.union([text, z.array(z.object({type: z.string(), text: text.optional()})).max(1024)]);
const frame = z.object({type: z.enum(["assistant", "user", "system"]), uuid: identity, session_id: identity,
  parent_tool_use_id: z.string().nullable().optional(), isSynthetic: z.boolean().optional(), subtype: z.string().optional(),
  content: text.optional(), message: z.object({model: z.string().optional(), content}).optional()});
type Goal = {objective: string; status: "active"; observed_checks: number; native_checks?: number; last_check?: string};

/** Native transcript observations are not job admissions or proof of goal completion. */
export class ClaudeGoalObservations {
  #goal: Goal | null = null;
  #seen = new Map<string, string>();
  constructor(readonly nativeReference: string) {}
  /** Positive busy evidence only; absence is not a native goal closure certificate. */
  get hasActiveObservation(): boolean {return this.#goal !== null;}
  observe(input: unknown) {
    const parsed = frame.safeParse(input);
    if (!parsed.success) return;
    const value = parsed.data;
    if (value.session_id !== this.nativeReference || value.parent_tool_use_id != null) return;
    const command = value.type === "assistant" && value.message?.model === "<synthetic>"
      || value.type === "system" && value.subtype === "local_command_output";
    const feedback = value.type === "user" && value.isSynthetic === true;
    if (!command && !feedback) return;
    const parts = value.type === "system" ? value.content : value.message?.content;
    const body = typeof parts === "string" ? parts : parts?.filter(part => part.type === "text").map(part => part.text ?? "").join("");
    if (!body || body.length > 128 * 1024) return;
    const normalized = command ? body.trim() : body;
    let next: Goal | null | undefined;
    if (command) {
      if (normalized.startsWith("Goal set: ")) {
        const objective = normalized.slice("Goal set: ".length).trim();
        if (objective) next = {objective, status: "active", observed_checks: 0};
      } else if (normalized.startsWith("Goal cleared: ") || normalized === "No goal set"
        || normalized.startsWith("No goal set. Usage:")) next = null;
      else {
        const active = /^Goal active: ([\s\S]+?) \((?:not yet evaluated|(\d+) turns?)\)/u.exec(normalized);
        if (active?.[1]) {
          const count = Number(active[2] ?? 0);
          if (Number.isSafeInteger(count) && count >= 0) next = {objective: active[1], status: "active",
            observed_checks: this.#goal?.objective === active[1] ? this.#goal.observed_checks : 0, native_checks: count};
        }
      }
    } else if (this.#goal) {
      const prefix = `Stop hook feedback:\n[${this.#goal.objective}]: `;
      if (normalized.startsWith(prefix)) next = {...this.#goal, observed_checks: this.#goal.observed_checks + 1,
        last_check: normalized.slice(prefix.length).trim().slice(0, 8192)};
    }
    if (next === undefined) return;
    const digest = createHash("sha256").update(JSON.stringify({kind: command ? "command" : "stop_feedback", body: normalized})).digest("hex");
    const prior = this.#seen.get(value.uuid);
    if (prior === digest) return;
    if (prior) throw new HarnessAdapterError("native_goal_observation_binding", "Native goal output reused an observed message identity.");
    if (this.#seen.size >= 1024) throw new HarnessAdapterError("native_goal_observation_limit", "Native goal observations reached their bounded identity limit.");
    this.#seen.set(value.uuid, digest); this.#goal = next;
    return {source: "native_transcript" as const, scope: "session" as const, native_reference: this.nativeReference,
      native_message_reference: value.uuid, kind: command ? "command" as const : "stop_feedback" as const, goal: next};
  }
}
