import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { ExclusiveJsonFile } from "@harness-control/management/node";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import { HCP_MESSAGE_MAX_ENCODED_BYTES, HcpAccountUsageReducer, accountSourceStateSchema } from "@harness-control/protocol";
import { HcpHostConnection } from "@harness-control/sdk";
import { RunnerConnection } from "@harness-control/runner/connection";
import { RunnerConfigSchema, type RunnerConfig } from "@harness-control/runner/config";
import { AccountUsageReader, type AccountCollector } from "@harness-control/runner/accounts";
import { capacityPolicySchema, evaluateCapacity, evaluateRenewal, renewalContractSchema, capacityQuoteSchema, capacityBudgetSchema } from "@harness-control/management";

export const dashboardSettingsSchema = z.object({
  policy: capacityPolicySchema.default({ threshold_percent: 95, reset_grace_minutes: 30, max_observation_age_seconds: 300, renewal_notice_days: 7 }),
  billing: z.array(z.object({ account_key: z.string().min(1), budget: capacityBudgetSchema, quotes: z.array(capacityQuoteSchema) }).strict()).default([]),
  renewals: z.array(renewalContractSchema).default([]),
}).strict();
const savedSchema = z.object({
  settings: dashboardSettingsSchema,
  sources: z.array(accountSourceStateSchema),
  history: z.array(z.object({ captured_at: z.iso.datetime({ offset: true }), sources: z.array(accountSourceStateSchema) }).strict()).max(168),
}).strict();
type SavedState = z.infer<typeof savedSchema>;

export async function startAccountsDashboard(options: {
  config: RunnerConfig; port?: number; statePath?: string; collectors?: ReadonlyMap<string, AccountCollector>; pollMs?: number;
}) {
  const token: string = randomBytes(32).toString("hex");
  let saved: SavedState = { settings: dashboardSettingsSchema.parse({}), sources: [], history: [] };
  const stateFile = options.statePath ? new ExclusiveJsonFile(options.statePath, savedSchema, saved) : undefined;
  if (stateFile) saved = stateFile.read();
  const accounts = new HcpAccountUsageReducer(saved.sources);
  let host: HcpHostConnection | undefined;
  let activeSocket: WebSocket | undefined;
  let connected = false;
  let collecting: Promise<void> | undefined;
  let lastError: string | undefined;
  const persist = async (): Promise<void> => { stateFile?.write({ ...saved, sources: accounts.snapshot() }); };
  const refresh = (): Promise<void> => {
    if (collecting) return collecting;
    collecting = (async () => {
      if (!host || !connected) throw new Error("Runner is not connected.");
      await host.readAccounts({}, undefined, { timeoutMs: 150_000 });
      saved.sources = accounts.snapshot();
      const previous = saved.history.at(-1);
      if (!previous || Date.now() - Date.parse(previous.captured_at) >= 3600_000) {
        saved.history = [...saved.history, { captured_at: new Date().toISOString(), sources: saved.sources }].slice(-168);
      }
      await persist();
      lastError = undefined;
    })().catch(error => {
      lastError = "Account refresh failed. Check the runner connection and state-file access.";
      throw error;
    }).finally(() => { collecting = undefined; });
    return collecting;
  };
  const state = () => {
    const now = new Date();
    const views = accounts.accounts(now, saved.settings.policy.max_observation_age_seconds * 1000);
    return {
      connected, collecting: !!collecting, updated_at: now.toISOString(), error: lastError,
      settings: saved.settings, sources: accounts.snapshot(), history: saved.history,
      accounts: views.map(view => {
        const billing = saved.settings.billing.find(item => item.account_key === view.account.key);
        return { ...view, decision: evaluateCapacity({ view, now, policy: saved.settings.policy,
          ...(billing ? { quotes: billing.quotes, budget: billing.budget } : {}),
        }) };
      }),
      renewals: saved.settings.renewals.map(contract => ({ contract, decision: evaluateRenewal(contract, saved.settings.policy, now) })),
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
      if (path === "/api/settings" && request.method === "PUT") {
        let body = "";
        for await (const chunk of request) { body += chunk.toString(); if (Buffer.byteLength(body) > 65536) throw new Error("Settings too large."); }
        const next = { ...saved, settings: dashboardSettingsSchema.parse(JSON.parse(body)), sources: accounts.snapshot() };
        stateFile?.write(next);
        saved = next; response.end(JSON.stringify(state())); return;
      }
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
      response.end(JSON.stringify({ error: "Request failed. Check input, connection and state-file access." }));
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
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port ?? 0, "127.0.0.1", resolve); });
  } catch (error) { stateFile?.close(); throw error; }
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
    sockets.close(); server.close(); stateFile?.close();
    throw error;
  }
  const interval = setInterval(() => { if (connected) void refresh().catch(() => {}); }, options.pollMs ?? 60_000);
  return {
    url: `${origin}/#${token}`, origin, token, refresh, state,
    close: async (): Promise<void> => {
      clearInterval(interval); await runner.close(); host?.disconnect();
      if (collecting) await collecting.catch(() => {});
      stateFile?.close();
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>(resolve => sockets.close(() => resolve()));
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
