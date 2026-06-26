#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import { hostname } from "node:os";

import { HCP_VERSION } from "@hcp-runner/protocol";

import { JsonlAuditLogger, defaultAuditLogPath } from "./audit/index.js";
import { loadRunnerConfig } from "./config/index.js";
import { RunnerConnection } from "./connection/index.js";
import { HarnessSessionManager } from "./harnesses/index.js";
import { consoleLogger } from "./logs/index.js";
import { createDevelopmentHmacProofSigner } from "./mcp/McpAttachmentClient.js";
import {
  defaultCredentialsPath,
  loadRunnerCredential,
  normalizeControlPlaneUrl,
  pairWithReferenceControlPlane,
  requestConnectionToken,
  writeRunnerCredentials,
  type RunnerCredential,
} from "./pairing/index.js";

const RUNNER_VERSION = "0.0.0";

type PairOptions = {
  controlPlaneUrl: string;
  runnerId: string;
  hostId: string;
  outPath?: string;
  credentialsPath?: string;
  offline: boolean;
};

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const command: string | undefined = argv[0];

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

  if (command === "run") {
    const configPath: string | undefined = parseConfigPath(argv.slice(1));
    if (!configPath) {
      console.error("Usage: hcp-runner run --config <path>");
      return 1;
    }

    const config = await loadRunnerConfig(configPath);
    const credential: RunnerCredential | undefined = await loadRunnerCredential(config);
    const harnessSessions = new HarnessSessionManager(config, {
      auditLogger: new JsonlAuditLogger(defaultAuditLogPath()),
      ...(credential
        ? { mcpProofSigner: createDevelopmentHmacProofSigner(credential.mcp_proof_secret ?? credential.credential_secret) }
        : {}),
    });
    const connection = new RunnerConnection({
      config,
      runnerVersion: RUNNER_VERSION,
      harnessSessions,
      ...(credential
        ? {
            connectionTokenProvider: async (): Promise<string> => requestConnectionToken(config, credential),
          }
        : {}),
      onLog: (message: string) => {
        consoleLogger.info(message);
      },
    });

    await connection.connect();
    consoleLogger.info(`Runner '${config.runner_id}' connected to ${config.control_plane_url}.`);

    const close = async (): Promise<void> => {
      await connection.close();
    };

    process.once("SIGINT", () => {
      close().then(() => process.exit(0));
    });
    process.once("SIGTERM", () => {
      close().then(() => process.exit(0));
    });

    return new Promise<number>(() => undefined);
  }

  console.log("Usage: hcp-runner <version|pair|run>");
  return command ? 1 : 0;
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

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((exitCode: number) => {
    process.exitCode = exitCode;
  });
}
