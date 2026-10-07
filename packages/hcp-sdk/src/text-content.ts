import type {HarnessContentReference} from "@harness-control/protocol";
import type {CompleteContentOptions, HcpCompleteContent} from "./content.js";
import {projectHcpTextItems, HcpTextProjectionError, type HcpTextItem} from "./text-items.js";
import {hydrateNativeParts} from "./native-part-content.js";
export type TextContentOptions = CompleteContentOptions & {maxTotalBytes?: number; maxReferences?: number};
export type HcpResolvedTextItem = {source: HcpTextItem; completed_content?: string};
export async function projectHcpTextItemsComplete(inputs: readonly unknown[], sessionId: string, origin: string | undefined,
  read: (reference: HarnessContentReference, options: CompleteContentOptions) => Promise<HcpCompleteContent>, options: TextContentOptions = {}): Promise<HcpResolvedTextItem[]> {
  options.signal?.throwIfAborted();
  const items = projectHcpTextItems(inputs, sessionId, origin);
  const adapted = items.map(({streamed_text, ...source}) => ({...source, segments: [{kind: "unspecified" as const, text: streamed_text}]}));
  const hydrated = await hydrateNativeParts(adapted, read, options, value => {
    if (typeof value !== "string") throw new HcpTextProjectionError();
    return value;
  }, () => new HcpTextProjectionError());
  return hydrated.map((value, index) => {
    if (value.completed_content !== undefined && typeof value.completed_content !== "string") throw new HcpTextProjectionError();
    return {source: items[index]!, ...(value.completed_content === undefined ? {} : {completed_content: value.completed_content})};
  });
}
