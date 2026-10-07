import {harnessTextDeltaEventDataSchema, harnessItemEventDataSchema, hcpHarnessEventPayloadSchema,
  harnessNativeReasoningContentSchema, harnessContentReferenceSchema} from "@harness-control/protocol";
import type {HcpReasoningItem} from "./reasoning-items.js";
/** Native item/block evidence from a bounded slice. Completion of an item is not execution closure. */
export function projectNativeParts(inputs: readonly unknown[], sessionId: string, origin: string | undefined,
  kind: "text" | "reasoning", fail: () => Error): HcpReasoningItem[] {
  if (inputs.length > 16_384) throw fail();
  const items = new Map<string, HcpReasoningItem>(), sequences = new Map<number, string>();
  const encoder = new TextEncoder();let bytes = 0;
  const events = inputs.map(input => hcpHarnessEventPayloadSchema.parse(input)).filter(event => event.session_id === sessionId
    && (origin === undefined || event.turn_id === origin) && [kind === "text" ? "content.delta" : "reasoning.delta", "item.started", "item.updated", "item.completed"].includes(event.event_type))
    .sort((a, b) => a.sequence - b.sequence);
  for (const event of events) {
    const delta = event.event_type === (kind === "text" ? "content.delta" : "reasoning.delta") ? harnessTextDeltaEventDataSchema.parse(event.data) : undefined;
    const lifecycle = delta ? undefined : harnessItemEventDataSchema.parse(event.data);
    if (lifecycle && !(kind === "text" ? ["text", "agentMessage"] : ["reasoning"]).includes(lifecycle.item_type ?? "")) continue;
    const data = delta ?? lifecycle!;
    if (!data.native_part && !data.item_id) continue;
    if (data.message_id && data.native_part && data.message_id !== data.native_part.message_reference) throw fail();
    if (!event.turn_id || delta?.native_segment && (data.native_part || kind === "text")) throw fail();
    const encoded = JSON.stringify(event), priorSequence = sequences.get(event.sequence);
    if (priorSequence !== undefined) {if (priorSequence !== encoded) throw fail();continue;}
    sequences.set(event.sequence, encoded);
    bytes += encoder.encode(encoded).byteLength;if (bytes > 8 * 1024 * 1024) throw fail();
    const key = JSON.stringify(data.native_part ? ["block", data.native_part.message_reference, data.native_part.index]
      : ["item", data.native_execution_reference ?? null, data.item_id]);
    let item = items.get(key);
    if (!item) {
      if (items.size >= 128) throw fail();
      item = {origin_turn_id: event.turn_id, ...(data.item_id ? {item_id: data.item_id} : {}), ...(data.message_id ? {message_id: data.message_id} : {}),
        ...(data.native_execution_reference ? {native_execution_reference: data.native_execution_reference} : {}),
        ...(data.native_part ? {native_part: data.native_part} : {}), segments: [], completed: false,
        first_observed_at: event.created_at, last_observed_at: event.created_at};items.set(key, item);
    }
    if (item.origin_turn_id !== event.turn_id || item.message_id && data.message_id && item.message_id !== data.message_id || item.item_id && data.item_id && item.item_id !== data.item_id
      || item.native_execution_reference && data.native_execution_reference && item.native_execution_reference !== data.native_execution_reference)
      throw fail();
    if (data.message_id) item.message_id = data.message_id;
    if (data.item_id) item.item_id = data.item_id;
    if (data.native_execution_reference) item.native_execution_reference = data.native_execution_reference;
    item.last_observed_at = event.created_at;
    if (delta) {
      if (item.completed) throw fail();
      const kind = delta.native_segment?.kind ?? (delta.stream_kind === "reasoning_summary" ? "summary" : delta.stream_kind === "reasoning_content" ? "content" : "unspecified");
      const index = delta.native_segment?.index;
      let segment = item.segments.find(segment => segment.kind === kind && segment.index === index);
      if (!segment) {
        if (item.segments.length >= 4096) throw fail();
        segment = {kind, ...(index === undefined ? {} : {index}), text: ""};item.segments.push(segment);
      }
      segment.text += delta.delta;
    } else if (event.event_type === "item.completed") {
      let content: HcpReasoningItem["completed_content"];
      if (lifecycle!.content !== undefined) {
        if (typeof lifecycle!.content === "string") content = lifecycle!.content;
        else {
          const structured = harnessNativeReasoningContentSchema.safeParse(lifecycle!.content);
          if (kind === "reasoning" && structured.success) content = structured.data;
          else {
            const value = lifecycle!.content as {truncated?: unknown; summary?: unknown; content_ref?: unknown};
            if (!value || value.truncated !== true || typeof value.summary !== "string"
              || Object.keys(value).some(key => !["truncated", "summary", "content_ref"].includes(key))) throw fail();
            content = {truncated: true, summary: value.summary,
              ...(value.content_ref === undefined ? {} : {content_ref: harnessContentReferenceSchema.parse(value.content_ref)})};
          }
        }
      }
      if (item.completed && content !== undefined && item.completed_content !== undefined && JSON.stringify(item.completed_content) !== JSON.stringify(content)) throw fail();
      item.completed = true;item.completed_at ??= event.created_at;if (content !== undefined) item.completed_content = content;
    } else if (item.completed) throw fail();
  }
  return structuredClone([...items.values()]);
}
