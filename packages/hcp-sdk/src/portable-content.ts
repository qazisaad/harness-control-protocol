import {harnessHistoryMediaSourceSchema, type HarnessHistoryMediaSource, HARNESS_CONTENT_MAX_BYTES, HARNESS_CONTENT_STORE_MAX_BYTES, harnessHistoryValueSchema, type HarnessPortableHistoryItem, type HarnessContentReference} from "@harness-control/protocol";
import {HcpContentReadError, type HcpCompleteContent, type CompleteContentOptions} from "./content.js";
import type {HistoryContentOptions, HistoryValueField, ResolvedHistoryValue} from "./history-content.js";

export function createPortableContentReader(read: (reference: HarnessContentReference, options: CompleteContentOptions) => Promise<HcpCompleteContent>, options: HistoryContentOptions) {
  const maxBytes = options.maxTotalBytes ?? 256 * 1024 * 1024, maxReferences = options.maxReferences ?? 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > HARNESS_CONTENT_STORE_MAX_BYTES ||
      !Number.isSafeInteger(maxReferences) || maxReferences < 1 || maxReferences > 1024) throw new HcpContentReadError("limit");
  const cache = new Map<string, HcpCompleteContent>();
  let bytes = 0;
  const content = async (reference: HarnessContentReference) => {
    options.signal?.throwIfAborted();
    const retained = cache.get(reference.content_id);
    if (retained) {
      if (JSON.stringify(retained.reference) !== JSON.stringify(reference)) throw new HcpContentReadError("reference_changed");
      return retained;
    }
    if (cache.size >= maxReferences || reference.byte_length > maxBytes - bytes) throw new HcpContentReadError("limit");
    const value = await read({...reference}, {...options, maxBytes: Math.max(1, Math.min(options.maxBytes ?? HARNESS_CONTENT_MAX_BYTES, maxBytes - bytes))});
    options.signal?.throwIfAborted();
    if (JSON.stringify(value.reference) !== JSON.stringify(reference) || value.format !== reference.format)
      throw new HcpContentReadError("reference_changed");
    bytes += reference.byte_length;cache.set(reference.content_id, value);return value;
  };
  const json = async (reference: HarnessContentReference) => {
    const result = await content(reference);
    if (result.format !== "json") throw new HcpContentReadError("invalid_json");
    return result.value;
  };
  return {content, json};
}

export async function resolvePortableItems(items: HarnessPortableHistoryItem[], content: (reference: HarnessContentReference) => Promise<HcpCompleteContent>) {
  const resolved: {item: HarnessPortableHistoryItem; values: Partial<Record<HistoryValueField, ResolvedHistoryValue>>; media?: HarnessHistoryMediaSource}[] = [];
  for (const item of items) {
    const values: Partial<Record<HistoryValueField, ResolvedHistoryValue>> = {};
    for (const field of ["body", "arguments", "result", "command", "output", "changes"] as const) {
      if (!(field in item)) continue;
      const value = harnessHistoryValueSchema.parse((item as unknown as Record<string, unknown>)[field]);
      if (value.storage !== "reference") {values[field] = value; continue;}
      const full = await content(value.content_ref);
      const inline = harnessHistoryValueSchema.parse({storage: "inline", value: full.format === "text" ? full.text : full.value});
      if (inline.storage !== "inline") throw new HcpContentReadError("invalid_json");
      values[field] = {storage: "resolved", content_ref: value.content_ref, value: inline.value};
    }
    const body = values.body;
    const media = item.type === "attachment" && body && body.storage !== "unavailable"
      ? harnessHistoryMediaSourceSchema.parse(body.value) : undefined;
    resolved.push({item, values, ...(media ? {media} : {})});
  }
  return resolved;
}
