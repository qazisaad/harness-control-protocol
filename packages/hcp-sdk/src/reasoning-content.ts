import {harnessNativeReasoningContentSchema, type HarnessContentReference, type HarnessNativeReasoningContent} from "@harness-control/protocol";
import type {CompleteContentOptions, HcpCompleteContent} from "./content.js";
import {projectHcpReasoningItems, HcpReasoningProjectionError, type HcpReasoningItem} from "./reasoning-items.js";
import {hydrateNativeParts} from "./native-part-content.js";
export type ReasoningContentOptions = CompleteContentOptions & {maxTotalBytes?: number; maxReferences?: number};
export type HcpResolvedReasoningItem = {
  /** Original event evidence and deferred reference remain unchanged. */
  source: HcpReasoningItem;
  /** Available only when the native completed body was fully decoded. Never a concatenated preview. */
  completed_content?: string | HarnessNativeReasoningContent;
};

/** Hydrate completed bodies without establishing inventory or execution closure. */
export async function projectHcpReasoningItemsComplete(inputs: readonly unknown[], sessionId: string, origin: string | undefined,
  read: (reference: HarnessContentReference, options: CompleteContentOptions) => Promise<HcpCompleteContent>, options: ReasoningContentOptions = {}): Promise<HcpResolvedReasoningItem[]> {
  options.signal?.throwIfAborted();
  return hydrateNativeParts(projectHcpReasoningItems(inputs, sessionId, origin), read, options, value => {
    const parsed = harnessNativeReasoningContentSchema.safeParse(value);
    if (!parsed.success) throw new HcpReasoningProjectionError();
    return parsed.data;
  }, () => new HcpReasoningProjectionError());
}
