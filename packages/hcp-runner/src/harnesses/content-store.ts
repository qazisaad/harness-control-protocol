import {createHash, randomUUID} from "node:crypto";
import {constants, closeSync, fstatSync, openSync, readSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync, statSync} from "node:fs";
import {join} from "node:path";
import {z} from "zod";
import {HARNESS_CONTENT_MAX_BYTES, HARNESS_CONTENT_STORE_MAX_BYTES, harnessContentReferenceSchema, type HarnessContentReference, type HarnessContentChunk} from "@harness-control/protocol";
import {HarnessAdapterError} from "./adapters/types.js";

const scopeSchema = z.object({session_id: z.string(), provider_instance_id: z.string(), provider_binding_hash: z.string(), workspace_id: z.string(), cwd: z.string()}).strict();
const metadataSchema = z.object({scope: scopeSchema, reference: harnessContentReferenceSchema}).strict();
export type HarnessContentScope = z.infer<typeof scopeSchema>;
type Metadata = z.infer<typeof metadataSchema>;
export interface HarnessContentStore {
  publish(scope: HarnessContentScope, value: unknown): HarnessContentReference;
  scope(sessionId: string, contentId: string): HarnessContentScope;
  read(sessionId: string, contentId: string, offset: number, limit: number): HarnessContentChunk;
}

