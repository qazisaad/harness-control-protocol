import {z} from "zod";
import {HarnessAdapterError, type HarnessAdapterEvent} from "../types.js";
import {retainedContent, type ContentPublisher} from "./content-projection.js";

const id = z.string().min(1).max(512);
const toolSchema = z.object({id, messageID: id, sessionID: id, type: z.literal("tool"), tool: id,
  state: z.object({status: z.enum(["pending", "running", "completed", "error"]),
    input: z.record(z.string(), z.json()).optional(), output: z.string().optional(), error: z.string().optional()})});
type Tool = {part: z.infer<typeof toolSchema>; encoded: string; emitted?: string; started: boolean; terminal: boolean};

/** Tool snapshots are attributed only after their assistant message's admitted prompt is known. */
export class OpenCodeItems {
  readonly #tools = new Map<string, Tool>();
  #bytes = 0;
  constructor(readonly sessionId: string, readonly turnId: string, readonly ownsMessage: (id: string) => boolean | undefined,
    readonly emit: (event: HarnessAdapterEvent) => void, readonly publishContent?: ContentPublisher) {}

  observe(event: {type: string; properties: Record<string, unknown>}): void {
    if (event.type === "message.updated") {
      const info = z.object({id, sessionID: id}).safeParse(event.properties.info);
      if (info.success && info.data.sessionID === this.sessionId)
        for (const tool of this.#tools.values()) if (tool.part.messageID === info.data.id) this.#publish(tool);
      return;
    }
    if (event.type !== "message.part.updated") return;
    const parsed = toolSchema.safeParse(event.properties.part);
    if (!parsed.success || parsed.data.sessionID !== this.sessionId) return;
    const part = parsed.data;
    if (this.ownsMessage(part.messageID) === false) return;
    const current = this.#tools.get(part.id);
    if (current && (current.part.messageID !== part.messageID || current.part.tool !== part.tool))
      throw new HarnessAdapterError("native_item_binding", "OpenCode changed an admitted tool's message or identity.");
    if (current?.terminal || current && ["completed", "error"].includes(current.part.state.status)) return;
    const encoded = JSON.stringify(part);
    this.#bytes += Buffer.byteLength(encoded) - Buffer.byteLength(current?.encoded ?? "");
    if (this.#bytes > 8 * 1024 * 1024 || !current && this.#tools.size >= 10_000)
      throw new HarnessAdapterError("native_item_limit", "OpenCode exceeded its bounded tool observation registry.");
    const tool = current ?? {part, encoded, started: false, terminal: false};
    tool.part = part; tool.encoded = encoded;
    this.#tools.set(part.id, tool); this.#publish(tool);
  }

  #publish(tool: Tool): void {
    if (this.ownsMessage(tool.part.messageID) !== true || tool.terminal || tool.emitted === tool.encoded) return;
    const {part} = tool;
    const finished = ["completed", "error"].includes(part.state.status);
    const data = {item_id: part.id, item_type: "tool_call", summary: part.tool,
      status: part.state.status === "error" ? "failed" : part.state.status,
      content: retainedContent({arguments: part.state.input ?? {}, ...(part.state.output !== undefined ? {output: part.state.output} : {}),
        ...(part.state.error ? {error: part.state.error} : {})}, this.publishContent)};
    this.emit({event_type: finished ? "item.completed" : tool.started ? "item.updated" : "item.started", turn_id: this.turnId, data});
    tool.started = true; tool.terminal = finished; tool.emitted = tool.encoded;
  }
}
