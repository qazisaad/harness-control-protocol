#!/usr/bin/env node

import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { AccountUsageReader } from "./accounts/index.js";
import { homedir, hostname } from "node:os";

import { HCP_VERSION } from "@harness-control/protocol";

import { JsonlAuditLogger, defaultAuditLogPath } from "./audit/index.js";
import { loadRunnerConfig } from "./config/index.js";
import { RunnerConnection } from "./connection/index.js";
import { HarnessSessionManager } from "./harnesses/index.js";
import { consoleLogger } from "./logs/index.js";
import { connectMachine, parseConnectOptions } from "./connect.js";
import { ALREADY_RUNNING, ConnectionOwnership, acquireStateOwnership, connectionDirectory, type StateOwnership } from "./ownership.js";
import { createDevelopmentHmacProofSigner } from "./mcp/McpAttachmentClient.js";
import { JsonRunnerStateStore, defaultRunnerStatePath } from "./state/index.js";
import {
  defaultCredentialsPath,
  loadRunnerCredential,
  normalizeControlPlaneUrl,
  pairWithReferenceControlPlane,
  requestConnectionToken,
  writeRunnerCredentials,
  type RunnerCredential,
} from "./pairing/index.js";

const RUNNER_VERSION: string = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

type PairOptions = {
  controlPlaneUrl: string;
  runnerId: string;
  hostId: string;
  outPath?: string;
  credentialsPath?: string;
  offline: boolean;
};

export async function main(argv: string[] = process.argv.slice(2), home: string = homedir()): Promise<number> {
  const command: string | undefined = argv[0];

  if (command === "connect") {
    try { return await connectMachine(parseConnectOptions(argv.slice(1), home), runMachine); }
    catch (error) { console.error(error instanceof Error ? error.message : String(error)); return 1; }
  }

  if (command === "version") {
    console.log(`hcp-runner ${RUNNER_VERSION} (${HCP_VERSION})`);
    return 0;
  }

  if (command === "pair") {
    let pairOptions: PairOptions;
    let controlPlaneUrl: string;
    try {
      pairOptions = parsePairOptions(argv.slice(1));
      controlPlaneUrl = normalizeControlPlaneUrl(pairOptions.controlPlaneUrl);
    } catch (error: unknown) {
      console.error(error instanceof Error ? error.message : "Invalid pair arguments.");
      console.error(
        "Usage: hcp-runner pair <control-plane-url> [--runner-id id] [--host-id id] [--out path] [--credentials-out path] [--offline]",
      );
      return 1;
    }

    if (pairOptions.offline) {
      const config = {
        runner_id: pairOptions.runnerId,
        host_id: pairOptions.hostId,
        control_plane_url: controlPlaneUrl,
        workspaces: [],
        provider_instances: [],
      };
      const serializedConfig: string = `${JSON.stringify(config, null, 2)}\n`;

      if (pairOptions.outPath) {
        await writeFile(pairOptions.outPath, serializedConfig, { mode: 0o600 });
        console.log(`Wrote offline runner config to ${pairOptions.outPath}`);
      } else {
        console.log(serializedConfig.trimEnd());
      }
      return 0;
    }

    const credentialsPath: string = pairOptions.credentialsPath ?? defaultCredentialsPath();
    const pairing = await pairWithReferenceControlPlane({
      controlPlaneUrl,
      runnerId: pairOptions.runnerId,
      hostId: pairOptions.hostId,
      onPairingCode: (code) => { console.error(`Approve runner pairing at ${code.pairing_url} (code: ${code.pairing_code}). Waiting for approval…`); },
    });
    await writeRunnerCredentials(credentialsPath, pairing.credential);
    const config = {
      runner_id: pairOptions.runnerId,
      host_id: pairOptions.hostId,
      control_plane_url: pairing.controlPlaneUrl,
      credentials_path: credentialsPath,
      workspaces: [],
      provider_instances: [],
    };
    const serializedConfig: string = `${JSON.stringify(config, null, 2)}\n`;

    if (pairOptions.outPath) {
      await writeFile(pairOptions.outPath, serializedConfig, { mode: 0o600 });
      console.log(`Wrote paired runner config to ${pairOptions.outPath}`);
      console.log(`Stored runner credentials at ${credentialsPath}`);
    } else {
      console.log(serializedConfig.trimEnd());
    }
    return 0;
  }

  if (command === "accounts") {
    const configPath = parseConfigPath(argv.slice(1));
    if (!configPath) { console.error("Usage: hcp-runner accounts --config <path>"); return 1; }
    const reader = new AccountUsageReader(await loadRunnerConfig(configPath));
    try { console.log(JSON.stringify(await reader.read(randomUUID(), {}), null, 2)); }
    finally { await reader.close(); }
    return 0;
  }

  if (command === "run") {
    const configPath: string | undefined = parseConfigPath(argv.slice(1));
    if (!configPath) {
      console.error("Usage: hcp-runner run --config <path>");
      return 1;
    }

    try {
      const config = await loadRunnerConfig(configPath);
      const ownership = ConnectionOwnership.acquire(connectionDirectory(config.control_plane_url, home));
      if (ownership === "already_running") {
        console.error(ALREADY_RUNNING + " The requested config was not started.");
        return 1;
      }
      try { return await runMachine(configPath); }
      finally { ownership.release(); }
    } catch (error) { console.error(error instanceof Error ? error.message : String(error)); return 1; }
  }

  console.log("Usage: hcp-runner <version|connect|pair|run>");
  return command ? 1 : 0;
}

