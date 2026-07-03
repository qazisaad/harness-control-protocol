import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HcpHarnessEventPayload } from "@harness-control/protocol";

import { startMockControlPlane } from "../apps/mock-control-plane/src/index.js";
import { startSampleMcpServer } from "../apps/sample-mcp-server/src/index.js";
import { RunnerConnection } from "../packages/hcp-runner/src/connection/runner-connection.js";
import type { RunnerConfig } from "../packages/hcp-runner/src/config/index.js";
import { HarnessSessionManager } from "../packages/hcp-runner/src/harnesses/index.js";
import { createDevelopmentHmacProofSigner } from "../packages/hcp-runner/src/mcp/McpAttachmentClient.js";
import { pairWithReferenceControlPlane, requestConnectionToken } from "../packages/hcp-runner/src/pairing/index.js";

const workspaceRoot = await mkdtemp(join(tmpdir(), "hcp-example-workspace-"));
const mockControlPlane = await startMockControlPlane({ port: 0 });

try {
  const pairing = await pairWithReferenceControlPlane({
    controlPlaneUrl: mockControlPlane.url,
    runnerId: "example-runner",
    hostId: "example-host",
  });
  const config: RunnerConfig = {
    runner_id: "example-runner",
    host_id: "example-host",
    control_plane_url: pairing.controlPlaneUrl,
    workspaces: [{ id: "workspace-1", path: workspaceRoot }],
    local_capabilities: [
      { id: "filesystem", status: "available", scopes: ["workspace_read", "workspace_write"], approval_required: false },
      { id: "git", status: "available", scopes: ["workspace_read", "workspace_write"], approval_required: false },
      { id: "shell", status: "available", scopes: ["workspace"], approval_required: true },
      { id: "dev_server", status: "available", scopes: ["workspace"], approval_required: true },
    ],
    provider_instances: [
      {
        id: "mock-provider",
        driver_kind: "mock",
        display_name: "Mock Harness",
        enabled: true,
        launch_args: [],
        env: {},
        models: [{ id: "mock-model", label: "Mock Model", capabilities: { option_descriptors: [] } }],
        hidden_models: [],
        model_order: [],
        favorite_models: [],
        local_capabilities: ["filesystem", "git", "shell", "dev_server"],
      },
    ],
  };
  const sampleMcp = await startSampleMcpServer({
    port: 0,
    lease: {
      lease_id: "mcp_lease_example",
      key_id: "proof_key_example",
      secret: pairing.credential.mcp_proof_secret ?? pairing.credential.credential_secret,
      session_id: "session-1",
      host_id: "example-host",
      provider_instance_id: "mock-provider",
      workspace_id: "workspace-1",
      server_id: "sample",
      expires_at: "2999-01-01T00:00:00.000Z",
      allowed_tools: ["echo", "server_status"],
    },
  });
  const harnessSessions = new HarnessSessionManager(config, {
    mcpProofSigner: createDevelopmentHmacProofSigner(
      pairing.credential.mcp_proof_secret ?? pairing.credential.credential_secret,
    ),
  });
  const connection = new RunnerConnection({
    config,
    runnerVersion: "0.0.0-example",
    harnessSessions,
    connectionTokenProvider: async () => requestConnectionToken(config, pairing.credential),
  });

  try {
    await connection.connect();
    await waitForState(() => mockControlPlane.state.latestCapabilities !== undefined);

    mockControlPlane.sendSessionStart({
      session_id: "session-1",
      workspace_id: "workspace-1",
      provider_instance_id: "mock-provider",
      driver_kind: "mock",
      cwd: workspaceRoot,
      sandbox_mode: "workspace_write",
      approval_policy: "ask",
      continue_session: false,
      model_selection: { model: "mock-model" },
      mcp_servers: [
        {
          name: "sample",
          transport: "streamable_http",
          url: sampleMcp.url,
          headers: { Authorization: "Bearer sample-token" },
          lease_id: "mcp_lease_example",
          proof_of_possession: {
            scheme: "runner_signed_request",
            key_id: "proof_key_example",
            required_headers: ["x-hcp-proof-signature", "x-hcp-proof-nonce"],
          },
          allowed_tools: ["echo", "server_status"],
        },
      ],
    });
    await waitForEvent("session.configured");

    mockControlPlane.sendTurn({
      session_id: "session-1",
      turn_id: "turn-1",
      input: "Say hello from the deterministic mock harness.",
    });
    await waitForEvent("turn.completed");

    mockControlPlane.stopSession({ session_id: "session-1", reason: "example-complete" });
    await waitForEvent("session.exited");

    console.log("paired:", pairing.credential.credential_id);
    console.log("capabilities:", JSON.stringify(mockControlPlane.state.latestCapabilities, null, 2));
    console.log(
      "events:",
      mockControlPlane.state.events.map((event: HcpHarnessEventPayload) => ({
        sequence: event.sequence,
        event_type: event.event_type,
        turn_id: event.turn_id,
      })),
    );
  } finally {
    await connection.close();
    await sampleMcp.close();
  }
} finally {
  await mockControlPlane.close();
  await rm(workspaceRoot, { recursive: true, force: true });
}

async function waitForEvent(eventType: HcpHarnessEventPayload["event_type"]): Promise<void> {
  await waitForState(() =>
    mockControlPlane.state.events.some((event: HcpHarnessEventPayload): boolean => event.event_type === eventType),
  );
}

async function waitForState(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for example state.");
}
