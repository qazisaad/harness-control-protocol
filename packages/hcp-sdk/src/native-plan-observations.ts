import {hcpHarnessEventPayloadSchema, harnessTurnPlanUpdatedEventDataSchema, harnessNativePlanStepsSchema,
  type HarnessNativePlanObservation, type HarnessNativePlanStep, type HarnessContentReference} from "@harness-control/protocol";
import {HcpContentReadError, type HcpCompleteContent, type CompleteContentOptions} from "./content.js";

export type HcpNativePlanObservation = {event_sequence: number; observed_at: string; origin_turn_id?: string; native_plan: HarnessNativePlanObservation};
export type NativePlanContentOptions = CompleteContentOptions & {maxTotalBytes?: number; maxReferences?: number};
export type HcpResolvedNativePlanObservation = {source: HcpNativePlanObservation; steps: HarnessNativePlanStep[]; explanation?: string};
export class HcpNativePlanObservationError extends Error {
  constructor() {super("Conflicting, unavailable or unbounded native plan observation.");this.name = "HcpNativePlanObservationError";}
}
function steps(value: unknown): HarnessNativePlanStep[] {
  const parsed = harnessNativePlanStepsSchema.safeParse(value);
  if (!parsed.success || parsed.data.some((step, index) => step.index !== index)) throw new HcpNativePlanObservationError();
  return parsed.data;
}
/** Ordered observations from a bounded slice. Tool input is proposed todo state; an empty snapshot is not execution closure. */
export function projectHcpNativePlanObservations(inputs: readonly unknown[], sessionId: string, origin?: string): HcpNativePlanObservation[] {
  if (inputs.length > 16_384) throw new HcpNativePlanObservationError();
  const observations: HcpNativePlanObservation[] = [], sequences = new Map<number, string>(), encoder = new TextEncoder();let bytes = 0;
  const events = inputs.map(input => hcpHarnessEventPayloadSchema.parse(input)).filter(event => event.session_id === sessionId
    && (origin === undefined || event.turn_id === origin) && event.event_type === "turn.plan.updated").sort((a, b) => a.sequence - b.sequence);
  for (const event of events) {
    const native_plan = harnessTurnPlanUpdatedEventDataSchema.parse(event.data).native_plan;
    if (!native_plan) continue; // Legacy raw arrays cannot become strong native observations.
    const encoded = JSON.stringify(event), previous = sequences.get(event.sequence);
    if (previous !== undefined) {if (previous !== encoded) throw new HcpNativePlanObservationError();continue;}
    sequences.set(event.sequence, encoded);bytes += encoder.encode(encoded).byteLength;
    if (observations.length >= 128 || bytes > 8 * 1024 * 1024) throw new HcpNativePlanObservationError();
    if (Array.isArray(native_plan.steps)) steps(native_plan.steps);
    observations.push({event_sequence: event.sequence, observed_at: event.created_at,
      ...(event.turn_id === undefined ? {} : {origin_turn_id: event.turn_id}), native_plan});
  }
  return structuredClone(observations);
}

/** Retrieve complete normalized step arrays, retaining native snapshot/tool-input semantics and original references. */
export async function projectHcpNativePlanObservationsComplete(inputs: readonly unknown[], sessionId: string, origin: string | undefined,
  read: (reference: HarnessContentReference, options: CompleteContentOptions) => Promise<HcpCompleteContent>,
  options: NativePlanContentOptions = {}): Promise<HcpResolvedNativePlanObservation[]> {
  options.signal?.throwIfAborted();
  const observations = projectHcpNativePlanObservations(inputs, sessionId, origin);
  const maxBytes = options.maxTotalBytes ?? 8 * 1024 * 1024, maxReferences = options.maxReferences ?? 128;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024 * 1024 ||
      !Number.isSafeInteger(maxReferences) || maxReferences < 1 || maxReferences > 128) throw new HcpContentReadError("limit");
  const cache = new Map<string, HcpCompleteContent>(), encoder = new TextEncoder();let bytes = 0;
  const consume = (size: number) => {
    if (size > maxBytes - bytes) throw new HcpContentReadError("limit");bytes += size;
  };
  const retrieve = async (reference: HarnessContentReference): Promise<HcpCompleteContent> => {
    options.signal?.throwIfAborted();
    if (reference.byte_length > maxBytes - bytes) throw new HcpContentReadError("limit");
    let full = cache.get(reference.content_id);
    if (full && JSON.stringify(full.reference) !== JSON.stringify(reference)) throw new HcpContentReadError("reference_changed");
    if (!full) {
      if (cache.size >= maxReferences) throw new HcpContentReadError("limit");
      full = await read({...reference}, {...options, maxBytes: Math.max(1, Math.min(options.maxBytes ?? 8 * 1024 * 1024, maxBytes - bytes))});
      options.signal?.throwIfAborted();
      if (JSON.stringify(full.reference) !== JSON.stringify(reference) || full.format !== reference.format) throw new HcpContentReadError("reference_changed");
    }
    const encoded = full.format === "text" ? full.text : JSON.stringify(full.value);
    if (typeof encoded !== "string" || encoder.encode(encoded).byteLength > reference.byte_length) throw new HcpContentReadError("limit");
    if (!cache.has(reference.content_id)) cache.set(reference.content_id, structuredClone(full));
    consume(reference.byte_length);return full;
  };
  const result: HcpResolvedNativePlanObservation[] = [];
  for (const source of observations) {
    options.signal?.throwIfAborted();const body = source.native_plan.steps;
    let complete: HarnessNativePlanStep[];
    if (Array.isArray(body)) {
      complete = steps(body);consume(encoder.encode(JSON.stringify(complete)).byteLength);
    } else {
      const reference = body.content_ref;if (!reference) throw new HcpNativePlanObservationError();
      const full = await retrieve(reference);
      if (full.format !== "json") throw new HcpNativePlanObservationError();complete = steps(full.value);
    }
    const explanationBody = source.native_plan.explanation;let explanation: string | undefined;
    if (typeof explanationBody === "string") {
      explanation = explanationBody;consume(encoder.encode(explanation).byteLength);
    } else if (explanationBody !== undefined) {
      if (!explanationBody.content_ref) throw new HcpNativePlanObservationError();
      const full = await retrieve(explanationBody.content_ref);
      if (full.format !== "text" || typeof full.text !== "string") throw new HcpNativePlanObservationError();
      explanation = full.text;
    }
    result.push({source, steps: complete, ...(explanation === undefined ? {} : {explanation})});
  }
  return result;
}
