import {z} from "zod";

export const HARNESS_CONTENT_MAX_BYTES = 128 * 1024 * 1024;
export const HARNESS_CONTENT_STORE_MAX_BYTES = 512 * 1024 * 1024;
export const harnessContentReferenceSchema = z.object({content_id: z.string().regex(/^[a-f0-9]{64}$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), byte_length: z.number().int().nonnegative().max(HARNESS_CONTENT_MAX_BYTES),
  format: z.enum(["text", "json"]), expires_at: z.string().datetime({offset: true})}).strict();
export const harnessContentChunkSchema = z.object({reference: harnessContentReferenceSchema,
  offset: z.number().int().nonnegative().max(HARNESS_CONTENT_MAX_BYTES),
  data_base64: z.string().max(87384).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?$/),
  next_offset: z.number().int().nonnegative().max(HARNESS_CONTENT_MAX_BYTES).optional()}).strict().superRefine((chunk, context) => {
    const padding = chunk.data_base64.endsWith("==") ? 2 : chunk.data_base64.endsWith("=") ? 1 : 0;
    const size = chunk.data_base64.length / 4 * 3 - padding;
    const end = chunk.offset + size;
    if (size > 64 * 1024 || end > chunk.reference.byte_length)
      context.addIssue({code: "custom", path: ["data_base64"], message: "Content chunks must remain within their 64 KiB limit and retained length."});
    if (end < chunk.reference.byte_length ? !size || chunk.next_offset !== end : chunk.next_offset !== undefined)
      context.addIssue({code: "custom", path: ["next_offset"], message: "Content continuation must advance exactly to the end of a nonterminal chunk."});
  });
export type HarnessContentReference = z.infer<typeof harnessContentReferenceSchema>;
export type HarnessContentChunk = z.infer<typeof harnessContentChunkSchema>;
