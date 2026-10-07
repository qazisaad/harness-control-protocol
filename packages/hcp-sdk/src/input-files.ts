import {HARNESS_INPUT_FILE_MAX_BYTES, HARNESS_INPUT_FILE_CHUNK_BYTES, harnessInputFileOperationSchema,
  harnessInputFileReferenceSchema, harnessInputFileResultSchema, type HarnessInputFileOperation, type HarnessInputFileReference,
  type HarnessInputFileResult, harnessImageFileReferenceSchema, HARNESS_OWNED_IMAGE_MAX_BYTES, type HarnessImageFileReference} from "@harness-control/protocol";

export type InputFileUploadOptions = {maxBytes?: number; chunkSize?: number; timeoutMs?: number; signal?: AbortSignal};
export type HcpInputFileUpload = {filename: string; mime_type: string; bytes: Uint8Array};
type Request = HarnessInputFileOperation["request"];
export class HcpInputFileUploadError extends Error {
  readonly reference?: HarnessInputFileReference;
  constructor(readonly reason: "limit" | "verification_unavailable" | "result_changed" | "unconfirmed", readonly phase: "prepare" | Request["action"],
    reference?: HarnessInputFileReference, cause?: unknown) {
    super(`HCP input-file upload failed: ${reason} at ${phase}.`, {cause});this.name = "HcpInputFileUploadError";
    if (reference) this.reference = structuredClone(reference);
  }
}
/** Upload immutable bytes once. Failed mutations are never replayed or implicitly released; a known reference supports explicit reconciliation. */
export async function uploadHcpInputFile(input: HcpInputFileUpload,
  perform: (request: Request, wait: {timeoutMs?: number; signal?: AbortSignal}) => Promise<HarnessInputFileResult>,
  options: InputFileUploadOptions = {}): Promise<{reference: HarnessInputFileReference; result: HarnessInputFileResult}> {
  options.signal?.throwIfAborted();
  const maxBytes = options.maxBytes ?? HARNESS_INPUT_FILE_MAX_BYTES, chunkSize = options.chunkSize ?? HARNESS_INPUT_FILE_CHUNK_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > HARNESS_INPUT_FILE_MAX_BYTES || !Number.isSafeInteger(chunkSize) ||
      chunkSize < 1 || chunkSize > HARNESS_INPUT_FILE_CHUNK_BYTES || !(input.bytes instanceof Uint8Array) || input.bytes.byteLength > maxBytes || Math.ceil(input.bytes.byteLength / chunkSize) > 8192)
    throw new HcpInputFileUploadError("limit", "prepare");
  const metadata = {filename: input.filename, mime_type: input.mime_type, byte_length: input.bytes.byteLength};
  harnessInputFileReferenceSchema.omit({file_id: true}).parse({...metadata, sha256: "0".repeat(64)});
  const bytes = new Uint8Array(input.bytes), subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new HcpInputFileUploadError("verification_unavailable", "prepare");
  let digest: ArrayBuffer;
  try {digest = await subtle.digest("SHA-256", bytes);} catch (cause) {throw new HcpInputFileUploadError("verification_unavailable", "prepare", undefined, cause);}
  options.signal?.throwIfAborted();
  const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  let reference: HarnessInputFileReference | undefined;
  const request = async (data: Request, received: number, states: HarnessInputFileResult["state"][]) => {
    try {
      options.signal?.throwIfAborted();
      const parsed = harnessInputFileOperationSchema.parse({kind: "input_file", request: data});
      const result = harnessInputFileResultSchema.parse(await perform(parsed.request, {
        ...(options.signal ? {signal: options.signal} : {}), ...(options.timeoutMs === undefined ? {} : {timeoutMs: options.timeoutMs})}));
      options.signal?.throwIfAborted();
      const identityChanged = reference ? JSON.stringify(result.reference) !== JSON.stringify(reference) :
        result.reference.sha256 !== sha256 || result.reference.filename !== metadata.filename ||
        result.reference.mime_type !== metadata.mime_type || result.reference.byte_length !== metadata.byte_length;
      if (result.action !== data.action || result.received_bytes !== received || !states.includes(result.state) || identityChanged)
        throw new HcpInputFileUploadError("result_changed", data.action, reference);
      return result;
    } catch (cause) {
      if (cause instanceof HcpInputFileUploadError) throw cause;
      throw new HcpInputFileUploadError("unconfirmed", data.action, reference, cause);
    }
  };
  const created = await request({action: "create", ...metadata, sha256}, 0, ["uploading"]);
  reference = {...created.reference};
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    const part = bytes.subarray(offset, Math.min(bytes.byteLength, offset + chunkSize));
    const encoded = btoa(Array.from(part, byte => String.fromCharCode(byte)).join(""));
    await request({action: "append", file_id: reference.file_id, offset, data_base64: encoded}, offset + part.byteLength, ["uploading"]);
  }
  const result = await request({action: "seal", file_id: reference.file_id}, bytes.byteLength, ["sealed", "retained"]);
  return {reference: {...reference}, result};
}

/** Owned images retain exact bytes and a typed MIME/size reference; upload alone does not establish model decoding support. */
export async function uploadHcpImageFile(input: HcpInputFileUpload,
  perform: Parameters<typeof uploadHcpInputFile>[1], options: InputFileUploadOptions = {}): Promise<{reference: HarnessImageFileReference; result: HarnessInputFileResult}> {
  harnessImageFileReferenceSchema.omit({file_id: true, sha256: true}).parse({filename: input.filename, mime_type: input.mime_type, byte_length: input.bytes.byteLength});
  const upload = await uploadHcpInputFile(input, perform, {...options, maxBytes: options.maxBytes ?? HARNESS_OWNED_IMAGE_MAX_BYTES});
  return {reference: harnessImageFileReferenceSchema.parse(upload.reference), result: upload.result};
}
