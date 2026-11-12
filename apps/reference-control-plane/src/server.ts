import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import {
  HCP_VERSION,
  PAIRING_HTTP_PATHS,
  connectionTokenRequestSchema,
  createHcpEnvelope,
  pairingCreateRequestSchema,
  pairingExchangeRequestSchema,
  type ConnectionTokenResponse,
  type HcpHarnessEventPayload,
  type HcpHostCapabilitiesUpdatedPayload,
  type PairingCodeResponse,
  type PairingExchangeResponse,
} from "@harness-control/protocol";
import { HcpHostConnection, HcpSessionEventWaitError } from "@harness-control/sdk";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";

import { ControlPlaneStore, StoreRefusal, type TokenGrant } from "./store.js";

/**
 * A small HCP control plane you can read in one sitting. It covers Level 1:
 * pair a machine, connect it, run one turn and read events until the turn ends.
 *
 * Product stand-ins, to replace in a real app:
 * - "Login" is one admin bearer token. A real app uses its own sessions and roles.
 * - Live sockets are tracked in this process. With several server processes, send
 *   revocation to the process holding the socket (pub/sub or a database subscription).
 */

export type ReferenceControlPlaneOptions = {
  /** SQLite file path, or ":memory:" for tests. */
  databasePath: string;
  /** Public origin runners and browsers use, for example https://hcp.example.com. Defaults to the listening address. */
  publicUrl?: string;
  /** Stand-in for app login: whoever holds this token acts as the single admin user. */
  adminToken: string;
  /** SHA-256 of the HCP message schema this server was tested with; see docs/control-plane/lifecycle.md. */
  protocolSchemaSha256: string;
  host?: string;
  port?: number;
  heartbeatIntervalSeconds?: number;
};

export type ReferenceControlPlane = {
  /** HTTP origin for browsers and the admin API. */
  url: string;
  /** The URL a runner connects to: `hcp-runner connect <runnerUrl>`. */
  runnerUrl: string;
  close: () => Promise<void>;
};

const ADMIN_USER_ID = "admin";
const TERMINAL_TURN_EVENTS = ["turn.completed", "turn.failed", "turn.aborted", "turn.cancelled"];
const TURN_STOP_EVENTS = [...TERMINAL_TURN_EVENTS, "approval.requested", "input.requested"];

type Folder = { id: string; path: string };
type LiveRunner = { socket: WebSocket; grant: TokenGrant; host: HcpHostConnection; capabilities?: HcpHostCapabilitiesUpdatedPayload; folders: Folder[] };

const decisionSchema = z.object({ request_id: z.string().min(1), pairing_code: z.string().min(1) }).strict();
const revokeSchema = z.object({ credential_id: z.string().min(1) }).strict();
const folderSchema = z.object({
  credential_id: z.string().min(1),
  path: z.string().min(1),
  display_name: z.string().min(1).max(100),
}).strict();
const turnSchema = z.object({
  credential_id: z.string().min(1),
  prompt: z.string().min(1),
  provider_instance_id: z.string().min(1).optional(),
  workspace_id: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  // Level 1 defaults to the narrowest access. Wider access must be asked for explicitly.
  sandbox_mode: z.enum(["read_only", "workspace_write", "danger_full_access"]).default("read_only"),
  approval_policy: z.enum(["ask", "auto_edits", "full_access"]).default("ask"),
  timeout_seconds: z.number().int().min(1).max(3600).default(300),
}).strict();

