import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { HCP_VERSION } from "@harness-control/protocol";
import { z } from "zod";

import type { RunnerConfig } from "../config/index.js";

const CREDENTIALS_FILE_VERSION = 1;
const DEFAULT_CONFIG_DIR = ".hcp-runner";
const DEFAULT_CREDENTIALS_FILE = "credentials.json";

const runnerCredentialSchema = z
  .object({
    credential_id: z.string().min(1),
    credential_secret: z.string().min(1),
    runner_id: z.string().min(1),
    host_id: z.string().min(1),
    control_plane_url: z.string().url(),
    issued_at: z.string().datetime({ offset: true }),
    mcp_proof_secret: z.string().min(1).optional(),
  })
  .strict();

const runnerCredentialsFileSchema = z
  .object({
    version: z.literal(CREDENTIALS_FILE_VERSION),
    credentials: z.array(runnerCredentialSchema),
  })
  .strict();

const pairingCodeResponseSchema = z
  .object({
    pairing_code: z.string().min(1),
    pairing_url: z.string().url().optional(),
    expires_at: z.string().datetime({ offset: true }),
  })
  .strict();

const pairingExchangeResponseSchema = z
  .object({
    control_plane_url: z.string().url(),
    credential: runnerCredentialSchema,
  })
  .strict();

const connectionTokenResponseSchema = z
  .object({
    connection_token: z.string().min(1),
    expires_at: z.string().datetime({ offset: true }),
  })
  .strict();

export type RunnerCredential = z.infer<typeof runnerCredentialSchema>;
export type RunnerCredentialsFile = z.infer<typeof runnerCredentialsFileSchema>;

export type ReferencePairingOptions = {
  controlPlaneUrl: string;
  runnerId: string;
  hostId: string;
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
  const codeResponse = await postJson(
    new URL("/pairing-codes", baseUrl),
    {
      runner_id: options.runnerId,
      host_id: options.hostId,
      protocol_version: HCP_VERSION,
    },
    pairingCodeResponseSchema,
  );
  const exchangeResponse = await postJson(
    new URL("/pairing-exchange", baseUrl),
    {
      pairing_code: codeResponse.pairing_code,
      runner_id: options.runnerId,
      host_id: options.hostId,
      protocol_version: HCP_VERSION,
    },
    pairingExchangeResponseSchema,
  );

  return {
    controlPlaneUrl: exchangeResponse.control_plane_url,
    credential: exchangeResponse.credential,
    pairingCode: codeResponse.pairing_code,
    ...(codeResponse.pairing_url ? { pairingUrl: codeResponse.pairing_url } : {}),
  };
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
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
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
    },
    connectionTokenResponseSchema,
  );
  return response.connection_token;
}

export function normalizeControlPlaneUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol === "https:") {
    url.protocol = "wss:";
  } else if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("Control plane URL must use http, https, ws, or wss.");
  }

  return url.toString();
}

function toHttpControlPlaneUrl(value: string): URL {
  const url = new URL(value);
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

async function postJson<T>(url: URL, body: unknown, schema: z.ZodType<T>): Promise<T> {
  const response: Response = await fetch(url, {
    method: "POST",
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
