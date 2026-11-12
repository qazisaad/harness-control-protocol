import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  HCP_VERSION,
  PAIRING_HTTP_PATHS,
  connectionTokenResponseSchema,
  createHcpEnvelope,
  hcpHostAcceptedPayloadSchema,
  pairingCodeResponseSchema,
  pairingExchangeResponseSchema,
  type HcpHostHelloPayload,
  type PairingCodeResponse,
} from "@harness-control/protocol";
import WebSocket from "ws";
import type { z } from "zod";

import { normalizeControlPlaneUrl, protocolSchemaSha256, type RunnerCredential } from "../pairing/index.js";

/**
 * Black-box lifecycle checks for an HCP control plane. The checks act as a runner over
 * HTTP and WebSocket only, so they apply to a control plane written in any language.
 * Approval, decline and revocation are product actions, so the control plane under test
 * exposes them through test hooks. See docs/control-plane/lifecycle.md.
 */

export type ControlPlaneTestHooks = {
  approve: (code: PairingCodeResponse) => Promise<void>;
  decline: (code: PairingCodeResponse) => Promise<void>;
  revoke: (credential: RunnerCredential) => Promise<void>;
};

export type ControlPlaneCheckOptions = {
  controlPlaneUrl: string;
  hooks: ControlPlaneTestHooks;
  /** Longest wait for a revoked live socket to close. Defaults to one heartbeat interval plus 5 seconds. */
  revokeTimeoutMs?: number;
  /** Longest wait for a socket to be accepted or refused. */
  socketTimeoutMs?: number;
  onResult?: (result: ControlPlaneCheckResult) => void;
};

export type ControlPlaneCheckResult = {
  id: string;
  title: string;
  outcome: "pass" | "fail" | "skip";
  detail?: string;
};

/** Every check, in run order. The spec in docs/control-plane/lifecycle.md uses the same ids. */
export const CONTROL_PLANE_CHECKS = [
  ["pairing.create", "Creating a pairing request returns a valid pairing code"],
  ["pairing.create_rejects_invalid", "A malformed pairing request is refused"],
  ["pairing.exchange_pending", "Exchange before approval reports pending"],
  ["pairing.exchange_rejects_wrong_secret", "Exchange with the wrong secret is refused"],
  ["pairing.exchange_approved", "Exchange after approval returns a credential bound to the runner"],
  ["pairing.exchange_single_use", "A second exchange of the same request is refused"],
  ["pairing.declined", "Exchange after decline is refused"],
  ["token.issue", "A credential gets a short-lived connection token"],
  ["token.rejects_wrong_secret", "A token request with the wrong credential secret is refused"],
  ["token.rejects_unknown_schema", "A token request with an unpinned protocol schema digest is refused"],
  ["socket.rejects_missing_token", "A socket without a connection token is refused"],
  ["socket.accepts_token", "A socket with a valid token and matching hello is accepted"],
  ["socket.rejects_reused_token", "A connection token works only once"],
  ["socket.rejects_identity_mismatch", "A hello whose runner or host differs from the credential is refused"],
  ["socket.single_live_connection", "At most one live connection per credential"],
  ["revoke.closes_socket", "Revocation closes the live socket within the promised time"],
  ["revoke.refuses_tokens", "A revoked credential cannot get new tokens"],
  ["revoke.refuses_unused_token", "A token issued before revocation cannot connect afterwards"],
] as const;

export type ControlPlaneCheckId = (typeof CONTROL_PLANE_CHECKS)[number][0];

class CheckFailed extends Error {}

function ensure(condition: boolean, message: string): asserts condition {
  if (!condition) throw new CheckFailed(message);
}

type HttpReply = { status: number; body: unknown };

