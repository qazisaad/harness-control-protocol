import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync, renameSync, unlinkSync, fsyncSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { claimSpendLimitAction, spendLimitActionRecordSchema, type SpendLimitActionRecord, type SpendLimitActionStore } from "./actions.js";

/** Single-process reference storage. An abandoned lock requires operator inspection before removal. */
export class ExclusiveJsonFile<T> {
  readonly #path: string;
  readonly #lock: string;
  #closed = false;
  #value: T;

  constructor(path: string, private readonly schema: z.ZodType<T>, initial: T) {
    this.#path = resolve(path);
    this.#lock = `${this.#path}.lock`;
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    const descriptor = openSync(this.#lock, "wx", 0o600);
    try { writeFileSync(descriptor, JSON.stringify({ pid: process.pid })); fsyncSync(descriptor); }
    finally { closeSync(descriptor); }
    try {
      this.#value = schema.parse(JSON.parse(readFileSync(this.#path, "utf8")));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") this.#value = schema.parse(initial);
      else { unlinkSync(this.#lock); throw error; }
    }
  }

  read(): T { this.#assertOpen(); return structuredClone(this.#value); }

  write(input: T): void {
    this.#assertOpen();
    const value = this.schema.parse(input);
    const temporary = `${this.#path}.${randomUUID()}.tmp`;
    const descriptor = openSync(temporary, "wx", 0o600);
    try { writeFileSync(descriptor, JSON.stringify(value)); fsyncSync(descriptor); }
    finally { closeSync(descriptor); }
    renameSync(temporary, this.#path);
    const directory = openSync(dirname(this.#path), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
    this.#value = structuredClone(value);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    unlinkSync(this.#lock);
  }

  #assertOpen(): void { if (this.#closed) throw new Error("State store is closed."); }
}

export class JsonSpendLimitActionStore implements SpendLimitActionStore {
  readonly #file: ExclusiveJsonFile<SpendLimitActionRecord[]>;
  constructor(path: string) { this.#file = new ExclusiveJsonFile(path, z.array(spendLimitActionRecordSchema), []); }

  async claim(record: SpendLimitActionRecord): Promise<{ claimed: boolean; record: SpendLimitActionRecord }> {
    const records = this.#file.read();
    const claim = claimSpendLimitAction(records, spendLimitActionRecordSchema.parse(record));
    if (claim.claimed) this.#file.write([...records, claim.record]);
    return claim;
  }

  async get(id: string): Promise<SpendLimitActionRecord> {
    const record = this.#file.read().find(record => record.action.id === id);
    if (!record) throw new Error("Unknown spend-limit action.");
    return record;
  }

  async settle(input: SpendLimitActionRecord): Promise<void> {
    const record = spendLimitActionRecordSchema.parse(input);
    const records = this.#file.read();
    const index = records.findIndex(existing => existing.action.id === record.action.id);
    const existing = records[index];
    if (!existing || JSON.stringify(existing.action) !== JSON.stringify(record.action) || existing.authorized_by !== record.authorized_by) throw new Error("Action claim mismatch.");
    if (existing.status === "applied" || existing.status === "rejected") throw new Error("Action is already terminal.");
    records[index] = record;
    this.#file.write(records);
  }

  close(): void { this.#file.close(); }
}
