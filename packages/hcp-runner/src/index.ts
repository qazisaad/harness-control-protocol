#!/usr/bin/env node

import { HCP_VERSION } from "@hcp-runner/protocol";

const command: string | undefined = process.argv[2];

if (command === "version") {
  console.log(`hcp-runner ${HCP_VERSION}`);
} else if (command === "pair") {
  const controlPlaneUrl: string | undefined = process.argv[3];
  if (!controlPlaneUrl) {
    console.error("Usage: hcp-runner pair <control-plane-url>");
    process.exitCode = 1;
  } else {
    console.log(`Pairing flow placeholder for ${controlPlaneUrl}`);
  }
} else {
  console.log("Usage: hcp-runner <version|pair>");
}

