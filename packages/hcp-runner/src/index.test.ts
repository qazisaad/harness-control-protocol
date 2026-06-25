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

test("pair prints a mock runner config", async () => {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (message?: unknown) => {
    lines.push(String(message));
  };

  try {
    const exitCode: number = await main([
      "pair",
      "http://127.0.0.1:8787",
      "--runner-id",
      "runner-test",
      "--host-id",
      "host-test",
    ]);
    assert.equal(exitCode, 0);
    const config = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    assert.equal(config.runner_id, "runner-test");
    assert.equal(config.host_id, "host-test");
    assert.equal(config.control_plane_url, "ws://127.0.0.1:8787/");
  } finally {
    console.log = originalLog;
  }
});

test("pair rejects missing control plane urls", async () => {
  const lines: string[] = [];
  const originalError = console.error;
  console.error = (message?: unknown) => {
    lines.push(String(message));
  };

  try {
    const exitCode: number = await main(["pair"]);
    assert.equal(exitCode, 1);
    assert.equal(lines[0], "Missing control plane URL.");
  } finally {
    console.error = originalError;
  }
});

test("pair rejects invalid control plane urls without throwing", async () => {
  const lines: string[] = [];
  const originalError = console.error;
  console.error = (message?: unknown) => {
    lines.push(String(message));
  };

  try {
    const exitCode: number = await main(["pair", "not-a-url"]);
    assert.equal(exitCode, 1);
    assert.match(lines[0] ?? "", /Invalid URL|URL/);
  } finally {
    console.error = originalError;
  }
});
