import {HarnessAdapterError} from "../types.js";

/** Wait only for a phase admitted by the existing owner; never dispatch or adopt one. */
export class NativePhaseWaiter {
  #current: string | undefined;
  #closed: Error | undefined;
  #waiting = new Set<{admit(reference: string): void; reject(error: Error): void}>();
  admit(reference: string): void {
    if (this.#closed) throw this.#closed;
    this.#current = reference;
    for (const pending of [...this.#waiting]) pending.admit(reference);
  }
  completed(reference: string): void {
    if (this.#current === reference) this.#current = undefined;
  }
  close(error: Error = new HarnessAdapterError("active_turn_unavailable", "The native execution owner has settled.")): void {
    this.#closed = error; this.#current = undefined;
    for (const pending of [...this.#waiting]) pending.reject(error);
  }
  wait(signal: AbortSignal): Promise<string> {
    if (this.#closed) return Promise.reject(this.#closed);
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.#current) return Promise.resolve(this.#current);
    if (this.#waiting.size >= 128)
      return Promise.reject(new HarnessAdapterError("native_phase_backpressure", "Native phase waits reached their bounded limit."));
    return new Promise<string>((resolve, reject) => {
      const cleanup = () => {this.#waiting.delete(pending); signal.removeEventListener("abort", abort);};
      const pending = {admit(reference: string) {cleanup(); resolve(reference);}, reject(error: Error) {cleanup(); reject(error);}};
      const abort = () => {cleanup(); reject(signal.reason);};
      this.#waiting.add(pending); signal.addEventListener("abort", abort, {once: true});
      if (signal.aborted) abort();
    });
  }
}