/** Optional disk persistence with explicit object/store bounds; references never authorize paths. */
export class BoundedHarnessContentStore implements HarnessContentStore {
  readonly #entries = new Map<string, {metadata: Metadata; bytes?: Buffer; verifiedDiskSignature?: string}>();
  constructor(readonly directory?: string, readonly now: () => number = Date.now, readonly limits: {maxObjectBytes?: number; maxTotalBytes?: number} = {}) {
    const objectLimit = limits.maxObjectBytes ?? HARNESS_CONTENT_MAX_BYTES, totalLimit = limits.maxTotalBytes ?? HARNESS_CONTENT_STORE_MAX_BYTES;
    if (!Number.isSafeInteger(objectLimit) || objectLimit < 1 || objectLimit > HARNESS_CONTENT_MAX_BYTES ||
      !Number.isSafeInteger(totalLimit) || totalLimit < objectLimit || totalLimit > HARNESS_CONTENT_STORE_MAX_BYTES)
      throw new HarnessAdapterError("content_limit", "Invalid bounded content-store limits.");
    this.limits = Object.freeze({maxObjectBytes: objectLimit, maxTotalBytes: totalLimit});
    if (directory && existsSync(directory)) for (const file of readdirSync(directory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
      try {
        const metadata = metadataSchema.parse(JSON.parse(readFileSync(join(directory, file), "utf8")));
        if (file !== `${metadata.reference.content_id}.json`) continue;
        if (statSync(join(directory, `${metadata.reference.content_id}.bin`)).size !== metadata.reference.byte_length) continue;
        this.#entries.set(metadata.reference.content_id, {metadata});
      } catch { /* Corrupt or foreign files are not usable content references. */ }
    }
    // A crash between the two writes must not leave unaccounted bodies outside the disk quota.
    if (directory && existsSync(directory)) for (const file of readdirSync(directory)) {
      const match = /^([a-f0-9]{64})\.(json|bin)$/.exec(file);
      if (match && !this.#entries.has(match[1]!)) unlinkSync(join(directory, file));
    }
    this.#prune(0);
  }
  publish(scope: HarnessContentScope, value: unknown): HarnessContentReference {
    let encoded: string | undefined;
    try {encoded = typeof value === "string" ? value : JSON.stringify(value);}
    catch {throw new HarnessAdapterError("content_invalid", "Retained content must be text or serializable JSON.");}
    if (encoded === undefined) throw new HarnessAdapterError("content_invalid", "Retained content must be text or serializable JSON.");
    const bytes = Buffer.from(encoded, "utf8");
    if (bytes.length > (this.limits.maxObjectBytes ?? HARNESS_CONTENT_MAX_BYTES)) throw new HarnessAdapterError("content_limit", "Native content exceeds the declared object retention limit.");
    this.#prune(bytes.length);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const contentId = createHash("sha256").update(scope.session_id).update(randomUUID()).digest("hex");
    const reference: HarnessContentReference = {content_id: contentId, sha256, byte_length: bytes.length,
      format: typeof value === "string" ? "text" : "json", expires_at: new Date(this.now() + 24 * 60 * 60_000).toISOString()};
    const metadata = metadataSchema.parse({scope, reference});
    if (this.directory) {
      mkdirSync(this.directory, {recursive: true, mode: 0o700});
      try {
        writeFileSync(join(this.directory, `${contentId}.bin`), bytes, {mode: 0o600});
        writeFileSync(join(this.directory, `${contentId}.json`), JSON.stringify(metadata), {mode: 0o600});
      } catch (error) {
        for (const suffix of ["bin", "json"]) {
          const file = join(this.directory, `${contentId}.${suffix}`);
          if (existsSync(file)) unlinkSync(file);
        }
        throw error;
      }
    }
    this.#entries.set(contentId, {metadata, ...(!this.directory ? {bytes} : {})});
    return reference;
  }
  scope(sessionId: string, contentId: string): HarnessContentScope {return {...this.#require(sessionId, contentId).metadata.scope};}
  read(sessionId: string, contentId: string, offset: number, limit: number): HarnessContentChunk {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 64 * 1024)
      throw new HarnessAdapterError("content_range_invalid", "Content chunks require a valid byte offset and a limit of at most 64 KiB.");
    const entry = this.#require(sessionId, contentId);
    const length = entry.metadata.reference.byte_length;
    if (offset > length) throw new HarnessAdapterError("content_range_invalid", "Content offset exceeds its length.");
    const end = Math.min(length, offset + limit);
    let bytes: Buffer;
    if (entry.bytes) bytes = entry.bytes.subarray(offset, end);
    else {
      let fd: number;
      try {fd = openSync(join(this.directory!, `${contentId}.bin`), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));}
      catch {throw new HarnessAdapterError("content_unavailable", "Retained content is unavailable.");}
      try {
        const signature = () => {
          const stat = fstatSync(fd, {bigint: true});
          if (!stat.isFile() || stat.nlink !== 1n || stat.size !== BigInt(length))
            throw new HarnessAdapterError("content_integrity", "Retained content failed its integrity check.");
          return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
        };
        const before = signature();
        // Verify the complete file only when its identity/size/change times changed. Every chunk still checks the same opened file.
        if (entry.verifiedDiskSignature !== before) {
          const digest = createHash("sha256"), buffer = Buffer.alloc(Math.min(64 * 1024, Math.max(1, length)));
          let position = 0;
          while (position < length) {
            const received = readSync(fd, buffer, 0, Math.min(buffer.length, length - position), position);
            if (!received) throw new HarnessAdapterError("content_integrity", "Retained content failed its integrity check.");
            digest.update(buffer.subarray(0, received));position += received;
          }
          if (digest.digest("hex") !== entry.metadata.reference.sha256 || signature() !== before)
            throw new HarnessAdapterError("content_integrity", "Retained content failed its integrity check.");
          entry.verifiedDiskSignature = before;
        }
        bytes = Buffer.alloc(end - offset);let received = 0;
        while (received < bytes.length) {
          const count = readSync(fd, bytes, received, bytes.length - received, offset + received);
          if (!count) throw new HarnessAdapterError("content_integrity", "Retained content failed its integrity check.");
          received += count;
        }
        if (signature() !== before) throw new HarnessAdapterError("content_integrity", "Retained content changed during its chunk read.");
      } finally {closeSync(fd);}
    }
    return {reference: {...entry.metadata.reference}, offset, data_base64: bytes.toString("base64"),
      ...(end < length ? {next_offset: end} : {})};
  }

  #require(sessionId: string, contentId: string) {
    if (!/^[a-f0-9]{64}$/.test(contentId)) throw new HarnessAdapterError("content_unavailable", "Unknown content reference.");
    const entry = this.#entries.get(contentId);
    if (!entry || entry.metadata.scope.session_id !== sessionId || Date.parse(entry.metadata.reference.expires_at) <= this.now())
      throw new HarnessAdapterError("content_unavailable", "Content reference is unknown, expired, evicted or belongs to another session.");
    return entry;
  }
  #prune(incoming: number): void {
    let size = [...this.#entries.values()].reduce((total, entry) => total + entry.metadata.reference.byte_length, 0);
    const sorted = [...this.#entries.entries()].sort((a, b) => Date.parse(a[1].metadata.reference.expires_at) - Date.parse(b[1].metadata.reference.expires_at));
    for (const [id, entry] of sorted) {
      if (Date.parse(entry.metadata.reference.expires_at) > this.now() && size + incoming <= (this.limits.maxTotalBytes ?? HARNESS_CONTENT_STORE_MAX_BYTES) && this.#entries.size < 1024) continue;
      this.#entries.delete(id); size -= entry.metadata.reference.byte_length;
      if (this.directory) for (const suffix of ["json", "bin"]) {
        const path = join(this.directory, `${id}.${suffix}`);
        if (existsSync(path)) unlinkSync(path);
      }
    }
  }
}
