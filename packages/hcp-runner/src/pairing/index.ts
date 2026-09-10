import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { HCP_VERSION, runnerCredentialSchema, pairingCodeResponseSchema, pairingExchangeResponseSchema, connectionTokenResponseSchema, type PairingCodeResponse } from "@harness-control/protocol";
import { z } from "zod";

import type { RunnerConfig } from "../config/index.js";

const CREDENTIALS_FILE_VERSION = 1;
const DEFAULT_CONFIG_DIR = ".hcp-runner";
const DEFAULT_CREDENTIALS_FILE = "credentials.json";

const runnerCredentialsFileSchema = z
  .object({
    version: z.literal(CREDENTIALS_FILE_VERSION),
    credentials: z.array(runnerCredentialSchema),
  })
  .strict();

export type RunnerCredential = z.infer<typeof runnerCredentialSchema>;
export type RunnerCredentialsFile = z.infer<typeof runnerCredentialsFileSchema>;

export type ReferencePairingOptions = {
  controlPlaneUrl: string;
  runnerId: string;
  hostId: string;
  onPairingCode: (code: PairingCodeResponse) => void | Promise<void>;
  signal?: AbortSignal;
};

export type ReferencePairingResult = {
  controlPlaneUrl: string;
  credential: RunnerCredential;
  pairingCode: string;
  pairingUrl?: string;
};

export function defaultCredentialsPath(): string {
  return join(homedir(), DEFAULT_CONFIG_DIR, DEFAULT_CREDENTIALS_FILE);
}

export async function pairWithReferenceControlPlane(options: ReferencePairingOptions): Promise<ReferencePairingResult> {
  const baseUrl: URL = toHttpControlPlaneUrl(options.controlPlaneUrl);
  const exchangeSecret: string = randomBytes(32).toString("base64url");
  const codeResponse = await postJson(new URL("/pairing-codes", baseUrl), {
    runner_id: options.runnerId,
    host_id: options.hostId,
    protocol_version: HCP_VERSION,
    exchange_secret_hash: createHash("sha256").update(exchangeSecret).digest("hex"),
  }, pairingCodeResponseSchema, options.signal);
  await options.onPairingCode(codeResponse);
  const deadline: number = Math.min(Date.parse(codeResponse.expires_at), Date.now() + 10 * 60_000);
  while (Date.now() < deadline) {
    const timeout = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const exchange = await postJson(new URL("/pairing-exchange", baseUrl), {
      request_id: codeResponse.request_id,
      exchange_secret: exchangeSecret,
      runner_id: options.runnerId,
      host_id: options.hostId,
      protocol_version: HCP_VERSION,
    }, pairingExchangeResponseSchema, signal);
    if (exchange.status === "approved") {
      if (exchange.credential.runner_id !== options.runnerId || exchange.credential.host_id !== options.hostId
        || normalizeControlPlaneUrl(exchange.control_plane_url) !== normalizeControlPlaneUrl(options.controlPlaneUrl)
        || normalizeControlPlaneUrl(exchange.credential.control_plane_url) !== normalizeControlPlaneUrl(options.controlPlaneUrl)) {
        throw new Error("Pairing credential does not match the requested runner, host, or control plane.");
      }
      return {
        controlPlaneUrl: exchange.control_plane_url,
        credential: exchange.credential,
        pairingCode: codeResponse.pairing_code,
        pairingUrl: codeResponse.pairing_url,
      };
    }
    await delay(Math.min(codeResponse.poll_interval_seconds * 1000, Math.max(1, deadline - Date.now())), undefined, { signal: options.signal });
  }
  throw new Error("Pairing request expired. Start a new pairing request.");
}

export async function writeRunnerCredentials(path: string, credential: RunnerCredential): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const existing: RunnerCredentialsFile = await readRunnerCredentialsFileIfPresent(path);
  const credentials: RunnerCredential[] = existing.credentials.filter(
    (candidate: RunnerCredential): boolean =>
      !(
        candidate.control_plane_url === credential.control_plane_url &&
        candidate.runner_id === credential.runner_id &&
        candidate.host_id === credential.host_id
      ),
  );
  credentials.push(credential);
  const file: RunnerCredentialsFile = {
    version: CREDENTIALS_FILE_VERSION,
    credentials,
  };
  const temporaryPath: string = `${path}.${randomBytes(12).toString("hex")}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function loadRunnerCredential(config: RunnerConfig): Promise<RunnerCredential | undefined> {
  const path: string | undefined = config.credentials_path;
  if (!path) {
    return undefined;
  }

  const file: RunnerCredentialsFile = await readRunnerCredentialsFileIfPresent(path);
  const hostId: string = config.host_id ?? config.runner_id;
  return file.credentials.find(
    (credential: RunnerCredential): boolean =>
      credential.control_plane_url === config.control_plane_url &&
      credential.runner_id === config.runner_id &&
      credential.host_id === hostId,
  );
}

export async function requestConnectionToken(config: RunnerConfig, credential: RunnerCredential): Promise<string> {
  const response = await postJson(
    new URL("/runner-connection-token", toHttpControlPlaneUrl(config.control_plane_url)),
    {
      credential_id: credential.credential_id,
      credential_secret: credential.credential_secret,
      runner_id: config.runner_id,
      host_id: config.host_id ?? config.runner_id,
      protocol_version: HCP_VERSION,
      protocol_schema_sha256: createHash("sha256").update(readFileSync(createRequire(import.meta.url).resolve("@harness-control/protocol/schema.json"))).digest("hex"),
    },
    connectionTokenResponseSchema,
  );
  return response.connection_token;
}

export function normalizeControlPlaneUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Control plane URL must not contain credentials, query parameters, or a fragment.");
  }
  if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol === "https:") {
    url.protocol = "wss:";
  } else if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("Control plane URL must use http, https, ws, or wss.");
  }
  if (url.protocol === "ws:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("Remote control planes require HTTPS/WSS. Plain HTTP is allowed only on loopback.");
  }

  return url.toString();
}

function toHttpControlPlaneUrl(value: string): URL {
  const url = new URL(normalizeControlPlaneUrl(value));
  if (url.protocol === "ws:") {
    url.protocol = "http:";
  } else if (url.protocol === "wss:") {
    url.protocol = "https:";
  } else if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Control plane URL must use http, https, ws, or wss.");
  }
  return url;
}

async function readRunnerCredentialsFileIfPresent(path: string): Promise<RunnerCredentialsFile> {
  try {
    const raw: string = await readFile(path, "utf8");
    return runnerCredentialsFileSchema.parse(JSON.parse(raw));
  } catch (error: unknown) {
    if (isFileMissingError(error)) {
      return {
        version: CREDENTIALS_FILE_VERSION,
        credentials: [],
      };
    }
    throw error;
  }
}

async function postJson<T>(url: URL, body: unknown, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
  const response: Response = await fetch(url, {
    method: "POST",
    redirect: "error",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const raw: string = await response.text();
  const parsed: unknown = raw.length > 0 ? JSON.parse(raw) : {};
  if (!response.ok) {
    const message: string = errorMessageFromJson(parsed) ?? `${url.pathname} returned HTTP ${response.status}.`;
    throw new Error(message);
  }
  return schema.parse(parsed);
}

function errorMessageFromJson(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const message: unknown = (value as Record<string, unknown>).error;
  return typeof message === "string" && message.length > 0 ? message : undefined;
}

function isFileMissingError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
