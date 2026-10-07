import {z} from "zod";
import {harnessInputFileReferenceSchema} from "./input-file.js";

export const HARNESS_OWNED_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const HARNESS_OWNED_IMAGE_MAX_TOTAL_BYTES = 80 * 1024 * 1024;
export const HARNESS_OWNED_IMAGE_MAX_COUNT = 100;
export const HARNESS_OWNED_IMAGE_MIME_TYPES = ["image/gif", "image/jpeg", "image/png", "image/webp"] as const;
export const harnessImageFileReferenceSchema = harnessInputFileReferenceSchema.extend({
  mime_type: z.enum(HARNESS_OWNED_IMAGE_MIME_TYPES), byte_length: z.number().int().positive().max(HARNESS_OWNED_IMAGE_MAX_BYTES),
});
export const harnessImageFilesSchema = z.array(harnessImageFileReferenceSchema).min(1).max(HARNESS_OWNED_IMAGE_MAX_COUNT)
  .refine(files => files.reduce((bytes, file) => bytes + file.byte_length, 0) <= HARNESS_OWNED_IMAGE_MAX_TOTAL_BYTES, "Owned image aggregate exceeds its native delivery bound.");
export const harnessOwnedImageInputsSchema = z.object({max_bytes: z.number().int().positive().max(HARNESS_OWNED_IMAGE_MAX_BYTES),
  max_images: z.number().int().positive().max(HARNESS_OWNED_IMAGE_MAX_COUNT), max_total_bytes: z.number().int().positive().max(HARNESS_OWNED_IMAGE_MAX_TOTAL_BYTES),
  mime_types: z.array(z.enum(HARNESS_OWNED_IMAGE_MIME_TYPES)).min(1).max(4)}).strict();
export type HarnessImageFileReference = z.infer<typeof harnessImageFileReferenceSchema>;
export type HarnessOwnedImageInputs = z.infer<typeof harnessOwnedImageInputsSchema>;
