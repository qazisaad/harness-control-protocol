import { z } from "zod";

const identity = { runner_id: z.string().min(1).max(200), host_id: z.string().min(1).max(200), protocol_version: z.literal("hcp.v0") };
export const pairingCreateRequestSchema = z.object({
  ...identity,
  exchange_secret_hash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const pairingCodeResponseSchema = z.object({
  request_id: z.string().min(1),
  pairing_code: z.string().min(1),
  pairing_url: z.string().url(),
  expires_at: z.string().datetime({ offset: true }),
  poll_interval_seconds: z.number().int().min(1).max(30),
}).strict();
export const pairingExchangeRequestSchema = z.object({
  ...identity,
  request_id: z.string().min(1),
  exchange_secret: z.string().min(32).max(256),
}).strict();
export const runnerCredentialSchema = z.object({
  credential_id: z.string().min(1),
  credential_secret: z.string().min(1),
  runner_id: z.string().min(1),
  host_id: z.string().min(1),
  control_plane_url: z.string().url(),
  issued_at: z.string().datetime({ offset: true }),
  mcp_proof_secret: z.string().min(1),
}).strict();
export const pairingExchangeResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }).strict(),
  z.object({ status: z.literal("approved"), control_plane_url: z.string().url(), credential: runnerCredentialSchema }).strict(),
]);
export const connectionTokenRequestSchema = z.object({
  ...identity,
  protocol_schema_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  credential_id: z.string().min(1),
  credential_secret: z.string().min(1).max(256),
}).strict();
export const connectionTokenResponseSchema = z.object({
  connection_token: z.string().min(1),
  expires_at: z.string().datetime({ offset: true }),
}).strict();
export type PairingCodeResponse = z.infer<typeof pairingCodeResponseSchema>;
