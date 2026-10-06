import {z} from "zod";
import {harnessContentReferenceSchema} from "./content.js";

/** Native output with verified session ownership but no proven app-turn correlation. */
export const harnessNativeOutputObservationSchema = z.object({source: z.literal("native"),
  native_source: z.string().min(1).max(128), item_id: z.string().min(1).max(512),
  scope: z.literal("session"), correlation: z.literal("unattributed"), item_type: z.literal("assistant_message"),
  content_ref: harnessContentReferenceSchema}).strict();
export type HarnessNativeOutputObservation = z.infer<typeof harnessNativeOutputObservationSchema>;
