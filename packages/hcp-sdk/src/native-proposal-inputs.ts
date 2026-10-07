import {hcpHarnessEventPayloadSchema, harnessNativePlanProposalInputSchema,
  type HarnessNativePlanProposalInput, type HarnessContentReference} from "@harness-control/protocol";
import {HcpContentReadError, type CompleteContentOptions, type HcpCompleteContent} from "./content.js";
import type {ProposedPlanContentOptions} from "./proposed-plans.js";

export type HcpNativeProposalInput = {event_sequence: number; observed_at: string; origin_turn_id?: string; native_proposal: HarnessNativePlanProposalInput};
export type HcpResolvedNativeProposalInput = {source: HcpNativeProposalInput; plan: string};
export class HcpNativeProposalInputError extends Error {
  constructor() {super("Conflicting, unavailable or unbounded native proposal input.");this.name = "HcpNativeProposalInputError";}
}
/** A bounded slice of actual tool input, not native completion, acceptance or an exhaustive inventory. */
export function projectHcpNativeProposalInputs(inputs: readonly unknown[], sessionId: string, origin?: string): HcpNativeProposalInput[] {
  if (inputs.length > 16_384) throw new HcpNativeProposalInputError();
  const result: HcpNativeProposalInput[] = [], sequences = new Map<number, string>(), encoder = new TextEncoder();let bytes = 0;
  const events = inputs.map(input => hcpHarnessEventPayloadSchema.parse(input)).filter(event => event.session_id === sessionId
    && (origin === undefined || event.turn_id === origin) && event.event_type === "turn.proposed.observed").sort((a, b) => a.sequence - b.sequence);
  for (const event of events) {
    const native_proposal = harnessNativePlanProposalInputSchema.parse(event.data), encoded = JSON.stringify(event), previous = sequences.get(event.sequence);
    if (previous !== undefined) {if (previous !== encoded) throw new HcpNativeProposalInputError();continue;}
    sequences.set(event.sequence, encoded);bytes += encoder.encode(encoded).byteLength;
    if (result.length >= 128 || bytes > 8 * 1024 * 1024) throw new HcpNativeProposalInputError();
    result.push({event_sequence: event.sequence, observed_at: event.created_at,
      ...(event.turn_id === undefined ? {} : {origin_turn_id: event.turn_id}), native_proposal});
  }
  return structuredClone(result);
}

export async function projectHcpNativeProposalInputsComplete(inputs: readonly unknown[], sessionId: string, origin: string | undefined,
  read: (reference: HarnessContentReference, options: CompleteContentOptions) => Promise<HcpCompleteContent>,
  options: ProposedPlanContentOptions = {}): Promise<HcpResolvedNativeProposalInput[]> {
  options.signal?.throwIfAborted();const observations = projectHcpNativeProposalInputs(inputs, sessionId, origin);
  const maxBytes = options.maxTotalBytes ?? 8 * 1024 * 1024, maxReferences = options.maxReferences ?? 128;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024 * 1024 ||
      !Number.isSafeInteger(maxReferences) || maxReferences < 1 || maxReferences > 128) throw new HcpContentReadError("limit");
  const cache = new Map<string, HcpCompleteContent>(), encoder = new TextEncoder();let bytes = 0;
  const result: HcpResolvedNativeProposalInput[] = [];
  for (const source of observations) {
    options.signal?.throwIfAborted();const body = source.native_proposal.plan;let plan: string;
    if (typeof body === "string") {
      plan = body;const size = encoder.encode(plan).byteLength;
      if (size > maxBytes - bytes) throw new HcpContentReadError("limit");bytes += size;
    } else {
      const reference = body.content_ref;if (!reference) throw new HcpNativeProposalInputError();
      if (reference.byte_length > maxBytes - bytes) throw new HcpContentReadError("limit");
      let full = cache.get(reference.content_id);
      if (full && JSON.stringify(full.reference) !== JSON.stringify(reference)) throw new HcpContentReadError("reference_changed");
      if (!full) {
        if (cache.size >= maxReferences) throw new HcpContentReadError("limit");
        full = await read({...reference}, {...options, maxBytes: Math.max(1, Math.min(options.maxBytes ?? 8 * 1024 * 1024, maxBytes - bytes))});
        options.signal?.throwIfAborted();
        if (JSON.stringify(full.reference) !== JSON.stringify(reference) || full.format !== reference.format) throw new HcpContentReadError("reference_changed");
      }
      if (full.format !== "text" || typeof full.text !== "string") throw new HcpNativeProposalInputError();
      if (encoder.encode(full.text).byteLength > reference.byte_length) throw new HcpContentReadError("limit");
      if (!cache.has(reference.content_id)) cache.set(reference.content_id, structuredClone(full));
      plan = full.text;bytes += reference.byte_length;
    }
    result.push({source, plan});
  }
  return result;
}
