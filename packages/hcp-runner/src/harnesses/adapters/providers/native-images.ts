import {createHash} from "node:crypto";
import {hcpImageInputSchema, harnessImageFilesSchema, HARNESS_OWNED_IMAGE_MAX_COUNT, HARNESS_OWNED_IMAGE_MAX_TOTAL_BYTES, HARNESS_OWNED_IMAGE_MAX_BYTES, HARNESS_OWNED_IMAGE_MIME_TYPES,
  type HcpImageInput} from "@harness-control/protocol";
import {HarnessAdapterError, type HarnessAdapterTurnInput} from "../types.js";

/** Native transport may carry already resolved image bytes beyond the inline HCP wire limit. */
export function validateNativeImageValues(input: readonly unknown[]): HcpImageInput[] {
  try {
    if (input.length > HARNESS_OWNED_IMAGE_MAX_COUNT) throw new Error("Image count exceeded.");
    let total = 0;
    return input.map(value => {
      if (!value || typeof value !== "object" || !("mime_type" in value) || !("data_base64" in value)) throw new Error("Invalid native image.");
      const mime = HARNESS_OWNED_IMAGE_MIME_TYPES.find(type => type === value.mime_type), data = value.data_base64;
      if (!mime || typeof data !== "string" || data.length < 4 || data.length > 4 * Math.ceil(HARNESS_OWNED_IMAGE_MAX_BYTES / 3)) throw new Error("Invalid native image.");
      const bytes = Buffer.from(data, "base64");total += bytes.byteLength;
      if (!bytes.byteLength || bytes.byteLength > HARNESS_OWNED_IMAGE_MAX_BYTES || total > HARNESS_OWNED_IMAGE_MAX_TOTAL_BYTES || bytes.toString("base64") !== data)
        throw new Error("Invalid native image.");
      return {mime_type: mime, data_base64: data};
    });
  } catch {throw new HarnessAdapterError("image_input_invalid", "Native image bytes are invalid or exceed their declared bound.");}
}

/** Wire previews are never image bodies. Owned bytes require exact sealed references supplied by the manager. */
export function nativeTurnImages(input: Pick<HarnessAdapterTurnInput, "payload" | "inputFileImages">): HcpImageInput[] {
  try {
    const images = (input.payload.images ?? []).map(image => hcpImageInputSchema.parse(image));
    const owned = input.inputFileImages ?? [];
    if (input.payload.image_files?.length && !owned.length) throw new Error("Owned image bytes have not been resolved.");
    if (owned.length) {
      const references = harnessImageFilesSchema.parse(owned.map(image => image.reference));
      if (JSON.stringify(references) !== JSON.stringify(input.payload.image_files)) throw new Error("Owned image reference changed.");
      for (const image of owned) {
        const bytes = Buffer.from(image.data_base64, "base64");
        if (bytes.byteLength !== image.reference.byte_length || bytes.toString("base64") !== image.data_base64 ||
            createHash("sha256").update(bytes).digest("hex") !== image.reference.sha256) throw new Error("Owned image integrity changed.");
        images.push({mime_type: image.reference.mime_type, data_base64: image.data_base64});
      }
    }
    const bytes = images.reduce((sum, image) => sum + image.data_base64.length / 4 * 3 - (image.data_base64.endsWith("==") ? 2 : image.data_base64.endsWith("=") ? 1 : 0), 0);
    if (images.length > HARNESS_OWNED_IMAGE_MAX_COUNT || bytes > HARNESS_OWNED_IMAGE_MAX_TOTAL_BYTES) throw new Error("Combined image limits exceeded.");
    return validateNativeImageValues(images);
  } catch {throw new HarnessAdapterError("image_input_invalid", "Native images require exact bounded inline input or verified owned image bytes.");}
}
