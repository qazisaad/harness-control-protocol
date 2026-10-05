/** A restarted local server can invalidate a pooled socket. Retry only an idempotent read. */
export async function fetchNativeResponse(url: URL, init: RequestInit): Promise<Response> {
  const request = {...init, signal: init.signal ?? AbortSignal.timeout(30_000)};
  try {return await fetch(url, request);} catch (error) {
    const code = error instanceof Error && error.cause && typeof error.cause === "object" && "code" in error.cause ? error.cause.code : undefined;
    if ((init.method ?? "GET").toUpperCase() !== "GET" || request.signal.aborted || !["ECONNRESET", "UND_ERR_SOCKET"].includes(String(code))) throw error;
    return await fetch(url, request);
  }
}
