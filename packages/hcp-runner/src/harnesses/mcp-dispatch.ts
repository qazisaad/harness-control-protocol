import {HarnessAdapterError, type HarnessMcpDispatch} from "./adapters/types.js";

/** Serializes whole MCP operations, including approval and elicitation, across native owners. */
export class HarnessMcpDispatchQueue {
  #tail: Promise<void> = Promise.resolve();
  #pending = 0;
  constructor(private readonly beforeDispatch: () => void = () => {}) {}

  readonly dispatch: HarnessMcpDispatch = async <T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> => {
    signal.throwIfAborted();
    if (this.#pending >= 256) throw new HarnessAdapterError("mcp_dispatch_limit", "The session MCP dispatch queue is full.");
    this.#pending++;
    const execution = this.#tail.then(async () => {
      signal.throwIfAborted();
      this.beforeDispatch();
      return operation();
    });
    this.#tail = execution.then(() => undefined, () => undefined).finally(() => {this.#pending--;});
    let abort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, {once: true});
      if (signal.aborted) abort();
    });
    try {return await Promise.race([execution, cancelled]);}
    finally {signal.removeEventListener("abort", abort);}
  };
}
