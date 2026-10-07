import {harnessPortableItemObservationSchema, harnessPortableHistoryItemsSchema, type HarnessPortableItemObservation, type HarnessContentReference} from "@harness-control/protocol";
import type {HcpCompleteContent, CompleteContentOptions} from "./content.js";
import type {HistoryContentOptions} from "./history-content.js";
import {createPortableContentReader, resolvePortableItems} from "./portable-content.js";

/** Resolve an observed native item without inventing conversation boundaries or upgrading fidelity. */
export async function resolveHcpPortableItem(observation: HarnessPortableItemObservation,
  read: (reference: HarnessContentReference, options: CompleteContentOptions) => Promise<HcpCompleteContent>, options: HistoryContentOptions = {}) {
  options.signal?.throwIfAborted();
  const source = harnessPortableItemObservationSchema.parse(observation);
  const {content, json} = createPortableContentReader(read, options);
  const items = "items_ref" in source ? harnessPortableHistoryItemsSchema.parse(await json(source.items_ref)) : source.items;
  return {source, items: await resolvePortableItems(items, content)};
}
