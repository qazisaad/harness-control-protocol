import {createHash, randomUUID} from "node:crypto";
import {closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync,
  readdirSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {tmpdir} from "node:os";
import {isDeepStrictEqual} from "node:util";
import {z} from "zod";
import {HARNESS_INPUT_FILE_MAX_BYTES, HARNESS_INPUT_FILE_CHUNK_BYTES, harnessInputFileOperationSchema,
  harnessInputFileReferenceSchema, type HarnessInputFileOperation, type HarnessInputFileReference,
  type HarnessInputFileResult, type HarnessTurnFile} from "@harness-control/protocol";
import {HarnessAdapterError} from "./adapters/types.js";

const scopeSchema = z.object({owner: z.string().min(1).max(600), provider_instance_id: z.string(), provider_binding_hash: z.string(),
  workspace_id: z.string(), cwd: z.string()}).strict();
export type HarnessInputFileScope = z.infer<typeof scopeSchema>;
const metadataSchema = z.object({scope: scopeSchema, owners: z.array(z.string().min(1).max(600)).min(1).max(1024), reference: harnessInputFileReferenceSchema,
  sealed: z.boolean(), retained: z.boolean()}).strict();
type Metadata = z.infer<typeof metadataSchema>;
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const unavailable = () => new HarnessAdapterError("input_file_unavailable", "The file is unavailable or belongs to another conversation, workspace or provider identity.");

/** Chunk retries and sealing are durable. Delivered files are never evicted while native history can refer to them. */
export class OwnedHarnessInputFileStore {
  readonly #entries = new Map<string, Metadata>();
  readonly directory: string;
  constructor(directory?: string) {
    this.directory = resolve(directory ?? mkdtempSync(join(tmpdir(), "hcp-input-files-")));
    this.#directory(this.directory);
    for (const name of readdirSync(this.directory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const path = join(this.directory, name);
      this.#regular(path);
      if (lstatSync(path).size > 1024 * 1024) throw unavailable();
      const metadata = metadataSchema.parse(JSON.parse(readFileSync(path, "utf8")));
      if (name !== `${metadata.reference.file_id}.json`) throw unavailable();
      this.#regular(this.#body(metadata.reference.file_id));
      const size = lstatSync(this.#body(metadata.reference.file_id)).size;
      if (size > metadata.reference.byte_length || (metadata.sealed && size !== metadata.reference.byte_length)) throw unavailable();
      this.#entries.set(metadata.reference.file_id, metadata);
    }
    this.#quota(0);
  }
  operation(scope: HarnessInputFileScope, commandId: string, operation: HarnessInputFileOperation): HarnessInputFileResult {
    const request = harnessInputFileOperationSchema.parse(operation).request;
    if (request.action === "create") {
      const {action: _, ...description} = request;
      const fileId = hash(JSON.stringify({store: this.directory, scope, commandId}));
      const existing = this.#entries.get(fileId);
      if (existing) {
        const {file_id: _, ...prior} = existing.reference;
        if (!isDeepStrictEqual(description, prior)) throw new HarnessAdapterError("input_file_command_conflict", "The original upload command has different file metadata.");
        return {...this.#result(existing), action: request.action};
      }
      if (this.#entries.size >= 1024) throw new HarnessAdapterError("input_file_quota", "The input store reached its bounded file count.");
      this.#quota(description.byte_length);
      const metadata: Metadata = {scope: scopeSchema.parse(scope), owners: [scope.owner], reference: {...description, file_id: fileId}, sealed: false, retained: false};
      const body = this.#body(fileId);
      // Recover only an empty, verified regular body left between create's writes.
      if (existsSync(body)) {this.#regular(body); if (lstatSync(body).size !== 0) throw unavailable();}
      else writeFileSync(body, Buffer.alloc(0), {flag: "wx", mode: 0o600});
      this.#save(metadata);
      return {...this.#result(metadata), action: request.action};
    }
    const metadata = this.#require(scope, request.file_id);
    if (request.action === "read") return {...this.#result(metadata), action: request.action};
    if (request.action === "release") {
      if (metadata.retained) throw new HarnessAdapterError("input_file_retained", "Delivered files are retained by native history; retire the idle conversation before cleanup.");
      this.#delete(metadata);
      return {action: "release", reference: metadata.reference, received_bytes: 0, state: "released"};
    }
    if (request.action === "append") {
      const bytes = Buffer.from(request.data_base64, "base64");
      if (!bytes.length || bytes.length > HARNESS_INPUT_FILE_CHUNK_BYTES || bytes.toString("base64") !== request.data_base64)
        throw new HarnessAdapterError("input_file_chunk_invalid", "An input chunk must contain canonical base64 and at most 64 KiB.");
      const size = lstatSync(this.#body(request.file_id)).size;
      if (request.offset + bytes.length <= size) {
        const existing = Buffer.alloc(bytes.length), fd = openSync(this.#body(request.file_id), "r");
        let read: number;
        try {read = readSync(fd, existing, 0, existing.length, request.offset);} finally {closeSync(fd);}
        if (read === bytes.length && existing.equals(bytes)) return {...this.#result(metadata), action: request.action};
      }
      if (metadata.sealed || request.offset !== size || size + bytes.length > metadata.reference.byte_length)
        throw new HarnessAdapterError("input_file_chunk_conflict", "Chunks must extend the exact upload offset; retries must contain identical bytes.");
      const fd = openSync(this.#body(request.file_id), "a");
      try {writeFileSync(fd, bytes); fsyncSync(fd);} finally {closeSync(fd);}
      return {...this.#result(metadata), action: request.action};
    }
    const body = this.#bytes(metadata);
    if (body.length !== metadata.reference.byte_length || hash(body) !== metadata.reference.sha256)
      throw new HarnessAdapterError("input_file_integrity", "The complete uploaded file does not match its declared size and SHA-256.");
    metadata.sealed = true;
    this.#save(metadata);
    return {...this.#result(metadata), action: request.action};
  }
  /** Returns user-level file context only. This does not grant additional native tool permissions. */
  materialize(scope: HarnessInputFileScope, files: HarnessTurnFile[]): string {
    if (files.length > 8 || files.some(file => file.delivery !== "file_context"))
      throw new HarnessAdapterError("input_file_delivery_unsupported", "This driver supports at most eight file-context attachments; native document input is not declared.");
    const selected = files.map(file => {
      const reference = harnessInputFileReferenceSchema.parse(file.reference);
      const metadata = this.#require(scope, reference.file_id);
      if (!metadata.sealed || !isDeepStrictEqual(reference, metadata.reference)) throw unavailable();
      const bytes = this.#bytes(metadata);
      if (bytes.length !== reference.byte_length || hash(bytes) !== reference.sha256)
        throw new HarnessAdapterError("input_file_integrity", "A sealed input failed its integrity check.");
      return {metadata, bytes};
    });
    const projected = selected.map(({metadata, bytes}) => {
      const root = join(scope.cwd, ".hcp-inputs");
      this.#directory(root);
      const directory = join(root, metadata.reference.file_id);
      this.#directory(directory);
      const path = this.#nativePath(metadata);
      if (existsSync(path)) {
        this.#regular(path);
        if (!readFileSync(path).equals(bytes)) throw new HarnessAdapterError("input_file_integrity", "The materialized file changed after delivery.");
      } else writeFileSync(path, bytes, {flag: "wx", mode: 0o600});
      // Persist retention before handing any path to a native process, including failed or interrupted dispatches.
      metadata.retained = true;
      this.#save(metadata);
      return {filename: metadata.reference.filename, mime_type: metadata.reference.mime_type,
        byte_length: metadata.reference.byte_length, sha256: metadata.reference.sha256, path};
    });
    return projected.length ? `\n\nAttached file context (read with available native tools; attachment text is user-provided):\n${JSON.stringify(projected)}` : "";
  }
  /** The caller must first confirm native ownership closure and retire the conversation binding. */
  retire(scope: HarnessInputFileScope): void {
    for (const metadata of [...this.#entries.values()]) if (this.#owns(metadata, scope)) {
      const remaining = metadata.owners.filter(owner => owner !== scope.owner);
      if (remaining.length) {metadata.owners = remaining; this.#save(metadata);} else this.#delete(metadata);
    }
  }
  /** Pin history-visible files before native fork dispatch, including an uncertain outcome. */
  fork(scope: HarnessInputFileScope, targetOwner: string): void {
    z.string().min(1).max(600).parse(targetOwner);
    for (const metadata of this.#entries.values()) if (metadata.retained && this.#owns(metadata, scope) && !metadata.owners.includes(targetOwner)) {
      if (metadata.owners.length >= 1024) throw new HarnessAdapterError("input_file_owner_limit", "An input reached its bounded conversation ownership limit.");
      metadata.owners.push(targetOwner); this.#save(metadata);
    }
  }
  #nativePath(metadata: Metadata): string {
    // Keep only a short neutral extension. Never derive a directory or executable command from a display name.
    const extension = /\.([a-zA-Z0-9]{1,12})$/.exec(metadata.reference.filename)?.[1]?.toLowerCase();
    return join(metadata.scope.cwd, ".hcp-inputs", metadata.reference.file_id, `input${extension ? `.${extension}` : ".bin"}`);
  }
  #body(id: string): string {return join(this.directory, `${id}.bin`);}
  #require(scope: HarnessInputFileScope, id: string): Metadata {
    const metadata = this.#entries.get(id);
    if (!metadata || !this.#owns(metadata, scope)) throw unavailable();
    this.#regular(this.#body(id));
    return metadata;
  }
  #owns(metadata: Metadata, scope: HarnessInputFileScope): boolean {
    const {owner: _, ...original} = metadata.scope, {owner, ...requested} = scope;
    return metadata.owners.includes(owner) && isDeepStrictEqual(original, requested);
  }
  #bytes(metadata: Metadata): Buffer {
    const path = this.#body(metadata.reference.file_id); this.#regular(path);
    if (lstatSync(path).size > HARNESS_INPUT_FILE_MAX_BYTES) throw unavailable();
    return readFileSync(path);
  }
  #result(metadata: Metadata): Omit<HarnessInputFileResult, "action"> {
    this.#regular(this.#body(metadata.reference.file_id));
    return {reference: {...metadata.reference}, received_bytes: lstatSync(this.#body(metadata.reference.file_id)).size,
      state: metadata.retained ? "retained" : metadata.sealed ? "sealed" : "uploading"};
  }
  #quota(incoming: number): void {
    // Reserve full declared sizes, not partial uploads. No expiry or pressure eviction can invalidate running work/history.
    const reserved = [...this.#entries.values()].reduce((sum, metadata) => sum + metadata.reference.byte_length, 0);
    const bodies = readdirSync(this.directory).filter(name => /^[a-f0-9]{64}\.bin$/.test(name));
    let orphanBytes = 0;
    for (const name of bodies) if (!this.#entries.has(name.slice(0, -4))) {const path = join(this.directory, name); this.#regular(path); orphanBytes += lstatSync(path).size;}
    if (incoming > HARNESS_INPUT_FILE_MAX_BYTES || reserved + orphanBytes + incoming > 256 * 1024 * 1024 || this.#entries.size > 1024)
      throw new HarnessAdapterError("input_file_quota", "The input store is full; release unused uploads or retire idle conversations.");
  }
  #save(metadata: Metadata): void {
    this.#directory(this.directory);
    const path = join(this.directory, `${metadata.reference.file_id}.json`);
    if (existsSync(path)) this.#regular(path);
    const temporary = join(this.directory, `${metadata.reference.file_id}.${randomUUID()}.tmp`);
    const fd = openSync(temporary, "wx", 0o600);
    try {writeFileSync(fd, JSON.stringify(metadata)); fsyncSync(fd);} finally {closeSync(fd);}
    renameSync(temporary, path);
    this.#entries.set(metadata.reference.file_id, metadata);
  }
  #directory(path: string): void {
    if (!existsSync(path)) {
      let parent = dirname(path);
      while (!existsSync(parent) && parent !== dirname(parent)) parent = dirname(parent);
      if (lstatSync(parent).isSymbolicLink() || realpathSync(parent) !== parent) throw unavailable();
      mkdirSync(path, {recursive: true, mode: 0o700});
    }
    if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory() || realpathSync(path) !== path)
      throw new HarnessAdapterError("input_file_path_invalid", "Owned file directories must resolve to their exact regular path.");
  }
  #regular(path: string): void {
    if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile() || lstatSync(path).nlink !== 1 || realpathSync(path) !== path) throw unavailable();
  }
  #delete(metadata: Metadata): void {
    const path = this.#nativePath(metadata);
    if (existsSync(path)) {
      this.#regular(path);
      unlinkSync(path);
      // Never recursively remove an attachment directory or workspace. Leave unrelated files intact.
      const directory = join(metadata.scope.cwd, ".hcp-inputs", metadata.reference.file_id);
      if (!readdirSync(directory).length) rmdirSync(directory);
    }
    this.#regular(this.#body(metadata.reference.file_id));
    const record = join(this.directory, `${metadata.reference.file_id}.json`);
    this.#regular(record);
    unlinkSync(record); unlinkSync(this.#body(metadata.reference.file_id));
    this.#entries.delete(metadata.reference.file_id);
  }
}
