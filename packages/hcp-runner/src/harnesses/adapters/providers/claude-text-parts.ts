import {retainedContent, type ContentPublisher} from "./content-projection.js";
import type {HarnessNativeTextPartReference} from "@harness-control/protocol";
import {z} from "zod";
import {HarnessAdapterError} from "../types.js";
const index = z.number().int().min(0).max(4095);
const identity = z.string().min(1).max(512);
const delta = z.object({type: z.literal("content_block_delta"), index: index.optional(), delta: z.object({
  type: z.enum(["text_delta", "thinking_delta"]), text: z.string().optional(), thinking: z.string().optional()})});

type TextPartObservation = {
  kind: "text" | "thinking";
  delta?: string;
  state?: "started" | "completed";
  message_id?: string;
  native_part?: HarnessNativeTextPartReference;
};

/** Created per owned root; the caller proves root/session ownership before observing a native stream. */
export class ClaudeTextParts {
  #message: string | undefined;
  #blocks = new Map<number, {kind: string; closed: boolean}>();
  observe(input: unknown): TextPartObservation | undefined {
    const marker = z.object({type: z.string()}).safeParse(input);
    if (!marker.success) return;
    if (marker.data.type === "message_start") {
      const value = z.object({message: z.object({id: identity})}).safeParse(input);
      this.#message = value.success ? value.data.message.id : undefined;
      this.#blocks.clear(); return;
    }
    if (marker.data.type === "message_stop") {this.#message = undefined; this.#blocks.clear(); return;}
    if (marker.data.type === "content_block_stop") {
      const value = z.object({index}).safeParse(input);
      if (!value.success) return;
      const block = this.#blocks.get(value.data.index);
      if (!block || block.closed) return;
      block.closed = true;
      if (this.#message && (block.kind === "text" || block.kind === "thinking")) return {kind: block.kind, state: "completed" as const,
        message_id: this.#message, native_part: {message_reference: this.#message, index: value.data.index}};
      return;
    }
    let partIndex: number | undefined, kind: "text" | "thinking", text: string | undefined;
    if (marker.data.type === "content_block_start") {
      const value = z.object({index, content_block: z.object({type: z.string(), text: z.string().optional(), thinking: z.string().optional()})}).safeParse(input);
      if (!value.success) return;
      if (this.#blocks.has(value.data.index)) throw new HarnessAdapterError("native_text_part_binding", "Native content reused an opened block position.");
      this.#blocks.set(value.data.index, {kind: value.data.content_block.type, closed: false});
      if (!["text", "thinking"].includes(value.data.content_block.type)) return;
      partIndex = value.data.index; kind = value.data.content_block.type as "text" | "thinking";
      text = kind === "text" ? value.data.content_block.text : value.data.content_block.thinking;
    } else {
      const value = delta.safeParse(input);
      if (!value.success) return;
      partIndex = value.data.index; kind = value.data.delta.type === "text_delta" ? "text" : "thinking";
      text = kind === "text" ? value.data.delta.text : value.data.delta.thinking;
      const block = partIndex !== undefined ? this.#blocks.get(partIndex) : undefined;
      if (block && (block.closed || block.kind !== kind)) throw new HarnessAdapterError("native_text_part_binding", "Native content changed its block kind or emitted after closure.");
    }
    const state = marker.data.type === "content_block_start" ? "started" as const : undefined;
    if (!text && !(state && this.#message)) return;
    return {kind, ...(text ? {delta: text} : {}), ...(state ? {state} : {}), ...(this.#message && partIndex !== undefined ? {
      message_id: this.#message, native_part: {message_reference: this.#message, index: partIndex}} : {})};
  }
}


/** Complete assistant blocks retain their real message/index coordinates; a stream preview is never substituted. */
export function claudeCompletedTextParts(message: unknown, publish?: ContentPublisher) {
  const parsed = z.object({id: identity, content: z.array(z.unknown()).max(4096)}).safeParse(message);
  if (!parsed.success) return [];
  return parsed.data.content.flatMap((value, index) => {
    const block = z.union([z.object({type: z.literal("text"), text: z.string()}), z.object({type: z.literal("thinking"), thinking: z.string()})]).safeParse(value);
    if (!block.success) return [];
    return [{message_id: parsed.data.id, native_part: {message_reference: parsed.data.id, index}, item_type: block.data.type === "text" ? "text" : "reasoning", status: "completed",
      content: retainedContent(block.data.type === "text" ? block.data.text : block.data.thinking, publish)}];
  });
}
