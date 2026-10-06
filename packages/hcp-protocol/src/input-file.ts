import {z} from "zod";

export const HARNESS_INPUT_FILE_MAX_BYTES = 32 * 1024 * 1024;
export const HARNESS_INPUT_FILE_CHUNK_BYTES = 64 * 1024;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const harnessInputFileReferenceSchema = z.object({file_id: digest, sha256: digest,
  filename: z.string().min(1).max(255).regex(/^(?!\.{1,2}$)[^\x00-\x1f\x7f/\\]+$/),
  mime_type: z.string().regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/).max(255),
  byte_length: z.number().int().min(0).max(HARNESS_INPUT_FILE_MAX_BYTES)}).strict();
export const harnessInputFileOperationSchema = z.object({kind: z.literal("input_file"), request: z.discriminatedUnion("action", [
  z.object({action: z.literal("create"), ...harnessInputFileReferenceSchema.omit({file_id: true}).shape}).strict(),
  z.object({action: z.literal("append"), file_id: digest, offset: z.number().int().nonnegative(),
    data_base64: z.string().min(4).max(4 * Math.ceil(HARNESS_INPUT_FILE_CHUNK_BYTES / 3))
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
      .refine(value => value.length / 4 * 3 - (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0) <= HARNESS_INPUT_FILE_CHUNK_BYTES)}).strict(),
  z.object({action: z.literal("seal"), file_id: digest}).strict(),
  z.object({action: z.literal("read"), file_id: digest}).strict(),
  z.object({action: z.literal("release"), file_id: digest}).strict(),
])}).strict();
export const harnessInputFileResultSchema = z.object({action: z.enum(["create", "append", "seal", "read", "release"]), reference: harnessInputFileReferenceSchema,
  received_bytes: z.number().int().nonnegative().max(HARNESS_INPUT_FILE_MAX_BYTES),
  state: z.enum(["uploading", "sealed", "retained", "released"])}).strict().superRefine((value, context) => {
    if (value.received_bytes > value.reference.byte_length ||
      (["sealed", "retained"].includes(value.state) && value.received_bytes !== value.reference.byte_length) ||
      ((value.action === "release") !== (value.state === "released")) ||
      (value.action === "seal" && !["sealed", "retained"].includes(value.state)))
      context.addIssue({code: "custom", message: "File result state must confirm the requested action and declared byte length."});
  });
export const harnessTurnFilesSchema = z.array(z.object({reference: harnessInputFileReferenceSchema,
  delivery: z.enum(["file_context", "native"])}).strict()).max(8);
/** File context provides a readable workspace file; it makes no claim about native multimodal decoding. */
export const harnessFileInputCapabilitiesSchema = z.object({delivery: z.array(z.enum(["file_context", "native"])).min(1).max(2),
  max_bytes: z.number().int().positive().max(HARNESS_INPUT_FILE_MAX_BYTES), max_files: z.number().int().min(1).max(8)}).strict();
export type HarnessInputFileReference = z.infer<typeof harnessInputFileReferenceSchema>;
export type HarnessInputFileOperation = z.infer<typeof harnessInputFileOperationSchema>;
export type HarnessInputFileResult = z.infer<typeof harnessInputFileResultSchema>;
export type HarnessTurnFile = z.infer<typeof harnessTurnFilesSchema>[number];
