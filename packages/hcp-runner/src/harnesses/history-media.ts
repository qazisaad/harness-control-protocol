import {harnessHistoryMediaSourceSchema, type HarnessHistoryMediaSource} from "@harness-control/protocol";

type MediaKind = "image" | "file" | "audio";
/** Normalize only known native media shapes. Unknown records stay provider extensions. No file/network access occurs here. */
export function nativeHistoryMedia(input: unknown, namespace: string): {media_kind: MediaKind; source: HarnessHistoryMediaSource} | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const block = input as Record<string, unknown>;
  let mediaKind: MediaKind | undefined, candidate: unknown;
  const url = (input: unknown, metadata: {mime_type?: unknown; filename?: unknown} = {}) => {
    if (typeof input !== "string") return undefined;
    if (input.startsWith("data:")) {
      const comma = input.indexOf(","), header = comma < 0 ? undefined : /^data:([^;,]+);base64$/.exec(input.slice(0, comma));
      if (!header || (metadata.mime_type !== undefined && metadata.mime_type !== header[1])) return undefined;
      return {kind: "embedded", mime_type: header[1], ...(metadata.filename === undefined ? {} : {filename: metadata.filename}), data_base64: input.slice(comma + 1)};
    }
    return {kind: "url", url: input, ...metadata};
  };
  if (namespace === "codex") {
    if (block.type === "image" || block.type === "audio") {
      mediaKind = block.type;
      candidate = block.url === undefined && block.type === "image" && typeof block.fileId === "string"
        ? {kind: "native_reference", reference: block.fileId} : url(block.url);
    } else if (block.type === "localImage" || block.type === "localAudio") {
      mediaKind = block.type === "localImage" ? "image" : "audio";candidate = {kind: "path", path: block.path};
    }
  } else if (namespace === "claude" && (block.type === "image" || block.type === "document")) {
    mediaKind = block.type === "image" ? "image" : "file";
    const source = block.source;
    if (source && typeof source === "object" && !Array.isArray(source)) {
      const native = source as Record<string, unknown>;
      if (native.type === "base64") candidate = {kind: "embedded", mime_type: native.media_type, data_base64: native.data};
      else if (native.type === "url") candidate = url(native.url);
    }
  } else if (namespace === "opencode" && block.type === "file") {
    mediaKind = typeof block.mime === "string" && block.mime.startsWith("image/") ? "image"
      : typeof block.mime === "string" && block.mime.startsWith("audio/") ? "audio" : "file";
    candidate = url(block.url, {...(block.mime === undefined ? {} : {mime_type: block.mime}), ...(block.filename === undefined ? {} : {filename: block.filename})});
  }
  if (!mediaKind) return undefined;
  const source = harnessHistoryMediaSourceSchema.safeParse(candidate);
  return source.success ? {media_kind: mediaKind, source: source.data} : undefined;
}