class HttpRefusal extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function send(response: ServerResponse, status: number, body: unknown, type = "application/json"): void {
  response.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  response.end(type === "application/json" ? JSON.stringify(body) : String(body));
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new HttpRefusal(413, "Request body is too large.");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson<T>(request: IncomingMessage, schema: z.ZodType<T>): Promise<T> {
  let value: unknown;
  try { value = JSON.parse(await readBody(request)); } catch (error) {
    if (error instanceof SyntaxError) throw new HttpRefusal(400, "Body must be JSON.");
    throw error;
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HttpRefusal(400, parsed.error.message);
  return parsed.data;
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export async function startReferenceControlPlane(options: ReferenceControlPlaneOptions): Promise<ReferenceControlPlane> {
  const store = new ControlPlaneStore(options.databasePath);
  const heartbeatIntervalSeconds = options.heartbeatIntervalSeconds ?? 15;
  const live = new Map<string, LiveRunner>();
  // Set once the server is listening, so tests can use port 0.
  let publicUrl: URL;
  let socketUrl: URL;

  const requireAdmin = (request: IncomingMessage): string => {
    const header = request.headers.authorization ?? "";
    if (!header.startsWith("Bearer ") || !sameSecret(header.slice(7), options.adminToken)) throw new HttpRefusal(401, "Admin token required.");
    return ADMIN_USER_ID;
  };

  /** Revocation in the store fences new tokens; closing the socket here cuts the live connection now. */
  const revoke = (credentialId: string): void => {
    store.revoke(credentialId);
    const runner = live.get(credentialId);
    if (runner) runner.socket.close(1008, "credential revoked");
  };

  /** Registers an existing folder on the machine. The runner checks it against its own allowed roots. */
  const addFolder = async (input: z.infer<typeof folderSchema>) => {
    const runner = live.get(input.credential_id);
    const revision = runner?.capabilities?.workspace_management?.revision;
    if (!runner || revision === undefined) throw new HttpRefusal(409, "That machine is not connected yet, or does not allow folder management.");
    const result = await runner.host.manageWorkspaces({ operation: { kind: "add", path: input.path, display_name: input.display_name },
      expected_revision: revision, expires_at: new Date(Date.now() + 30_000).toISOString() });
    if (result.payload.outcome.kind !== "success") throw new HttpRefusal(409, result.payload.outcome.kind === "error" ? result.payload.outcome.message : "Folder was not added.");
    // A complete workspace result replaces the folder list the runner last reported.
    runner.folders = result.payload.workspaces.map(({ id, path }) => ({ id, path }));
    return { folders: runner.folders };
  };

  const runTurn = async (input: z.infer<typeof turnSchema>) => {
    const runner = live.get(input.credential_id);
    if (!runner || !runner.capabilities) throw new HttpRefusal(409, "That machine is not connected yet.");
    const provider = runner.capabilities.providers.find((p) => p.availability === "available"
      && (input.provider_instance_id === undefined || p.provider_instance_id === input.provider_instance_id));
    const workspace = runner.folders.find((w) => input.workspace_id === undefined || w.id === input.workspace_id);
    if (!provider || !workspace) throw new HttpRefusal(409, "The machine has no available coding agent or folder that matches.");
    // Never widen access to make an agent work: refuse what the agent does not advertise.
    const supported = provider.execution_capabilities;
    if (supported && !supported.sandbox_modes.includes(input.sandbox_mode)) {
      throw new HttpRefusal(409, `${provider.provider_instance_id} does not support sandbox_mode ${input.sandbox_mode}. It supports: ${supported.sandbox_modes.join(", ")}.`);
    }
    if (supported && !supported.approval_policies.includes(input.approval_policy)) {
      throw new HttpRefusal(409, `${provider.provider_instance_id} does not support approval_policy ${input.approval_policy}. It supports: ${supported.approval_policies.join(", ")}.`);
    }
    const model = input.model === undefined ? provider.models.find((m) => m.is_default) ?? provider.models[0]
      : provider.models.find((m) => m.id === input.model);
    if (!model) throw new HttpRefusal(409, `${provider.provider_instance_id} reported no matching model.`);
    const sessionId = `session-${crypto.randomUUID()}`;
    await runner.host.startSession({
      session_id: sessionId, workspace_id: workspace.id, provider_instance_id: provider.provider_instance_id,
      driver_kind: provider.driver_kind, cwd: workspace.path,
      sandbox_mode: input.sandbox_mode, approval_policy: input.approval_policy, continue_session: false,
      model_selection: { model: model.id }, mcp_servers: [],
    });
    try {
      // Start waiting before sending: a fast agent can finish before the ACK arrives, and the
      // wait only sees events after the point it starts. An ACK only means "accepted"; the
      // turn is finished when a terminal turn event arrives. This server cannot answer
      // approval or input requests (Level 2), so it also stops waiting if the agent asks.
      const firstStop: Promise<HcpHarnessEventPayload> = runner.host.waitForSessionEvent(sessionId,
        (event) => TURN_STOP_EVENTS.includes(event.event_type), { timeoutMs: input.timeout_seconds * 1000 });
      await runner.host.sendTurn({ session_id: sessionId, turn_id: "turn-1", input: input.prompt });
      let terminal: HcpHarnessEventPayload;
      try {
        terminal = await firstStop;
      } catch (error) {
        if (!(error instanceof HcpSessionEventWaitError) || error.reason !== "timeout") throw error;
        throw new HttpRefusal(504, `The turn did not finish within ${input.timeout_seconds} seconds and was stopped.`);
      }
      if (!TERMINAL_TURN_EVENTS.includes(terminal.event_type)) {
        throw new HttpRefusal(409, `The agent sent ${terminal.event_type}, which this Level 1 server cannot answer, so the turn was stopped. `
          + "Choose an approval_policy the agent will not ask under, or add approval handling (Level 2).");
      }
      const output = (terminal.data as { final_output?: Parameters<HcpHostConnection["readFinalTextComplete"]>[1] } | undefined)?.final_output;
      // Long answers arrive as a content reference; the SDK reads and verifies the full text.
      const finalText = output === undefined ? undefined : await runner.host.readFinalTextComplete(sessionId, output);
      return { session_id: sessionId, outcome: terminal.event_type, final_text_availability: finalText?.availability ?? "unavailable",
        // "unconfirmed" text is the agent's display text without proof it is the complete answer.
        final_text: finalText?.availability === "complete" ? finalText.final_text : finalText?.source.final_text ?? null };
    } finally {
      // Stopping the session also ends a turn that is still running or waiting for an answer.
      await runner.host.stopSession({ session_id: sessionId, reason: "Reference control plane turn finished." });
    }
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "/", publicUrl);
    const route = `${request.method} ${url.pathname}`;

    // Runner-facing pairing and token endpoints (docs/pairing.md, schemas/pairing.schema.json).
    if (route === `POST ${PAIRING_HTTP_PATHS.create}`) {
      const body = await readJson(request, pairingCreateRequestSchema);
      const created = store.createPairing(body);
      const pairingUrl = new URL("/pair", publicUrl);
      pairingUrl.searchParams.set("code", created.pairingCode);
      const reply: PairingCodeResponse = { request_id: created.requestId, pairing_code: created.pairingCode,
        pairing_url: pairingUrl.toString(), expires_at: new Date(created.expiresAt).toISOString(), poll_interval_seconds: 2 };
      return send(response, 200, reply);
    }
    if (route === `POST ${PAIRING_HTTP_PATHS.exchange}`) {
      const body = await readJson(request, pairingExchangeRequestSchema);
      const result = store.exchange(body);
      const reply: PairingExchangeResponse = result === "pending" ? { status: "pending" } : {
        status: "approved", control_plane_url: socketUrl.toString(), credential: {
          credential_id: result.machine.credential_id, credential_secret: result.credentialSecret,
          runner_id: result.machine.runner_id, host_id: result.machine.host_id, control_plane_url: socketUrl.toString(),
          issued_at: new Date().toISOString(), mcp_proof_secret: result.proofSecret },
      };
      return send(response, 200, reply);
    }
    if (route === `POST ${PAIRING_HTTP_PATHS.connectionToken}`) {
      const body = await readJson(request, connectionTokenRequestSchema);
      // The digest pin admits only runner builds whose protocol this server was tested with.
      if (body.protocol_schema_sha256 !== options.protocolSchemaSha256) throw new HttpRefusal(409, "This runner's protocol version is not supported. Update the runner.");
      const minted = store.mintToken(body);
      const reply: ConnectionTokenResponse = { connection_token: minted.token, expires_at: new Date(minted.expiresAt).toISOString() };
      return send(response, 200, reply);
    }

    // Browser approval page. The pairing URL the runner opens lands here.
    if (route === "GET /pair") {
      const code = url.searchParams.get("code") ?? "";
      const pairing = store.findPendingByCode(code);
      return send(response, pairing ? 200 : 404, pairing
        ? `<!doctype html><meta charset="utf-8"><title>Approve machine</title><h1>Approve ${escapeHtml(pairing.host_id)}?</h1>
<p>Runner <code>${escapeHtml(pairing.runner_id)}</code> asks to connect with code <strong>${escapeHtml(code)}</strong>. Approve only if this code matches your terminal.</p>
<p>This reference server has no login page. Approve with the admin API:</p>
<pre>curl -X POST ${escapeHtml(new URL("/admin/approve", publicUrl).toString())} -H "Authorization: Bearer $HCP_ADMIN_TOKEN" -H "content-type: application/json" -d '{"request_id":"${escapeHtml(pairing.request_id)}","pairing_code":"${escapeHtml(code)}"}'</pre>`
        : "<!doctype html><title>Pairing not found</title><p>This pairing code is unknown, expired or already decided.</p>", "text/html; charset=utf-8");
    }

    // Admin API: the product side. These paths also serve as the lifecycle check's test hooks.
    if (route === "POST /admin/approve" || route === "POST /admin/decline") {
      const userId = requireAdmin(request);
      const body = await readJson(request, decisionSchema);
      store.decide({ requestId: body.request_id, pairingCode: body.pairing_code, userId,
        decision: url.pathname.endsWith("approve") ? "approved" : "declined" });
      return send(response, 200, { ok: true });
    }
    if (route === "POST /admin/revoke") {
      requireAdmin(request);
      revoke((await readJson(request, revokeSchema)).credential_id);
      return send(response, 200, { ok: true });
    }
    if (route === "GET /admin/machines") {
      const userId = requireAdmin(request);
      return send(response, 200, store.machines(userId).map((machine) => ({ ...machine, online: live.has(machine.credential_id) })));
    }
    if (route === "POST /admin/folders") {
      requireAdmin(request);
      return send(response, 200, await addFolder(await readJson(request, folderSchema)));
    }
    if (route === "POST /admin/turn") {
      requireAdmin(request);
      return send(response, 200, await runTurn(await readJson(request, turnSchema)));
    }
    throw new HttpRefusal(404, "Not found.");
  };

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (error instanceof HttpRefusal || error instanceof StoreRefusal) return send(response, error.status, { error: error.message });
      console.error(error);
      send(response, 500, { error: "Internal error." });
    });
  });

  const sockets = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  server.on("upgrade", (request, stream, head) => {
    const url = new URL(request.url ?? "/", publicUrl);
    const header = request.headers.authorization ?? "";
    let grant: TokenGrant;
    try {
      if (url.pathname !== socketUrl.pathname || !header.startsWith("Bearer ")) throw new StoreRefusal(401, "Connection token required.");
      // Spending the token is the atomic admission step: it works once, for a current credential.
      grant = store.consumeToken(header.slice(7));
    } catch (error) {
      const status = error instanceof StoreRefusal ? error.status : 500;
      if (status === 500) console.error(error);
      stream.end(`HTTP/1.1 ${status} ${status === 500 ? "Internal Server Error" : "Unauthorized"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    sockets.handleUpgrade(request, stream, head, (socket) => admit(socket, grant));
  });

  const admit = (socket: WebSocket, grant: TokenGrant): void => {
    const credentialId = grant.machine.credential_id;
    const host = new HcpHostConnection({ send: (message) => socket.send(JSON.stringify(message)) });
    const runner: LiveRunner = { socket, grant, host, folders: [] };
    socket.on("message", (raw) => {
      try {
        const { message } = host.receive(raw.toString());
        if (message.type === "host.hello") {
          // The hello must match the identity the credential was issued to.
          if (message.payload.runner_id !== grant.machine.runner_id || message.payload.host_id !== grant.machine.host_id || !store.isCurrent(grant)) {
            socket.send(JSON.stringify(createHcpEnvelope("host.rejected",
              { reason: "Runner identity does not match its credential.", supported_protocol_versions: [HCP_VERSION] })));
            socket.close(1008, "identity mismatch");
            return;
          }
          // One live connection per credential: the newest replaces the older one.
          live.get(credentialId)?.socket.close(1008, "replaced by a newer connection");
          live.set(credentialId, runner);
          host.accept({ protocol_version: HCP_VERSION, heartbeat_interval_seconds: heartbeatIntervalSeconds });
        } else if (message.type === "host.capabilities.updated") {
          runner.capabilities = message.payload;
          runner.folders = message.payload.workspaces.map(({ id, path }) => ({ id, path }));
        } else if (message.type === "host.heartbeat" && !store.isCurrent(grant)) {
          // Backstop for revocations made elsewhere: the next heartbeat ends a fenced socket.
          socket.close(1008, "credential revoked");
        }
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        socket.close(1008, "protocol error");
      }
    });
    socket.on("close", () => {
      host.disconnect();
      if (live.get(credentialId) === runner) live.delete(credentialId);
    });
  };

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 8787, options.host ?? "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port ?? 8787;
  publicUrl = new URL(options.publicUrl ?? `http://${options.host ?? "127.0.0.1"}:${port}`);
  socketUrl = new URL("/hcp/runner", publicUrl);
  socketUrl.protocol = publicUrl.protocol === "https:" ? "wss:" : "ws:";

  return {
    url: publicUrl.origin,
    runnerUrl: socketUrl.toString(),
    close: async () => {
      for (const runner of live.values()) runner.socket.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      store.close();
    },
  };
}
