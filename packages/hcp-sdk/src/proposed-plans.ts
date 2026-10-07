import {hcpHarnessEventPayloadSchema, harnessProposedPlanDeltaSchema, harnessProposedPlanCompletedSchema,
  type HarnessProposedPlanCompleted, type HarnessContentReference} from "@harness-control/protocol";

import {HcpContentReadError, type CompleteContentOptions, type HcpCompleteContent} from "./content.js";

export type HcpProposedPlan = {item_id: string; native_execution_reference: string; origin_turn_id: string;
  preview: string; status: "preview" | "completed"; completed?: HarnessProposedPlanCompleted["plan"]};
export class HcpProposedPlanConflictError extends Error {
  constructor() {super("Conflicting or unbounded native proposed-plan evidence.");this.name = "HcpProposedPlanConflictError";}
}

/** Projections of a bounded event slice, not an exhaustive plan or native execution inventory.
 * Preview deltas may differ from completed native content. Never promote a preview to completion. */
export function projectHcpProposedPlans(inputs: readonly unknown[], sessionId: string, origin?: string): HcpProposedPlan[] {
  if (inputs.length > 16_384) throw new HcpProposedPlanConflictError();
  const plans = new Map<string, HcpProposedPlan>(), sequences = new Map<number, string>();
  const events = inputs.map(input => hcpHarnessEventPayloadSchema.parse(input)).filter(event => event.session_id === sessionId
    && (origin === undefined || event.turn_id === origin) && ["turn.proposed.delta", "turn.proposed.completed"].includes(event.event_type))
    .sort((a, b) => a.sequence - b.sequence);
  const encoder = new TextEncoder();let previewBytes = 0, completionBytes = 0;
  for (const event of events) {
    if (!event.turn_id) throw new HcpProposedPlanConflictError();
    const encoded = JSON.stringify(event), previous = sequences.get(event.sequence);
    if (previous !== undefined) {if (previous !== encoded) throw new HcpProposedPlanConflictError();continue;}
    sequences.set(event.sequence, encoded);
    const data = event.event_type === "turn.proposed.delta" ? harnessProposedPlanDeltaSchema.parse(event.data)
      : harnessProposedPlanCompletedSchema.parse(event.data);
    const key = JSON.stringify([data.native_execution_reference, data.item_id]);
    let plan = plans.get(key);
    if (!plan) {
      if (plans.size >= 128) throw new HcpProposedPlanConflictError();
      plan = {item_id: data.item_id, native_execution_reference: data.native_execution_reference, origin_turn_id: event.turn_id,
        preview: "", status: "preview"};plans.set(key, plan);
    }
    if (plan.origin_turn_id !== event.turn_id) throw new HcpProposedPlanConflictError();
    if ("delta" in data) {
      previewBytes += encoder.encode(data.delta).byteLength;
      if (plan.status === "completed" || previewBytes > 8 * 1024 * 1024 || encoder.encode(plan.preview).byteLength + encoder.encode(data.delta).byteLength > 1024 * 1024)
        throw new HcpProposedPlanConflictError();
      plan.preview += data.delta;
    } else {
      if (plan.status === "completed" && JSON.stringify(plan.completed) !== JSON.stringify(data.plan)) throw new HcpProposedPlanConflictError();
      if (plan.status !== "completed") completionBytes += encoder.encode(JSON.stringify(data.plan)).byteLength;
      if (completionBytes > 8 * 1024 * 1024) throw new HcpProposedPlanConflictError();
      plan.status = "completed";plan.completed = data.plan;
    }
  }
  return structuredClone([...plans.values()]);
}


export type ProposedPlanContentOptions = CompleteContentOptions & {maxTotalBytes?: number; maxReferences?: number};
export type HcpResolvedProposedPlan = {source: HcpProposedPlan; completed_plan?: string};
/** Native item completion supplies the body; it does not accept the plan or close its execution. */
export async function projectHcpProposedPlansComplete(inputs: readonly unknown[], sessionId: string, origin: string | undefined,
  read: (reference: HarnessContentReference, options: CompleteContentOptions) => Promise<HcpCompleteContent>,
  options: ProposedPlanContentOptions = {}): Promise<HcpResolvedProposedPlan[]> {
  options.signal?.throwIfAborted();
  const plans = projectHcpProposedPlans(inputs, sessionId, origin);
  const maxBytes = options.maxTotalBytes ?? 8 * 1024 * 1024, maxReferences = options.maxReferences ?? 128;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024 * 1024 ||
      !Number.isSafeInteger(maxReferences) || maxReferences < 1 || maxReferences > 128) throw new HcpContentReadError("limit");
  const cache = new Map<string, HcpCompleteContent>(), encoder = new TextEncoder();let bytes = 0;
  const result: HcpResolvedProposedPlan[] = [];
  for (const source of plans) {
    options.signal?.throwIfAborted();let completed_plan: string | undefined;
    if (typeof source.completed === "string") {
      completed_plan = source.completed;
      const size = encoder.encode(completed_plan).byteLength;
      if (size > maxBytes - bytes) throw new HcpContentReadError("limit");bytes += size;
    } else if (source.completed !== undefined) {
      const reference = source.completed.content_ref;if (!reference) throw new HcpProposedPlanConflictError();
      if (reference.byte_length > maxBytes - bytes) throw new HcpContentReadError("limit");
      let full = cache.get(reference.content_id);
      if (full && JSON.stringify(full.reference) !== JSON.stringify(reference)) throw new HcpContentReadError("reference_changed");
      if (!full) {
        if (cache.size >= maxReferences) throw new HcpContentReadError("limit");
        full = await read({...reference}, {...options, maxBytes: Math.max(1, Math.min(options.maxBytes ?? 8 * 1024 * 1024, maxBytes - bytes))});
        options.signal?.throwIfAborted();
        if (JSON.stringify(full.reference) !== JSON.stringify(reference) || full.format !== reference.format) throw new HcpContentReadError("reference_changed");
      }
      if (full.format !== "text" || typeof full.text !== "string") throw new HcpProposedPlanConflictError();
      if (encoder.encode(full.text).byteLength > reference.byte_length) throw new HcpContentReadError("limit");
      if (!cache.has(reference.content_id)) cache.set(reference.content_id, structuredClone(full));
      completed_plan = full.text;bytes += reference.byte_length;
    }
    result.push({source, ...(completed_plan === undefined ? {} : {completed_plan})});
  }
  return result;
}
