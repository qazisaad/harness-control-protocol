import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RunnerConfigSchema } from "@harness-control/runner/config";
import { RunnerConnection } from "@harness-control/runner/connection";
import { checkControlPlane, httpTestHooks } from "@harness-control/runner/control-plane-check";
import { HarnessSessionManager } from "@harness-control/runner/harnesses";
import { pairWithReferenceControlPlane, requestConnectionToken } from "@harness-control/runner/pairing";

import { installedProtocolSchemaSha256, startReferenceControlPlane } from "./index.js";

const adminToken = "reference-test-admin-token-0123456789";

async function admin(url: string, path: string, body: unknown): Promise<Response> {
  return fetch(new URL(path, url), { method: "POST", headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" }, body: JSON.stringify(body) });
}

test("the reference control plane passes every lifecycle check", async () => {
  const server = await startReferenceControlPlane({ databasePath: ":memory:", adminToken, port: 0,
    protocolSchemaSha256: installedProtocolSchemaSha256(), heartbeatIntervalSeconds: 1 });
  try {
    const results = await checkControlPlane({ controlPlaneUrl: server.runnerUrl, hooks: httpTestHooks(`${server.url}/admin/`, adminToken), socketTimeoutMs: 3_000 });
    assert.deepEqual(results.filter((result) => result.outcome !== "pass"), []);
    assert.match(results.find((result) => result.id === "revoke.closes_socket")?.detail ?? "", /^Closed \d+ ms/);
  } finally {
    await server.close();
  }
});

test("Level 1: pair a machine, run one turn and read it to its terminal event", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hcp-reference-"));
  const server = await startReferenceControlPlane({ databasePath: join(directory, "hcp.sqlite"), adminToken, port: 0,
    protocolSchemaSha256: installedProtocolSchemaSha256() });
  let runner: RunnerConnection | undefined;
  try {
    const pairing = await pairWithReferenceControlPlane({
      controlPlaneUrl: server.runnerUrl, runnerId: "laptop", hostId: "laptop",
      // In a real app a signed-in user approves on the pairing page; the admin API stands in for that.
      onPairingCode: async (code) => { assert.equal((await admin(server.url, "/admin/approve", { request_id: code.request_id, pairing_code: code.pairing_code })).status, 200); },
    });
    await writeFile(join(directory, "README.md"), "Reference workspace\n");
    const config = RunnerConfigSchema.parse({
      runner_id: "laptop", host_id: "laptop", control_plane_url: pairing.controlPlaneUrl,
      // Like `hcp-runner connect`: no folders yet, but the app may add folders under this root.
      workspaces: [], workspace_management: { allowed_roots: [directory] },
      provider_instances: [{ id: "mock", driver_kind: "mock", display_name: "Mock agent", enabled: true,
        models: [{ id: "mock-model", label: "Mock", capabilities: { option_descriptors: [] } }] }],
    });
    // The runner saves folders the app adds into its config file, so it needs a path.
    const configPath = join(directory, "runner.json");
    await writeFile(configPath, JSON.stringify(config));
    runner = new RunnerConnection({ config, configPath, runnerVersion: "0.0.0-test", harnessSessions: new HarnessSessionManager(config),
      connectionTokenProvider: async () => requestConnectionToken(config, pairing.credential) });
    await runner.connect();

    let folder: Response | undefined;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      folder = await admin(server.url, "/admin/folders", { credential_id: pairing.credential.credential_id, path: directory, display_name: "Project" });
      // 409 means the runner has not published its capabilities yet.
      if (folder.status !== 409) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(folder?.status, 200, await folder?.clone().text());
    const reply = await admin(server.url, "/admin/turn", { credential_id: pairing.credential.credential_id, prompt: "Hello from Level 1", timeout_seconds: 30 });
    assert.equal(reply.status, 200, await reply.clone().text());
    const turn = await reply.json() as { outcome: string; final_text_availability: string; final_text: string | null };
    assert.equal(turn.outcome, "turn.completed");
    // The mock agent reports an empty final text; a real agent returns its answer here.
    assert.ok(["complete", "unconfirmed"].includes(turn.final_text_availability));
    assert.equal(typeof turn.final_text, "string");

    const machines = await (await fetch(new URL("/admin/machines", server.url), { headers: { authorization: `Bearer ${adminToken}` } })).json() as { online: boolean; owner_user_id: string }[];
    assert.deepEqual(machines.map((machine) => [machine.owner_user_id, machine.online]), [["admin", true]]);
  } finally {
    await runner?.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
