/** Bound adapter controls even when an adapter fails to cooperate with abort. Late results have no commit authority. */
export async function awaitNativeControl<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  const cancelled = () => reject(signal.reason);
  let reject!: (reason: unknown) => void;
  const cancellation = new Promise<never>((_resolve, onReject) => {reject = onReject;});
  signal.addEventListener("abort", cancelled, {once: true});
  try {return await Promise.race([operation(), cancellation]);}
  finally {signal.removeEventListener("abort", cancelled);}
}
