import {z} from "zod";
import type {HarnessModel} from "@harness-control/protocol";
import {HarnessAdapterError} from "../types.js";

const id = z.string().min(1).max(512);
const modelSchema = z.object({id, providerID: id, name: z.string().min(1).max(512),
  capabilities: z.object({input: z.object({image: z.boolean()})}),
  variants: z.record(z.string(), z.unknown()).optional(),
  limit: z.object({context: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)}).optional(),
});
const catalogSchema = z.object({all: z.array(z.object({id, models: z.record(z.string(), modelSchema)})).max(256),
  connected: z.array(id).max(256)});

/** Project only connected native providers. Credential-bearing catalog fields never leave this boundary. */
export function projectOpenCodeCatalog(value: unknown): {models: HarnessModel[]; capacities: Map<string, number>} {
  const catalog = catalogSchema.parse(value);
  const connected = new Set(catalog.connected);
  const models: HarnessModel[] = [];
  const capacities = new Map<string, number>();
  const seen = new Set<string>();
  for (const provider of catalog.all) {
    if (!connected.has(provider.id)) continue;
    for (const [key, model] of Object.entries(provider.models)) {
      const modelId = `${provider.id}/${model.id}`;
      if (key !== model.id || model.providerID !== provider.id || seen.has(modelId))
        throw new HarnessAdapterError("native_catalog_binding", "OpenCode model catalog identifiers are inconsistent.");
      seen.add(modelId);
      const variants = Object.keys(model.variants ?? {});
      if (variants.length > 128 || variants.some(value => !value || value.length > 128))
        throw new HarnessAdapterError("native_catalog_limit", "OpenCode variant catalog exceeds its bounded contract.");
      models.push({id: modelId, label: model.name, capabilities: {image_input: model.capabilities.input.image,
        option_descriptors: variants.length ? [{id: "variant", label: "Variant", type: "select", values: variants.map(value => ({value, label: value}))}] : []}});
      if (model.limit?.context) capacities.set(modelId, model.limit.context);
      if (models.length > 10_000) throw new HarnessAdapterError("native_catalog_limit", "OpenCode model catalog exceeds its bounded contract.");
    }
  }
  return {models, capacities};
}