async function runMachine(configPath: string): Promise<number> {
  let connection: RunnerConnection | undefined;
  let stateOwnership: StateOwnership | undefined;
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    if (!connection) process.exit(0);
    void connection.close().then(() => process.exit(0), (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    const config = await loadRunnerConfig(configPath);
    const statePath = config.state_path ?? defaultRunnerStatePath(config.runner_id);
    stateOwnership = acquireStateOwnership(statePath);
    const credential: RunnerCredential | undefined = await loadRunnerCredential(config);
    const stateStore = new JsonRunnerStateStore(stateOwnership.path);
    const harnessSessions = new HarnessSessionManager(config, {
      auditLogger: new JsonlAuditLogger(defaultAuditLogPath()),
      stateStore,
      ...(credential ? { mcpProofSigner: createDevelopmentHmacProofSigner(credential.mcp_proof_secret) } : {}),
    });
    connection = new RunnerConnection({
      config,
      runnerVersion: RUNNER_VERSION,
      configPath,
      harnessSessions,
      ...(credential ? { connectionTokenProvider: () => requestConnectionToken(config, credential) } : {}),
      onLog: (message: string) => consoleLogger.info(message),
    });
    await connection.connect();
    consoleLogger.info(`Runner '${config.runner_id}' connected to ${config.control_plane_url}.`);
    return await new Promise<number>(() => undefined);
  } finally {
    try { if (connection && !stopping) await connection.close(); }
    finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      stateOwnership?.release();
    }
  }
}

function parseConfigPath(args: string[]): string | undefined {
  const configFlagIndex: number = args.indexOf("--config");
  if (configFlagIndex === -1) {
    return undefined;
  }

  return args[configFlagIndex + 1];
}

function parsePairOptions(args: string[]): PairOptions {
  const controlPlaneUrl: string | undefined = args[0];
  if (!controlPlaneUrl) {
    throw new Error("Missing control plane URL.");
  }

  const defaultHostId: string = hostname().replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
  let runnerId = `runner-${defaultHostId}`;
  let hostId = defaultHostId;
  let outPath: string | undefined;
  let credentialsPath: string | undefined;
  let offline = false;

  for (let index = 1; index < args.length; index += 1) {
    const arg: string = args[index] ?? "";
    if (arg === "--runner-id") {
      const value: string | undefined = args[index + 1];
      if (!value) {
        throw new Error("--runner-id requires a value.");
      }
      runnerId = value;
      index += 1;
      continue;
    }
    if (arg === "--host-id") {
      const value: string | undefined = args[index + 1];
      if (!value) {
        throw new Error("--host-id requires a value.");
      }
      hostId = value;
      index += 1;
      continue;
    }
    if (arg === "--out") {
      const value: string | undefined = args[index + 1];
      if (!value) {
        throw new Error("--out requires a value.");
      }
      outPath = value;
      index += 1;
      continue;
    }
    if (arg === "--credentials-out") {
      const value: string | undefined = args[index + 1];
      if (!value) {
        throw new Error("--credentials-out requires a value.");
      }
      credentialsPath = value;
      index += 1;
      continue;
    }
    if (arg === "--offline") {
      offline = true;
      continue;
    }
    throw new Error(`Unknown pair argument: ${arg}`);
  }

  return {
    controlPlaneUrl,
    runnerId,
    hostId,
    offline,
    ...(outPath ? { outPath } : {}),
    ...(credentialsPath ? { credentialsPath } : {}),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().then((exitCode: number) => {
    process.exitCode = exitCode;
  });
}
