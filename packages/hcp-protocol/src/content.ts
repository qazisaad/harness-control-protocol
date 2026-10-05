import {z} from "zod";

export const harnessContentReferenceSchema = z.object({content_id: z.string().regex(/^[a-f0-9]{64}$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), byte_length: z.number().int().nonnegative().max(8 * 1024 * 1024),
  format: z.enum(["text", "json"]), expires_at: z.string().datetime({offset: true})}).strict();
export const harnessContentChunkSchema = z.object({reference: harnessContentReferenceSchema,
  offset: z.number().int().nonnegative(), data_base64: z.string().max(128 * 1024), next_offset: z.number().int().nonnegative().optional()}).strict();
export type HarnessContentReference = z.infer<typeof harnessContentReferenceSchema>;
export type HarnessContentChunk = z.infer<typeof harnessContentChunkSchema>;
