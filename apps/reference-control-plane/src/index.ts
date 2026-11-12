#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { startReferenceControlPlane } from "./server.js";

export { startReferenceControlPlane, type ReferenceControlPlane, type ReferenceControlPlaneOptions } from "./server.js";
export { ControlPlaneStore } from "./store.js";

/** The digest of the protocol schema installed with this server; pin it so only tested runner builds connect. */
export function installedProtocolSchemaSha256(): string {
  const path = createRequire(import.meta.url).resolve("@harness-control/protocol/schema.json");
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function main(): Promise<void> {
  const adminToken = process.env.HCP_ADMIN_TOKEN;
  if (!adminToken || adminToken.length < 24) throw new Error("Set HCP_ADMIN_TOKEN to a random value of at least 24 characters.");
  const server = await startReferenceControlPlane({
    databasePath: process.env.HCP_DATABASE ?? "hcp-control-plane.sqlite",
    adminToken,
    protocolSchemaSha256: installedProtocolSchemaSha256(),
    host: process.env.HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? 8787),
    ...(process.env.HCP_PUBLIC_URL ? { publicUrl: process.env.HCP_PUBLIC_URL } : {}),
  });
  console.log(`HCP reference control plane on ${server.url}`);
  console.log(`Connect a machine: npx @harness-control/runner connect ${server.runnerUrl}`);
  const stop = () => { server.close().then(() => process.exit(0), (error: unknown) => { console.error(error); process.exit(1); }); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
}
