import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import { HCP_MESSAGE_MAX_ENCODED_BYTES, HcpAccountUsageReducer } from "@harness-control/protocol";
import { HcpHostConnection } from "@harness-control/sdk";
import { RunnerConnection } from "@harness-control/runner/connection";
import { RunnerConfigSchema, type RunnerConfig } from "@harness-control/runner/config";
import { AccountUsageReader, type AccountCollector } from "@harness-control/runner/accounts";

/** Read-only reference host: one local runner, the canonical account reducer and an authenticated loopback page. State is in memory only. */
export async function startAccountsDashboard(options: {
  config: RunnerConfig; port?: number; collectors?: ReadonlyMap<string, AccountCollector>; pollMs?: number; maxObservationAgeMs?: number;
}) {
  const token: string = randomBytes(32).toString("hex");
  const maxObservationAgeMs = options.maxObservationAgeMs ?? 300_000;
  const accounts = new HcpAccountUsageReducer();
  let host: HcpHostConnection | undefined;
  let activeSocket: WebSocket | undefined;
  let connected = false;
  let collecting: Promise<void> | undefined;
  let lastError: string | undefined;
  const refresh = (): Promise<void> => {
    if (collecting) return collecting;
    collecting = (async () => {
      if (!host || !connected) throw new Error("Runner is not connected.");
      await host.readAccounts({}, undefined, { timeoutMs: 150_000 });
      lastError = undefined;
    })().catch(error => {
      lastError = "Account refresh failed. Check the runner connection.";
      throw error;
    }).finally(() => { collecting = undefined; });
    return collecting;
  };
  const state = () => {
    const now = new Date();
    return {
      connected, collecting: !!collecting, updated_at: now.toISOString(), error: lastError,
      max_observation_age_seconds: maxObservationAgeMs / 1000,
      sources: accounts.snapshot(),
      accounts: accounts.accounts(now, maxObservationAgeMs),
    };
  };
  let origin = "";
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    if (request.headers.host !== new URL(origin).host) { response.writeHead(403).end(); return; }
    const path = new URL(request.url ?? "/", origin).pathname;
    if (path.startsWith("/api/")) {
      if (request.headers.authorization !== `Bearer ${token}` || request.headers.origin && request.headers.origin !== origin) { response.writeHead(403).end(); return; }
      response.setHeader("content-type", "application/json");
      if (path === "/api/state" && request.method === "GET") { response.end(JSON.stringify(state())); return; }
      if (path === "/api/refresh" && request.method === "POST") { await refresh(); response.end(JSON.stringify(state())); return; }
      response.writeHead(404).end(); return;
    }
    const files: Record<string, { file: string; type: string }> = {
      "/": { file: "index.html", type: "text/html" },
      "/app.js": { file: "app.js", type: "text/javascript" },
      "/style.css": { file: "style.css", type: "text/css" },
    };
    const file = files[path];
    if (!file || request.method !== "GET") { response.writeHead(404).end(); return; }
    response.setHeader("content-type", `${file.type}; charset=utf-8`);
    response.end(await readFile(new URL(`../public/${file.file}`, import.meta.url)));
  };
  const server = createServer((request, response) => {
    void handle(request, response).catch(error => {
      if (!(error instanceof Error)) throw error;
      if (!response.headersSent) response.writeHead(error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Request failed. Check the local runner connection." }));
    });
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: HCP_MESSAGE_MAX_ENCODED_BYTES });
  server.on("upgrade", (request, socket, head) => {
    if (request.url !== "/runner" || request.headers.authorization !== `Bearer ${token}`) { socket.destroy(); return; }
    sockets.handleUpgrade(request, socket, head, ws => sockets.emit("connection", ws));
  });
  sockets.on("connection", socket => {
    activeSocket?.close();
    host?.disconnect();
    activeSocket = socket;
    connected = false;
    const connection = new HcpHostConnection({ send: message => socket.send(JSON.stringify(message)) }, { accounts });
    host = connection;
    socket.on("message", raw => {
      if (socket !== activeSocket) return;
      try {
        const received = connection.receive(raw.toString());
        if (received.message.type === "host.hello") {
          const hello = received.message.payload;
          if (hello.runner_id !== options.config.runner_id || hello.host_id !== (options.config.host_id ?? options.config.runner_id)) throw new Error("Unexpected host.");
          connection.accept({ protocol_version: "hcp.v0", heartbeat_interval_seconds: 15 });
          connected = true;
          void refresh().catch(() => {}); // refresh records a user-visible error.
        }
      } catch { lastError = "Runner protocol validation failed."; socket.close(); }
    });
    socket.on("close", () => { connection.disconnect(); if (socket === activeSocket) connected = false; });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port ?? 0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Dashboard failed to bind TCP.");
  origin = `http://127.0.0.1:${address.port}`;
  const config = RunnerConfigSchema.parse({ ...options.config, control_plane_url: `ws://127.0.0.1:${address.port}/runner` });
  const reader = new AccountUsageReader(config, { ...(options.collectors ? { collectors: options.collectors, cacheMs: 0 } : {}) });
  const runner = new RunnerConnection({ config, runnerVersion: "accounts-reference", connectionTokenProvider: async () => token, accountUsage: reader });
  try { await runner.connect(); }
  catch (error) {
    await runner.close();
    for (const socket of sockets.clients) socket.terminate();
    sockets.close(); server.close();
    throw error;
  }
  const interval = setInterval(() => { if (connected) void refresh().catch(() => {}); }, options.pollMs ?? 60_000);
  return {
    url: `${origin}/#${token}`, origin, token, refresh, state,
    close: async (): Promise<void> => {
      clearInterval(interval); await runner.close(); host?.disconnect();
      if (collecting) await collecting.catch(() => {});
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>(resolve => sockets.close(() => resolve()));
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
