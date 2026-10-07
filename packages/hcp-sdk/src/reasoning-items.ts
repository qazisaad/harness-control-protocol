import type {HarnessNativeTextPartReference, HarnessNativeReasoningContent, HarnessContentReference} from "@harness-control/protocol";
import {projectNativeParts} from "./native-parts.js";
export type HcpReasoningSegment = {kind: "summary" | "content" | "unspecified"; index?: number; text: string};
export type HcpReasoningItem = {origin_turn_id: string; item_id?: string; message_id?: string; native_execution_reference?: string;
  native_part?: HarnessNativeTextPartReference; segments: HcpReasoningSegment[]; completed: boolean;
  first_observed_at: string; last_observed_at: string; completed_at?: string;
  /** Native completion may replace previews. Absence means no authoritative completed body. */
  completed_content?: string | HarnessNativeReasoningContent | {truncated: true; summary: string; content_ref?: HarnessContentReference}};
export class HcpReasoningProjectionError extends Error {
  constructor() {super("Conflicting, unsupported or unbounded native reasoning evidence.");this.name = "HcpReasoningProjectionError";}
}

/** Native item/block evidence from a bounded slice. Completion of an item is not execution closure. */
export function projectHcpReasoningItems(inputs: readonly unknown[], sessionId: string, origin?: string): HcpReasoningItem[] {
  return projectNativeParts(inputs, sessionId, origin, "reasoning", () => new HcpReasoningProjectionError());
}
