import {harnessTurnFinalOutputSchema, harnessContentReferenceSchema, type HarnessTurnFinalOutput, type HarnessContentReference} from "@harness-control/protocol";
import {HcpContentReadError, type HcpCompleteContent, type CompleteContentOptions} from "./content.js";

export type HcpResolvedFinalText = {source: ReturnType<typeof harnessTurnFinalOutputSchema.parse>} & (
  {availability: "complete"; final_text: string} | {availability: "unavailable" | "unconfirmed"});
export class HcpFinalTextReadError extends Error {
  constructor() {super("The native final-text evidence is conflicting or unsupported."); this.name = "HcpFinalTextReadError";}
}
/** Complete root output has no fabricated native message/item identity. Legacy display text remains unconfirmed. */
export async function resolveHcpFinalText(output: HarnessTurnFinalOutput | HcpResolvedFinalText["source"],
  read: (reference: HarnessContentReference, options: CompleteContentOptions) => Promise<HcpCompleteContent>, options: CompleteContentOptions = {}): Promise<HcpResolvedFinalText> {
  options.signal?.throwIfAborted();
  const source = harnessTurnFinalOutputSchema.parse(structuredClone(output));
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 8 * 1024 * 1024) throw new HcpContentReadError("limit");
  const encoder = new TextEncoder();
  if (source.final_text_ref) {
    const reference = source.final_text_ref;
    if (reference.byte_length > maxBytes) throw new HcpContentReadError("limit");
    const full = await read({...reference}, {...options, maxBytes});
    options.signal?.throwIfAborted();
    if (JSON.stringify(harnessContentReferenceSchema.parse(full.reference)) !== JSON.stringify(reference) || full.format !== reference.format)
      throw new HcpContentReadError("reference_changed");
    const text = full.format === "text" ? full.text : full.value;
    if (typeof text !== "string") throw new HcpFinalTextReadError();
    const bytes = encoder.encode(full.format === "text" ? text : JSON.stringify(text)).byteLength;
    if (bytes > reference.byte_length || bytes > maxBytes) throw new HcpContentReadError("limit");
    if (source.final_text_truncated === false && source.final_text !== undefined && source.final_text !== text) throw new HcpFinalTextReadError();
    return {source, availability: "complete", final_text: text};
  }
  if (source.final_text_truncated === false && source.final_text !== undefined) {
    if (encoder.encode(source.final_text).byteLength > maxBytes) throw new HcpContentReadError("limit");
    return {source, availability: "complete", final_text: source.final_text};
  }
  return {source, availability: source.final_text_truncated === true || source.final_text === undefined ? "unavailable" : "unconfirmed"};
}
