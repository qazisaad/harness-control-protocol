import {
  nativeConversationHistorySchema, harnessPortableHistoryItemsSchema,
  type HarnessHistoryMediaSource, type NativeConversationHistory, type HarnessHistoryValue, type HarnessPortableHistoryItem, type HarnessContentReference,
} from "@harness-control/protocol";
import {createPortableContentReader, resolvePortableItems} from "./portable-content.js";
import {type HcpCompleteContent, type CompleteContentOptions} from "./content.js";

export type HistoryContentOptions = CompleteContentOptions & {maxTotalBytes?: number; maxReferences?: number};
export type ResolvedHistoryValue = Exclude<HarnessHistoryValue, {storage: "reference"}> |
  {storage: "resolved"; content_ref: HarnessContentReference; value: Extract<HarnessHistoryValue, {storage: "inline"}>["value"]};
export type HistoryValueField = "body" | "arguments" | "result" | "command" | "output" | "changes";
export type HcpResolvedHistoryPage = {
  /** Original wire evidence, including fidelity, truncation, references and paging cursor. */
  source: NativeConversationHistory;
  turns: {id: string; native_items: NativeConversationHistory["turns"][number]["items"];
    portable_items?: {item: HarnessPortableHistoryItem; values: Partial<Record<HistoryValueField, ResolvedHistoryValue>>; media?: HarnessHistoryMediaSource}[]}[];
};

/** Resolve one history page without upgrading native fidelity or claiming the full conversation was paged. */
export async function resolveHcpHistoryPage(history: NativeConversationHistory,
  read: (reference: HarnessContentReference, options: CompleteContentOptions) => Promise<HcpCompleteContent>,
  options: HistoryContentOptions = {}): Promise<HcpResolvedHistoryPage> {
  options.signal?.throwIfAborted();
  const source = nativeConversationHistorySchema.parse(history);
  const {content, json} = createPortableContentReader(read, options);
  const turns: HcpResolvedHistoryPage["turns"] = [];
  for (const turn of source.turns) {
    const native_items = turn.items_ref ? nativeConversationHistorySchema.shape.turns.element.shape.items.parse(await json(turn.items_ref)) : turn.items;
    const portable = turn.portable_items_ref ? harnessPortableHistoryItemsSchema.parse(await json(turn.portable_items_ref)) : turn.portable_items;
    const portable_items: NonNullable<HcpResolvedHistoryPage["turns"][number]["portable_items"]> = [];
    portable_items.push(...await resolvePortableItems(portable ?? [], content));
    turns.push({id: turn.id, native_items, ...(portable === undefined ? {} : {portable_items})});
  }
  return {source, turns};
}
