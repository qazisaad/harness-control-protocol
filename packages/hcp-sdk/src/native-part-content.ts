import type {HarnessContentReference, HarnessNativeReasoningContent} from "@harness-control/protocol";
import {HcpContentReadError, type CompleteContentOptions, type HcpCompleteContent} from "./content.js";
import type {HcpReasoningItem} from "./reasoning-items.js";
import type {ReasoningContentOptions, HcpResolvedReasoningItem} from "./reasoning-content.js";
/** Hydrate completed bodies in a bounded event slice; this does not establish inventory or execution closure. */
export async function hydrateNativeParts(items: HcpReasoningItem[],
  read: (reference: HarnessContentReference, options: CompleteContentOptions) => Promise<HcpCompleteContent>,
  options: ReasoningContentOptions, parseJson: (value: unknown) => string | HarnessNativeReasoningContent, fail: () => Error): Promise<HcpResolvedReasoningItem[]> {
  options.signal?.throwIfAborted();
  const maxBytes = options.maxTotalBytes ?? 8 * 1024 * 1024, maxReferences = options.maxReferences ?? 128;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024 * 1024 ||
      !Number.isSafeInteger(maxReferences) || maxReferences < 1 || maxReferences > 128) throw new HcpContentReadError("limit");
  const cache = new Map<string, HcpCompleteContent>(), encoder = new TextEncoder();
  let bytes = 0;
  const result: HcpResolvedReasoningItem[] = [];
  for (const source of items) {
    options.signal?.throwIfAborted();
    const original = source.completed_content;
    let content: HcpResolvedReasoningItem["completed_content"];
    if (original !== undefined && typeof original === "object" && "truncated" in original) {
      const reference = original.content_ref;
      if (!reference) throw fail();
      // Count each decoded output, including repeated references, before copying.
      if (reference.byte_length > maxBytes - bytes) throw new HcpContentReadError("limit");
      let full = cache.get(reference.content_id);
      if (full && JSON.stringify(full.reference) !== JSON.stringify(reference)) throw new HcpContentReadError("reference_changed");
      if (!full) {
        if (cache.size >= maxReferences) throw new HcpContentReadError("limit");
        full = await read({...reference}, {...options, maxBytes: Math.max(1, Math.min(options.maxBytes ?? 8 * 1024 * 1024, maxBytes - bytes))});
        options.signal?.throwIfAborted();
        if (JSON.stringify(full.reference) !== JSON.stringify(reference) || full.format !== reference.format)
          throw new HcpContentReadError("reference_changed");
      }
      if (full.format === "text") content = full.text;
      else {
        content = parseJson(full.value);
      }
      // Byte integrity belongs to the complete reader. Also bound decoded output
      // from custom readers so fabricated reference metadata cannot defeat memory limits.
      const actual = encoder.encode(full.format === "text" ? full.text : JSON.stringify(full.value)).byteLength;
      if (actual > reference.byte_length || actual > maxBytes - bytes) throw new HcpContentReadError("limit");
      if (!cache.has(reference.content_id)) cache.set(reference.content_id, structuredClone(full));
      bytes += reference.byte_length;
    } else if (original !== undefined) {
      content = original;
      const size = encoder.encode(typeof content === "string" ? content : JSON.stringify(content)).byteLength;
      if (size > maxBytes - bytes) throw new HcpContentReadError("limit");
      bytes += size;
    }
    result.push({source, ...(content === undefined ? {} : {completed_content: structuredClone(content)})});
  }
  return result;
}
