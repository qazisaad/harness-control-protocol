import assert from "node:assert/strict";
import test from "node:test";

import { main } from "./index.js";

test("prints runner version", async () => {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (message?: unknown) => {
    lines.push(String(message));
  };

  try {
    const exitCode: number = await main(["version"]);
    assert.equal(exitCode, 0);
    assert.match(lines[0] ?? "", /^hcp-runner 0\.0\.0 \(hcp\.v0\)$/);
  } finally {
    console.log = originalLog;
  }
});

test("requires a config path for run", async () => {
  const lines: string[] = [];
  const originalError = console.error;
  console.error = (message?: unknown) => {
    lines.push(String(message));
  };

  try {
    const exitCode: number = await main(["run"]);
    assert.equal(exitCode, 1);
    assert.equal(lines[0], "Usage: hcp-runner run --config <path>");
  } finally {
    console.error = originalError;
  }
});

test("pair reports that the flow is not implemented", async () => {
  const lines: string[] = [];
  const originalError = console.error;
  console.error = (message?: unknown) => {
    lines.push(String(message));
  };

  try {
    const exitCode: number = await main(["pair", "ws://127.0.0.1:8787"]);
    assert.equal(exitCode, 1);
    assert.equal(lines[0], "Pairing is not implemented yet for ws://127.0.0.1:8787.");
  } finally {
    console.error = originalError;
  }
});
