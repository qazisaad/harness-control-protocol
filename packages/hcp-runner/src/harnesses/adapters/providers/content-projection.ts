import type {HarnessContentReference, HarnessTurnFinalOutput} from "@harness-control/protocol";
export type ContentPublisher = (value: unknown) => HarnessContentReference;

export function retainedContent(value: unknown, publish?: ContentPublisher): unknown {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) <= 48 * 1024) return value;
  return {truncated: true, summary: [...encoded].slice(0, 4096).join(""), ...(publish ? {content_ref: publish(value)} : {})};
}
export function retainedFinalText(text: string, publish?: ContentPublisher): Pick<HarnessTurnFinalOutput, "final_text" | "content_ref" | "final_text_truncated" | "final_text_ref"> {
  if (Buffer.byteLength(text) <= 256 * 1024) return {final_text: text, final_text_truncated: false};
  const reference = publish?.(text);
  return {final_text: [...text].slice(0, 8192).join("") + "\n[preview truncated]", final_text_truncated: true,
    ...(reference ? {content_ref: reference, final_text_ref: reference} : {})};
}
export function* textChunks(text: string): Generator<string> {
  let chunk = "", size = 0;
  for (const character of text) {
    const bytes = Buffer.byteLength(character);
    if (size + bytes > 32 * 1024) {yield chunk; chunk = ""; size = 0;}
    chunk += character; size += bytes;
  }
  if (chunk) yield chunk;
}