async function post(url: URL, body: unknown): Promise<HttpReply> {
  const response = await fetch(url, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  let parsed: unknown = raw;
  try { parsed = raw.length > 0 ? JSON.parse(raw) : {}; } catch (error: unknown) {
    // A non-JSON error page is still a refusal; keep the text for the report.
    if (!(error instanceof SyntaxError)) throw error;
  }
  return { status: response.status, body: parsed };
}

function parseOk<T>(reply: HttpReply, schema: z.ZodType<T>, what: string): T {
  ensure(reply.status >= 200 && reply.status < 300, `${what} returned HTTP ${reply.status}: ${JSON.stringify(reply.body)}`);
  const parsed = schema.safeParse(reply.body);
  ensure(parsed.success, `${what} body does not match the pairing schema: ${parsed.error?.message ?? ""}`);
  return parsed.data;
}

function requireRefused(reply: HttpReply, what: string): void {
  ensure(reply.status >= 400 && reply.status < 500, `${what} should be refused with HTTP 4xx, got ${reply.status}.`);
}

/** One runner-side socket. It answers accept with heartbeats at the negotiated interval, like a runner. */
class ProbeSocket {
  readonly socket: WebSocket;
  readonly opened: Promise<void>;
  readonly closed: Promise<{ code: number; reason: string }>;
  #heartbeat: NodeJS.Timeout | undefined;
  heartbeatIntervalSeconds: number | undefined;

  constructor(url: string, private readonly hello: HcpHostHelloPayload, token: string | undefined) {
    this.socket = new WebSocket(url, token === undefined ? {} : { headers: { Authorization: `Bearer ${token}` } });
    this.opened = new Promise((resolve) => this.socket.once("open", () => resolve()));
    this.closed = new Promise((resolve) => this.socket.once("close", (code, reason) => {
      clearInterval(this.#heartbeat);
      resolve({ code, reason: reason.toString() });
    }));
    // A refused upgrade (for example HTTP 401) surfaces as an error followed by close.
    this.socket.on("error", () => undefined);
  }

  get isOpen(): boolean { return this.socket.readyState === WebSocket.OPEN; }

  /** Sends hello and resolves "accepted" or "refused"; no answer within the timeout counts as refused. */
  async handshake(timeoutMs: number): Promise<"accepted" | "refused"> {
    const outcome = new Promise<"accepted" | "refused">((resolve) => {
      const timer = setTimeout(() => resolve("refused"), timeoutMs);
      this.closed.then(() => { clearTimeout(timer); resolve("refused"); });
      this.socket.on("message", (raw) => {
        let message: { type?: string; payload?: unknown };
        try { message = JSON.parse(raw.toString()) as typeof message; } catch { return; }
        if (message.type === "host.rejected") { clearTimeout(timer); resolve("refused"); }
        if (message.type === "host.accepted") {
          const accepted = hcpHostAcceptedPayloadSchema.safeParse(message.payload);
          clearTimeout(timer);
          if (!accepted.success) { resolve("refused"); return; }
          this.heartbeatIntervalSeconds = accepted.data.heartbeat_interval_seconds;
          this.#heartbeat = setInterval(() => this.send("host.heartbeat", { host_id: this.hello.host_id, status: "online", active_sessions: 0 }),
            accepted.data.heartbeat_interval_seconds * 1000);
          resolve("accepted");
        }
      });
    });
    await Promise.race([this.opened, this.closed]);
    if (this.isOpen) this.send("host.hello", this.hello);
    return outcome;
  }

  send(type: "host.hello" | "host.heartbeat", payload: unknown): void {
    if (this.isOpen) this.socket.send(JSON.stringify(createHcpEnvelope(type, payload)));
  }

  async close(): Promise<void> {
    clearInterval(this.#heartbeat);
    if (this.socket.readyState === WebSocket.CLOSED) return;
    this.socket.close(1000, "check complete");
    await Promise.race([this.closed, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    this.socket.terminate();
  }
}

type Runner = { runnerId: string; hostId: string; secret: string };

function newRunner(label: string): Runner {
  const suffix = randomUUID().slice(0, 8);
  return { runnerId: `hcp-check-${label}-${suffix}`, hostId: `hcp-check-host-${suffix}`, secret: randomBytes(32).toString("base64url") };
}

function identity(runner: Runner) {
  return { runner_id: runner.runnerId, host_id: runner.hostId, protocol_version: HCP_VERSION };
}

function hello(runner: Runner, hostId = runner.hostId): HcpHostHelloPayload {
  return { runner_id: runner.runnerId, host_id: hostId, runner_version: "hcp-control-plane-check",
    supported_protocol_versions: [HCP_VERSION], capabilities: [] };
}

export async function checkControlPlane(options: ControlPlaneCheckOptions): Promise<ControlPlaneCheckResult[]> {
  const socketUrl = normalizeControlPlaneUrl(options.controlPlaneUrl);
  const httpBase = new URL(socketUrl);
  httpBase.protocol = httpBase.protocol === "wss:" ? "https:" : "http:";
  const url = (path: string) => new URL(path, httpBase);
  const socketTimeoutMs = options.socketTimeoutMs ?? 10_000;
  const results: ControlPlaneCheckResult[] = [];
  const sockets: ProbeSocket[] = [];
  const titles = new Map<string, string>(CONTROL_PLANE_CHECKS);
  let blockedBy: string | undefined;

  const run = async (id: ControlPlaneCheckId, body: () => Promise<string | void>, prerequisite = true): Promise<boolean> => {
    let result: ControlPlaneCheckResult;
    if (blockedBy !== undefined && prerequisite) {
      result = { id, title: titles.get(id)!, outcome: "skip", detail: `Needs ${blockedBy} to pass first.` };
    } else {
      try {
        const detail = await body();
        result = { id, title: titles.get(id)!, outcome: "pass", ...(detail ? { detail } : {}) };
      } catch (error: unknown) {
        if (!(error instanceof Error)) throw error;
        result = { id, title: titles.get(id)!, outcome: "fail", detail: error.message };
      }
    }
    results.push(result);
    options.onResult?.(result);
    return result.outcome === "pass";
  };
  const gate = (passed: boolean, id: string) => { if (!passed && blockedBy === undefined) blockedBy = id; };

  const createPairing = async (runner: Runner): Promise<PairingCodeResponse> => parseOk(await post(url(PAIRING_HTTP_PATHS.create), {
    ...identity(runner), exchange_secret_hash: createHash("sha256").update(runner.secret).digest("hex"),
  }), pairingCodeResponseSchema, "pairing create");
  const exchange = (runner: Runner, code: PairingCodeResponse, secret = runner.secret) =>
    post(url(PAIRING_HTTP_PATHS.exchange), { ...identity(runner), request_id: code.request_id, exchange_secret: secret });
  const tokenRequest = (runner: Runner, credential: RunnerCredential, overrides: Record<string, unknown> = {}) =>
    post(url(PAIRING_HTTP_PATHS.connectionToken), { ...identity(runner), credential_id: credential.credential_id,
      credential_secret: credential.credential_secret, protocol_schema_sha256: protocolSchemaSha256(), ...overrides });
  const token = async (runner: Runner, credential: RunnerCredential): Promise<string> =>
    parseOk(await tokenRequest(runner, credential), connectionTokenResponseSchema, "connection token").connection_token;
  const open = (payload: HcpHostHelloPayload, connectionToken: string | undefined): ProbeSocket => {
    const probe = new ProbeSocket(socketUrl, payload, connectionToken);
    sockets.push(probe);
    return probe;
  };

  const runner = newRunner("main");
  let code: PairingCodeResponse | undefined;
  let credential: RunnerCredential | undefined;
  let live: ProbeSocket | undefined;

  try {
    gate(await run("pairing.create", async () => { code = await createPairing(runner); }), "pairing.create");
    await run("pairing.create_rejects_invalid", async () => {
      requireRefused(await post(url(PAIRING_HTTP_PATHS.create), { ...identity(runner), exchange_secret_hash: "not-a-hash" }), "Malformed pairing create");
    }, false);
    gate(await run("pairing.exchange_pending", async () => {
      const reply = parseOk(await exchange(runner, code!), pairingExchangeResponseSchema, "pairing exchange");
      ensure(reply.status === "pending", `Expected pending before approval, got ${reply.status}.`);
    }), "pairing.exchange_pending");
    await run("pairing.exchange_rejects_wrong_secret", async () => {
      requireRefused(await exchange(runner, code!, randomBytes(32).toString("base64url")), "Exchange with the wrong secret");
    });
    gate(await run("pairing.exchange_approved", async () => {
      await options.hooks.approve(code!);
      const reply = parseOk(await exchange(runner, code!), pairingExchangeResponseSchema, "pairing exchange");
      ensure(reply.status === "approved", `Expected approved after the approve hook, got ${reply.status}.`);
      ensure(reply.credential.runner_id === runner.runnerId && reply.credential.host_id === runner.hostId,
        "The credential must be bound to the runner_id and host_id that requested pairing.");
      // Runners refuse a credential for any other URL, so it must name the exact socket URL under test.
      ensure(normalizeControlPlaneUrl(reply.control_plane_url) === socketUrl && normalizeControlPlaneUrl(reply.credential.control_plane_url) === socketUrl,
        `control_plane_url must equal the runner URL under test (${socketUrl}), got ${reply.control_plane_url}.`);
      credential = reply.credential;
    }), "pairing.exchange_approved");
    await run("pairing.exchange_single_use", async () => {
      requireRefused(await exchange(runner, code!), "A second exchange");
    });
    await run("pairing.declined", async () => {
      const declinedRunner = newRunner("declined");
      const declinedCode = await createPairing(declinedRunner);
      await options.hooks.decline(declinedCode);
      requireRefused(await exchange(declinedRunner, declinedCode), "Exchange after decline");
    }, false);

    const tokens: string[] = [];
    gate(await run("token.issue", async () => { tokens.push(await token(runner, credential!)); }), "token.issue");
    await run("token.rejects_wrong_secret", async () => {
      requireRefused(await tokenRequest(runner, credential!, { credential_secret: randomBytes(32).toString("base64url") }), "Token with the wrong secret");
    });
    await run("token.rejects_unknown_schema", async () => {
      requireRefused(await tokenRequest(runner, credential!, { protocol_schema_sha256: "0".repeat(64) }), "Token with an unpinned schema digest");
    });

    await run("socket.rejects_missing_token", async () => {
      const outcome = await open(hello(runner), undefined).handshake(socketTimeoutMs);
      ensure(outcome === "refused", "The control plane accepted a socket without a connection token.");
    }, false);
    gate(await run("socket.accepts_token", async () => {
      live = open(hello(runner), tokens[0]);
      ensure(await live.handshake(socketTimeoutMs) === "accepted", "A valid token and matching hello were not accepted.");
      return `Heartbeat interval ${live.heartbeatIntervalSeconds}s.`;
    }), "socket.accepts_token");
    await run("socket.rejects_reused_token", async () => {
      ensure(await open(hello(runner), tokens[0]).handshake(socketTimeoutMs) === "refused", "The same connection token connected twice.");
    });
    await run("socket.rejects_identity_mismatch", async () => {
      const mismatch = open(hello(runner, `${runner.hostId}-other`), await token(runner, credential!));
      ensure(await mismatch.handshake(socketTimeoutMs) === "refused", "A hello with a different host_id was accepted.");
    });
    await run("socket.single_live_connection", async () => {
      const second = open(hello(runner), await token(runner, credential!));
      const outcome = await second.handshake(socketTimeoutMs);
      // Either newest-wins or first-wins is valid; both sockets staying live is not.
      const deadline = Date.now() + socketTimeoutMs;
      while (outcome === "accepted" && live!.isOpen && second.isOpen && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
      ensure(!(live!.isOpen && second.isOpen), "Two live connections stayed open for one credential.");
      if (second.isOpen) { live = second; return "The newer connection replaced the older one."; }
      return "The existing connection was kept and the newer one refused.";
    });

    if (live === undefined || !live.isOpen) {
      if (credential !== undefined) {
        live = open(hello(runner), await token(runner, credential));
        await live.handshake(socketTimeoutMs);
      }
    }
    const unusedToken = credential === undefined ? undefined : await token(runner, credential).catch(() => undefined);
    await run("revoke.closes_socket", async () => {
      ensure(live !== undefined && live.isOpen, "No live socket to revoke.");
      const limitMs = options.revokeTimeoutMs ?? (live.heartbeatIntervalSeconds ?? 30) * 1000 + 5_000;
      const started = Date.now();
      await options.hooks.revoke(credential!);
      const closed = await Promise.race([live.closed.then(() => true), new Promise<false>((resolve) => setTimeout(() => resolve(false), limitMs))]);
      ensure(closed, `The live socket was still open ${Math.round(limitMs / 1000)}s after revocation.`);
      return `Closed ${Date.now() - started} ms after revocation.`;
    });
    await run("revoke.refuses_tokens", async () => {
      requireRefused(await tokenRequest(runner, credential!), "Token request after revocation");
    });
    await run("revoke.refuses_unused_token", async () => {
      ensure(unusedToken !== undefined, "Could not mint a token before revocation.");
      ensure(await open(hello(runner), unusedToken).handshake(socketTimeoutMs) === "refused", "A token minted before revocation still connected.");
    });
  } finally {
    await Promise.all(sockets.map((probe) => probe.close()));
  }
  return results;
}

/**
 * Hooks served by the control plane under test, in test environments only:
 * POST {base}/approve and {base}/decline with {request_id, pairing_code}, and
 * POST {base}/revoke with {credential_id}. Any 2xx response means done.
 */
export function httpTestHooks(baseUrl: string, bearerToken?: string): ControlPlaneTestHooks {
  const call = async (path: string, body: Record<string, string>): Promise<void> => {
    const response = await fetch(new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`), {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: { "content-type": "application/json", ...(bearerToken ? { authorization: `Bearer ${bearerToken}` } : {}) },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new CheckFailed(`Test hook ${path} returned HTTP ${response.status}: ${await response.text()}`);
  };
  return {
    approve: (code) => call("approve", { request_id: code.request_id, pairing_code: code.pairing_code }),
    decline: (code) => call("decline", { request_id: code.request_id, pairing_code: code.pairing_code }),
    revoke: (credential) => call("revoke", { credential_id: credential.credential_id }),
  };
}
