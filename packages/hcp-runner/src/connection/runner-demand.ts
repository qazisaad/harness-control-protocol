import { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { RunnerCredential } from "../pairing/index.js";

export type RunnerDemandState = {generation: number; pending: boolean};
export interface RunnerDemandSource {
  subscribe(update: (state: RunnerDemandState) => void, unavailable: () => void): () => void;
}
const stateSchema = z.object({generation: z.number().finite().nonnegative(), pending: z.boolean()}).strict();

/** The control plane authorizes a metadata-only subscription outside its Fly machine.
 * No periodic HTTP probes, provider scans, connection tokens or user data are sent. */
export function convexRunnerDemandSource(url: string, credential: RunnerCredential): RunnerDemandSource {
  return {subscribe(update, unavailable) {
    const client = new ConvexClient(url);
    const ref = makeFunctionReference<"query", {credential_id: string; credential_hash: string; runner_id: string; host_id: string}, RunnerDemandState>("hcp:runnerDemand");
    const stop = client.onUpdate(ref, {credential_id: credential.credential_id,
      credential_hash: createHash("sha256").update(credential.credential_secret).digest("hex"), runner_id: credential.runner_id, host_id: credential.host_id},
      result => {const parsed = stateSchema.safeParse(result); if (parsed.success) update(parsed.data); else unavailable();}, unavailable);
    const stopConnection = client.subscribeToConnectionState(state => {if (!state.isWebSocketConnected) unavailable(); else {const value = stop.getCurrentValue(); if (value) update(value);}});
    return () => {stop(); stopConnection(); void client.close();};
  }};
}
