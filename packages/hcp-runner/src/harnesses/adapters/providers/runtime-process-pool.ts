import { HarnessAdapterError } from "../types.js";

export interface PooledRuntime {
  process: {closed: Promise<void>; stop(): Promise<void>};
}
type Entry<T> = {key: string; runtime: T; busy: boolean; timer?: NodeJS.Timeout};

/** Exclusive process leases. Native conversations are never inferred from a key. */
export class RuntimeProcessPool<T extends PooledRuntime> {
  readonly #entries = new Set<Entry<T>>();
  #closed = false;
  constructor(readonly create: (key: string) => Promise<T>, readonly capacity = 4,
    readonly idleMs = 120_000) {
    if (!Number.isInteger(capacity) || capacity < 1 || !Number.isFinite(idleMs) || idleMs < 1)
      throw new RangeError("Runtime pool capacity and idle timeout must be positive.");
  }

  async acquire(key: string, create = this.create): Promise<{runtime: T; reused: boolean; release(healthy: boolean): Promise<void>}> {
    if (this.#closed) throw new HarnessAdapterError("runtime_pool_closed", "Provider runtime owner is closed.");
    let entry = [...this.#entries].find(e => e.key === key && !e.busy);
    const reused = entry !== undefined;
    if (!entry && this.#entries.size >= this.capacity) {
      const idle = [...this.#entries].find(e => !e.busy);
      if (!idle) throw new HarnessAdapterError("runtime_capacity", "All Provider runtimes are leased.");
      await this.#remove(idle);
      // Another caller may have acquired capacity while teardown was pending.
      if (this.#closed || this.#entries.size >= this.capacity)
        throw new HarnessAdapterError("runtime_capacity", "Provider runtime capacity is unavailable.");
    }
    if (entry) {entry.busy = true; clearTimeout(entry.timer);}
    else {
      // Reserve capacity before asynchronous initialization.
      entry = {key, runtime: undefined as unknown as T, busy: true};
      this.#entries.add(entry);
      try {entry.runtime = await create(key);}
      catch (error) {this.#entries.delete(entry); throw error;}
      const owned = entry;
      void entry.runtime.process.closed.then(() => {clearTimeout(owned.timer); this.#entries.delete(owned);});
      if (this.#closed) {await this.#remove(entry); throw new Error("Provider runtime owner closed during initialization");}
    }
    const owned = entry;
    let released = false;
    return {runtime: owned.runtime, reused, release: async healthy => {
      if (released) return;
      released = true;
      if (!healthy || this.#closed || !this.#entries.has(owned)) {await this.#remove(owned); return;}
      owned.busy = false;
      owned.timer = setTimeout(() => {void this.#remove(owned).catch(() => {this.#closed = true;});}, this.idleMs);
      owned.timer.unref();
    }};
  }
  async #remove(entry: Entry<T>): Promise<void> {
    clearTimeout(entry.timer);
    entry.busy = true;
    if (entry.runtime) await entry.runtime.process.stop();
    this.#entries.delete(entry);
  }
  async close(): Promise<void> {
    this.#closed = true;
    await Promise.all([...this.#entries].map(e => this.#remove(e)));
  }
}
