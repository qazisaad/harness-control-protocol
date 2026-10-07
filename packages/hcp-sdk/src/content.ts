import {HARNESS_CONTENT_MAX_BYTES, harnessContentChunkSchema, harnessContentReferenceSchema, type HarnessContentChunk, type HarnessContentReference} from "@harness-control/protocol";

export type CompleteContentOptions = {maxBytes?: number; maxChunks?: number; chunkSize?: number; timeoutMs?: number; signal?: AbortSignal};
export type HcpCompleteContent = {reference: HarnessContentReference; format: "text"; text: string} |
  {reference: HarnessContentReference; format: "json"; value: unknown};
export class HcpContentReadError extends Error {
  constructor(readonly reason: "limit" | "reference_changed" | "offset_changed" | "integrity" | "invalid_utf8" | "invalid_json" | "verification_unavailable") {
    super(`HCP complete content read failed: ${reason}.`);this.name = "HcpContentReadError";
  }
}

/** Verify a bounded immutable object before decoding; previews never substitute for missing chunks. */
export async function readHcpContent(reference: HarnessContentReference,
  read: (offset: number, limit: number, wait: {timeoutMs?: number; signal?: AbortSignal}) => Promise<HarnessContentChunk>, options: CompleteContentOptions = {}): Promise<HcpCompleteContent> {
  options.signal?.throwIfAborted();
  const expected = harnessContentReferenceSchema.parse(reference);
  const maxBytes = options.maxBytes ?? HARNESS_CONTENT_MAX_BYTES, maxChunks = options.maxChunks ?? 2048, chunkSize = options.chunkSize ?? 64 * 1024;
  for (const [value, maximum] of [[maxBytes, HARNESS_CONTENT_MAX_BYTES], [maxChunks, 8192], [chunkSize, 64 * 1024]] as const)
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new HcpContentReadError("limit");
  if (expected.byte_length > maxBytes || Math.max(1, Math.ceil(expected.byte_length / chunkSize)) > maxChunks) throw new HcpContentReadError("limit");
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new HcpContentReadError("verification_unavailable");
  const bytes = new Uint8Array(expected.byte_length);
  let offset = 0, complete = false;
  for (let count = 0; count < maxChunks; count++) {
    options.signal?.throwIfAborted();
    const chunk = harnessContentChunkSchema.parse(await read(offset, chunkSize,
      {...(options.signal ? {signal: options.signal} : {}), ...(options.timeoutMs === undefined ? {} : {timeoutMs: options.timeoutMs})}));
    options.signal?.throwIfAborted();
    if (JSON.stringify(chunk.reference) !== JSON.stringify(expected)) throw new HcpContentReadError("reference_changed");
    if (chunk.offset !== offset) throw new HcpContentReadError("offset_changed");
    const decoded = Uint8Array.from(atob(chunk.data_base64), character => character.charCodeAt(0));
    if (decoded.length > chunkSize) throw new HcpContentReadError("limit");
    bytes.set(decoded, offset);offset += decoded.length;
    if (chunk.next_offset === undefined) {complete = true;break;}
  }
  if (!complete || offset !== expected.byte_length) throw new HcpContentReadError("limit");
  let digest: ArrayBuffer;
  try {digest = await subtle.digest("SHA-256", bytes);} catch {throw new HcpContentReadError("verification_unavailable");}
  options.signal?.throwIfAborted();
  if (Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("") !== expected.sha256) throw new HcpContentReadError("integrity");
  let text: string;
  try {text = new TextDecoder("utf-8", {fatal: true, ignoreBOM: true}).decode(bytes);} catch {throw new HcpContentReadError("invalid_utf8");}
  if (expected.format === "text") return {reference: expected, format: "text", text};
  try {return {reference: expected, format: "json", value: JSON.parse(text)};} catch {throw new HcpContentReadError("invalid_json");}
}
