import {hcpHarnessEventPayloadSchema} from "@harness-control/protocol";

export type HcpNativePhase = {
  admission_id: string; native_reference: string; native_execution_reference: string; origin_turn_id: string;
  goal_admission_id?: string; admitted_at?: string; completed_at?: string;
  /** Absence means no terminal proof; it does not establish a currently running physical owner. */
  status?: "completed" | "interrupted" | "failed";
};
export class HcpNativePhaseConflictError extends Error {
  constructor(readonly admissionId: string) {
    super("Conflicting native phase identity or terminal evidence.");this.name = "HcpNativePhaseConflictError";
  }
}

/** Native phase evidence from a validated event slice. This is not an exhaustive execution/closure inventory. */
export function projectHcpNativePhases(inputs: readonly unknown[], sessionId: string, origin?: string): HcpNativePhase[] {
  const phases = new Map<string, HcpNativePhase>();
  const owners = new Map<string, string>();
  const events = inputs.map(input => hcpHarnessEventPayloadSchema.parse(input))
    .filter(event => event.session_id === sessionId && (origin === undefined || event.turn_id === origin)
      && ["native.execution.admitted", "native.execution.completed"].includes(event.event_type))
    .sort((left, right) => left.sequence - right.sequence);
  for (const event of events) {
    const data = event.data as {admission_id: string; native_reference: string; native_execution_reference: string;
      goal_admission_id?: string; status?: HcpNativePhase["status"]};
    const nativeKey = JSON.stringify([data.native_reference, data.native_execution_reference]);
    if (owners.has(nativeKey) && owners.get(nativeKey) !== data.admission_id) throw new HcpNativePhaseConflictError(data.admission_id);
    owners.set(nativeKey, data.admission_id);
    const prior = phases.get(data.admission_id);
    if (prior && (prior.native_reference !== data.native_reference || prior.native_execution_reference !== data.native_execution_reference
        || prior.origin_turn_id !== event.turn_id || prior.goal_admission_id !== data.goal_admission_id
        || prior.status && data.status && prior.status !== data.status)) throw new HcpNativePhaseConflictError(data.admission_id);
    const phase: HcpNativePhase = prior ?? {admission_id: data.admission_id, native_reference: data.native_reference,
      native_execution_reference: data.native_execution_reference, origin_turn_id: event.turn_id!,
      ...(data.goal_admission_id ? {goal_admission_id: data.goal_admission_id} : {})};
    if (event.event_type === "native.execution.admitted") phase.admitted_at ??= event.created_at;
    if (data.status) {phase.status = data.status;phase.completed_at ??= event.created_at;}
    phases.set(data.admission_id, phase);
  }
  return [...phases.values()];
}
