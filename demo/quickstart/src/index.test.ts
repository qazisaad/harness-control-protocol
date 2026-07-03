import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { LocalActionResponsePayload } from "@hcp-runner/protocol";

import { startQuickstartDemo } from "./index.js";

type SnapshotResponse = {
  api_token: string;
  runner_status: string;
  providers: unknown[];
  sessions: Array<{ session_id: string; status: string }>;
};

type ApiResponse<T> =
  | {
      status: "ok";
      message: string;
      data?: T;
    }
  | {
      status: "error";
      error: {
        message: string;
        details?: unknown;
      };
    };

describe("quickstart demo", () => {
  it("starts the local runner, exercises a local action, and attaches the sample MCP server", async () => {
    const server = await startQuickstartDemo({ port: 0 });
    try {
      const snapshot = await getJson<SnapshotResponse>(`${server.url}/api/snapshot`);
      assert.equal(snapshot.runner_status, "accepted");
      assert.ok(snapshot.providers.length >= 1);

      const readResult = await postJson<LocalActionResponsePayload["output"]>(
        `${server.url}/api/local/read-file`,
        {},
        snapshot.api_token,
      );
      assert.equal(readResult.status, "ok");
      assert.match(JSON.stringify(readResult.data), /Harness Control Protocol/);

      const shellResult = await postJson<{ stdout: string; exit_code: number }>(
        `${server.url}/api/local/safe-shell`,
        {},
        snapshot.api_token,
      );
      assert.equal(shellResult.status, "ok");
      assert.equal(shellResult.data?.stdout.trim(), "HCP safe shell OK");
      assert.equal(shellResult.data?.exit_code, 0);

      const devStartResult = await postJson<{ url: string; server_id: string }>(
        `${server.url}/api/local/dev-server/start`,
        {},
        snapshot.api_token,
      );
      assert.equal(devStartResult.status, "ok");
      assert.equal(devStartResult.data?.server_id, "quickstart-dev-server");
      assert.match(devStartResult.data?.url ?? "", /^http:\/\/127\.0\.0\.1:\d+$/);
      const devServerResponse = await fetch(devStartResult.data?.url ?? "");
      assert.equal(await devServerResponse.text(), "HCP quickstart dev server OK\n");

      const devStopResult = await postJson<{ server_id: string }>(
        `${server.url}/api/local/dev-server/stop`,
        {},
        snapshot.api_token,
      );
      assert.equal(devStopResult.status, "ok");
      assert.equal(devStopResult.data?.server_id, "quickstart-dev-server");

      const mcpResult = await postJson<Record<string, unknown>>(
        `${server.url}/api/mcp/start`,
        {
          provider_instance_id: "mock-provider",
        },
        snapshot.api_token,
      );
      assert.equal(mcpResult.status, "ok");
      assert.equal(mcpResult.data?.["provider"], "mock-provider");
    } finally {
      await server.close();
    }
  });

  it("rejects mutating requests without the same-origin token and JSON content type", async () => {
    const server = await startQuickstartDemo({ port: 0 });
    try {
      const snapshot = await getJson<SnapshotResponse>(`${server.url}/api/snapshot`);

      const missingToken = await fetch(`${server.url}/api/local/read-file`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(missingToken.status, 403);

      const wrongOrigin = await fetch(`${server.url}/api/local/read-file`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "origin": "https://example.com",
          "x-hcp-quickstart-token": snapshot.api_token,
        },
        body: "{}",
      });
      assert.equal(wrongOrigin.status, 403);

      const wrongContentType = await fetch(`${server.url}/api/local/read-file`, {
        method: "POST",
        headers: {
          "content-type": "text/plain",
          "x-hcp-quickstart-token": snapshot.api_token,
        },
        body: "{}",
      });
      assert.equal(wrongContentType.status, 415);
    } finally {
      await server.close();
    }
  });
});

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    assert.fail(await response.text());
  }
  return (await response.json()) as T;
}

async function postJson<T>(url: string, body: Record<string, unknown>, apiToken: string): Promise<ApiResponse<T>> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hcp-quickstart-token": apiToken,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    assert.fail(await response.text());
  }
  return (await response.json()) as ApiResponse<T>;
}
