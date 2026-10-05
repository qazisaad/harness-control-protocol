import {z} from "zod";
import type {HarnessAdapterEvent} from "../types.js";
import {HarnessAdapterError} from "../types.js";
import {textChunks} from "./content-projection.js";

const id = z.string().min(1).max(512);
const partSchema = z.object({id, messageID: id, sessionID: id, type: z.enum(["text", "reasoning"]), text: z.string().optional()});
type Part = z.infer<typeof partSchema> & {text: string; emitted: number};

/** Projects legacy snapshots and modern deltas only after native message ownership is confirmed. */
export class OpenCodeText {
  readonly #owners = new Map<string, boolean>();
  readonly #parts = new Map<string, Part>();
  #bytes = 0;
  constructor(readonly sessionId: string, readonly promptId: string, readonly turnId: string,
    readonly emit: (event: HarnessAdapterEvent) => void) {}

  observe(event: {type: string; properties: Record<string, unknown>}): void {
    if (event.type === "message.updated") {
      const parsed = z.object({id, sessionID: id, role: z.string(), parentID: id.optional()}).safeParse(event.properties.info);
      if (!parsed.success || parsed.data.sessionID !== this.sessionId || parsed.data.role !== "assistant" || !parsed.data.parentID) return;
      const owned = parsed.data.parentID === this.promptId;
      const previous = this.#owners.get(parsed.data.id);
      if (previous !== undefined && previous !== owned) throw new HarnessAdapterError("native_message_binding", "OpenCode changed a native message's root ownership.");
      this.#owners.set(parsed.data.id, owned);
      for (const part of this.#parts.values()) if (part.messageID === parsed.data.id) this.#publish(part);
    } else if (event.type === "message.part.updated") {
      const parsed = partSchema.safeParse(event.properties.part);
      if (!parsed.success || parsed.data.sessionID !== this.sessionId) return;
      const current = this.#parts.get(parsed.data.id);
      if (current && (current.messageID !== parsed.data.messageID || current.type !== parsed.data.type))
        throw new HarnessAdapterError("native_part_binding", "OpenCode changed a native part's message or type.");
      const part = current ?? {...parsed.data, text: "", emitted: 0};
      const snapshot = parsed.data.text;
      if (snapshot !== undefined) {
        if (snapshot.startsWith(part.text)) this.#replace(part, snapshot);
        else if (!part.text.startsWith(snapshot)) throw new HarnessAdapterError("native_text_conflict", "OpenCode rewrote streamed text without a portable replacement operation.");
      } else if (typeof event.properties.delta === "string") this.#replace(part, part.text + event.properties.delta);
      this.#parts.set(part.id, part); this.#publish(part);
    } else if (event.type === "message.part.delta") {
      const parsed = z.object({sessionID: id, messageID: id, partID: id, field: z.string(), delta: z.string()}).safeParse(event.properties);
      if (!parsed.success || parsed.data.sessionID !== this.sessionId || parsed.data.field !== "text") return;
      if (this.#owners.get(parsed.data.messageID) === false) return;
      const part = this.#parts.get(parsed.data.partID);
      if (!part) throw new HarnessAdapterError("native_part_binding", "OpenCode emitted a delta without its part metadata.");
      if (part.messageID !== parsed.data.messageID) throw new HarnessAdapterError("native_part_binding", "OpenCode emitted another message's part delta.");
      this.#replace(part, part.text + parsed.data.delta); this.#publish(part);
    }
    if (this.#parts.size + this.#owners.size > 10_000) throw new HarnessAdapterError("native_text_limit", "OpenCode exceeded its bounded text ownership registry.");
  }

  #replace(part: Part, text: string): void {
    this.#bytes += Buffer.byteLength(text) - Buffer.byteLength(part.text);
    if (this.#bytes > 8 * 1024 * 1024) throw new HarnessAdapterError("native_text_limit", "OpenCode exceeded its bounded native text retention.");
    part.text = text;
  }
  #publish(part: Part): void {
    if (this.#owners.get(part.messageID) !== true) return;
    for (const delta of textChunks(part.text.slice(part.emitted))) this.emit({event_type: part.type === "reasoning" ? "reasoning.delta" : "content.delta",
      turn_id: this.turnId, data: {item_id: part.id, message_id: part.messageID, delta}});
    part.emitted = part.text.length;
  }
}
