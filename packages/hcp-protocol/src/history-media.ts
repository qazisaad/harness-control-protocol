import {z} from "zod";
import {HARNESS_INPUT_FILE_MAX_BYTES} from "./input-file.js";

const mime = z.string().regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/).max(255);
const metadata = {mime_type: mime.optional(), filename: z.string().min(1).max(255).optional()};
/** Observed display sources are not input-file custody, filesystem grants or fetch authorization. */
export const harnessHistoryMediaSourceSchema = z.discriminatedUnion("kind", [
  z.object({kind: z.literal("embedded"), mime_type: mime, filename: metadata.filename,
    data_base64: z.string().max(4 * Math.ceil(HARNESS_INPUT_FILE_MAX_BYTES / 3)).regex(/^[A-Za-z0-9+/]*={0,2}$/)
      .refine(value => value.length % 4 === 0 && value.length > 0 &&
        value.length / 4 * 3 - (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0) <= HARNESS_INPUT_FILE_MAX_BYTES &&
        (!value.endsWith("==") || /[AQgw]==$/.test(value)) && (!value.endsWith("=") || value.endsWith("==") || /[AEIMQUYcgkosw048]=$/.test(value)),
        "Embedded media must contain bounded canonical base64.")}).strict(),
  z.object({kind: z.literal("url"), ...metadata, url: z.string().min(1).max(8192).url()
    .refine(value => /^https?:\/\//i.test(value), "Media URLs must use HTTP or HTTPS.")}).strict(),
  z.object({kind: z.literal("path"), ...metadata, path: z.string().min(1).max(4096).regex(/^[^\x00]+$/)}).strict(),
  z.object({kind: z.literal("native_reference"), ...metadata, reference: z.string().min(1).max(512)}).strict(),
]);
export type HarnessHistoryMediaSource = z.infer<typeof harnessHistoryMediaSourceSchema>;
