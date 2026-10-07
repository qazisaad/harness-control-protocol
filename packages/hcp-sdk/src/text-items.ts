import type {HarnessNativeTextPartReference, HarnessContentReference} from "@harness-control/protocol";
import {projectNativeParts} from "./native-parts.js";

export type HcpTextItem = {origin_turn_id: string; item_id?: string; message_id?: string; native_execution_reference?: string;
  native_part?: HarnessNativeTextPartReference; streamed_text: string; completed: boolean;
  first_observed_at: string; last_observed_at: string; completed_at?: string;
  completed_content?: string | {truncated: true; summary: string; content_ref?: HarnessContentReference}};
export class HcpTextProjectionError extends Error {
  constructor() {super("Conflicting, unsupported or unbounded native text evidence."); this.name = "HcpTextProjectionError";}
}
/** Group only actual native item/block coordinates. Streamed text does not substitute for a completed native body. */
export function projectHcpTextItems(inputs: readonly unknown[], sessionId: string, origin?: string): HcpTextItem[] {
  return projectNativeParts(inputs, sessionId, origin, "text", () => new HcpTextProjectionError()).map(({segments, completed_content, ...source}) => {
    if (completed_content !== undefined && typeof completed_content !== "string" && !("truncated" in completed_content)) throw new HcpTextProjectionError();
    return {...source, streamed_text: segments.map(segment => segment.text).join(""), ...(completed_content === undefined ? {} : {completed_content})};
  });
}
