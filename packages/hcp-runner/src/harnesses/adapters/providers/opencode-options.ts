import {z} from "zod";
import type {HarnessModel, HarnessModelSelection} from "@harness-control/protocol";
import {HarnessAdapterError} from "../types.js";
import {projectOpenCodeCatalog} from "./opencode-models.js";

const identity = z.string().min(1).max(512);
const model = z.object({providerID: identity, modelID: identity});
const user = z.object({info: z.object({id: identity, sessionID: identity, role: z.literal("user"),
  model, variant: z.string().min(1).max(128).nullish()})});
const assistant = z.object({id: identity, sessionID: identity, parentID: identity, role: z.literal("assistant"),
  providerID: identity, modelID: identity});

/** A recorded variant string alone cannot prove the native catalog supports it. */
export function assertOpenCodeModelOptions(catalog: unknown, selection: HarnessModelSelection, imageInput = false): HarnessModel {
  if ((selection.options?.length ?? 0) > 1) throw new HarnessAdapterError("unsupported_model_option", "OpenCode accepts one native variant option.");
  const selected = projectOpenCodeCatalog(catalog).models.find(model => model.id === selection.model);
  if (!selected) throw new HarnessAdapterError("unsupported_model", "The selected OpenCode model is absent from its current connected catalog.");
  for (const option of selection.options ?? []) {
    if (option.id !== "variant" || !selected.capabilities.option_descriptors.find(descriptor => descriptor.id === "variant")?.values?.some(value => value.value === option.value))
      throw new HarnessAdapterError("unsupported_model_option", "The selected OpenCode variant is absent from the current native model catalog.");
  }
  if (imageInput && !selected.capabilities.image_input)
    throw new HarnessAdapterError("unsupported_image_input", "The selected OpenCode model does not advertise native image input.");
  return selected;
}

/** Confirm both the admitted model selection and the actual native response. */
export function openCodeEffectiveOptions(admitted: unknown, response: unknown, expected: {
  sessionId: string; messageId: string; model: {providerID: string; modelID: string}; variant?: string;
}): HarnessModelSelection {
  const request = user.safeParse(admitted), result = assistant.safeParse(response);
  if (!request.success || !result.success || request.data.info.id !== expected.messageId ||
    request.data.info.sessionID !== expected.sessionId || result.data.sessionID !== expected.sessionId ||
    result.data.parentID !== expected.messageId || request.data.info.model.providerID !== expected.model.providerID ||
    request.data.info.model.modelID !== expected.model.modelID || result.data.providerID !== expected.model.providerID ||
    result.data.modelID !== expected.model.modelID || expected.variant !== undefined && request.data.info.variant !== expected.variant)
    throw new HarnessAdapterError("native_settings_mismatch", "OpenCode did not confirm the admitted root model/options and native response.");
  return {model: `${result.data.providerID}/${result.data.modelID}`,
    options: request.data.info.variant ? [{id: "variant", value: request.data.info.variant}] : []};
}
