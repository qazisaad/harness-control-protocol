#!/usr/bin/env node

import { HCP_VERSION } from "@hcp-runner/protocol";

import { loadRunnerConfig } from "./config/index.js";
import { RunnerConnection } from "./connection/index.js";
import { consoleLogger } from "./logs/index.js";

const RUNNER_VERSION = "0.0.0";

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const command: string | undefined = argv[0];

  if (command === "version") {
    console.log(`hcp-runner ${RUNNER_VERSION} (${HCP_VERSION})`);
    return 0;
  }

  if (command === "pair") {
    const controlPlaneUrl: string | undefined = argv[1];
    if (!controlPlaneUrl) {
      console.error("Usage: hcp-runner pair <control-plane-url>");
      return 1;
    }

    console.error(`Pairing is not implemented yet for ${controlPlaneUrl}.`);
    return 1;
  }

  if (command === "run") {
    const configPath: string | undefined = parseConfigPath(argv.slice(1));
    if (!configPath) {
      console.error("Usage: hcp-runner run --config <path>");
      return 1;
    }

    const config = await loadRunnerConfig(configPath);
    const connection = new RunnerConnection({
      config,
      runnerVersion: RUNNER_VERSION,
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

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((exitCode: number) => {
    process.exitCode = exitCode;
  });
}
