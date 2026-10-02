import { z } from "zod";

export const NATIVE_REVIEW_MAX_ACTION_BYTES = 48 * 1024;
/** Credential-free presentation; the executable request remains owned by its native adapter. */
export const nativeReviewActionSchema = z.object({
  kind: z.literal("native_operation"), operation: z.enum(["command", "file_change"]),
  details: z.record(z.string(), z.json()),
}).strict();
export type NativeReviewAction = z.infer<typeof nativeReviewActionSchema>;
export function nativeReviewActionBytes(json: string): Uint8Array {
  const bytes = new TextEncoder().encode(json);
  if (!bytes.length || bytes.length > NATIVE_REVIEW_MAX_ACTION_BYTES) throw new Error("Native review action exceeds its UTF-8 limit.");
  nativeReviewActionSchema.parse(JSON.parse(json));
  return bytes;
}
export async function hashNativeReviewAction(json: string): Promise<string> {
  const bytes = nativeReviewActionBytes(json);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)))].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
