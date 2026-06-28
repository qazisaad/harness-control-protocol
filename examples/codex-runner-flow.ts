import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HarnessProviderSnapshot, HcpHarnessEventPayload, HcpNackPayload } from "@hcp-runner/protocol";

import { startMockControlPlane } from "../apps/mock-control-plane/src/index.js";
import { RunnerConnection } from "../packages/hcp-runner/src/connection/runner-connection.js";
import type { RunnerConfig } from "../packages/hcp-runner/src/config/index.js";
import { HarnessSessionManager } from "../packages/hcp-runner/src/harnesses/index.js";
import { pairWithReferenceControlPlane, requestConnectionToken } from "../packages/hcp-runner/src/pairing/index.js";

const workspaceRoot: string = await mkdtemp(join(tmpdir(), "hcp-codex-example-workspace-"));
const mockControlPlane = await startMockControlPlane({ port: 0 });

try {
  const pairing = await pairWithReferenceControlPlane({
    controlPlaneUrl: mockControlPlane.url,
    runnerId: "codex-example-runner",
    hostId: "codex-example-host",
  });
  const config: RunnerConfig = {
    runner_id: "codex-example-runner",
    host_id: "codex-example-host",
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
        id: "codex-local",
        driver_kind: "codex",
        display_name: "Codex Local",
        enabled: true,
        launch_args: ["-c", "service_tier=fast"],
        env: {},
        models: [
          {
            id: "gpt-5.5",
            label: "GPT-5.5",
            is_default: true,
            capabilities: { option_descriptors: [] },
          },
        ],
        hidden_models: [],
        model_order: [],
        favorite_models: [],
        local_capabilities: ["filesystem", "git", "shell", "dev_server"],
      },
    ],
  };
  const harnessSessions = new HarnessSessionManager(config);
  const connection = new RunnerConnection({
    config,
    runnerVersion: "0.0.0-example",
    harnessSessions,
    connectionTokenProvider: async () => requestConnectionToken(config, pairing.credential),
  });

  try {
    await connection.connect();
    const codexProvider: HarnessProviderSnapshot = await waitForProviderSnapshot("codex-local");
    console.log(
      "codex provider:",
      JSON.stringify(
        {
          status: codexProvider.status,
          availability: codexProvider.availability,
          auth: codexProvider.auth,
          version: codexProvider.version,
          message: codexProvider.message,
        },
        null,
        2,
      ),
    );

    const mcpCommandId: string = mockControlPlane.sendSessionStart({
      session_id: "session-mcp-unsupported",
      workspace_id: "workspace-1",
      provider_instance_id: "codex-local",
      driver_kind: "codex",
      cwd: workspaceRoot,
      sandbox_mode: "workspace_write",
      approval_policy: "ask",
      continue_session: false,
      model_selection: { model: "gpt-5.5" },
      mcp_servers: [
        {
          name: "sample",
          transport: "streamable_http",
          url: "http://127.0.0.1:8791/mcp",
          headers: { Authorization: "Bearer sample-token" },
          lease_id: "mcp_lease_example",
          proof_of_possession: {
            scheme: "runner_signed_request",
            key_id: "proof_key_example",
            required_headers: ["x-hcp-proof-signature", "x-hcp-proof-nonce"],
          },
          allowed_tools: ["echo"],
        },
      ],
    });
    const mcpNack: HcpNackPayload = await waitForNack(mcpCommandId);
    if (mcpNack.error.code !== "codex_mcp_attachment_unsupported") {
      throw new Error(`Expected codex_mcp_attachment_unsupported, received ${mcpNack.error.code}.`);
    }
    console.log(
      "codex mcp attachment:",
      JSON.stringify(
        {
          status: "unsupported",
          code: mcpNack.error.code,
          message: mcpNack.error.message,
        },
        null,
        2,
      ),
    );

    let liveSessionStarted = false;
    if (codexProvider.availability !== "available") {
      console.log("Skipping live Codex turn because the provider probe is not ready.");
    } else {
      try {
        mockControlPlane.sendSessionStart({
          session_id: "session-1",
          workspace_id: "workspace-1",
          provider_instance_id: "codex-local",
          driver_kind: "codex",
          cwd: workspaceRoot,
          sandbox_mode: "workspace_write",
          approval_policy: "full_access",
          continue_session: false,
          model_selection: { model: "gpt-5.5" },
          mcp_servers: [],
        });
        await waitForEventOrNack("session.configured");
        liveSessionStarted = true;

        mockControlPlane.sendTurn({
          session_id: "session-1",
          turn_id: "turn-1",
          input: "Reply with exactly: HCP Codex live smoke OK",
        });
        const terminalEvent: HcpHarnessEventPayload = await waitForTurnTerminalEvent("turn-1");

        console.log("turn terminal:", JSON.stringify(terminalEvent, null, 2));
        if (terminalEvent.event_type !== "turn.completed") {
          throw new Error("Codex live turn did not complete.");
        }
      } finally {
        if (liveSessionStarted && !hasEvent("session-1", "session.exited")) {
          mockControlPlane.stopSession({ session_id: "session-1", reason: "codex-example-complete" });
          await waitForEventOrNack("session.exited");
        }
      }
    }

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
  }
} finally {
  await mockControlPlane.close();
  await rm(workspaceRoot, { recursive: true, force: true });
}

async function waitForProviderSnapshot(providerInstanceId: string): Promise<HarnessProviderSnapshot> {
  return await waitForState(() => providerSnapshot(providerInstanceId));
}

function providerSnapshot(providerInstanceId: string): HarnessProviderSnapshot | undefined {
  const provider: HarnessProviderSnapshot | undefined = mockControlPlane.state.latestCapabilities?.providers.find(
    (candidate: HarnessProviderSnapshot): boolean => candidate.provider_instance_id === providerInstanceId,
  );
  return provider;
}

async function waitForEventOrNack(eventType: HcpHarnessEventPayload["event_type"]): Promise<HcpHarnessEventPayload> {
  const initialNackCount: number = mockControlPlane.state.commandNacks.length;
  return await waitForState(() => {
    const event: HcpHarnessEventPayload | undefined = mockControlPlane.state.events.find(
      (candidate: HcpHarnessEventPayload): boolean => candidate.event_type === eventType,
    );
    if (event) {
      return event;
    }
    const nack = mockControlPlane.state.commandNacks.at(initialNackCount);
    if (nack) {
      throw new Error(`${nack.error.code}: ${nack.error.message}`);
    }
    return undefined;
  });
}

async function waitForNack(commandId: string): Promise<HcpNackPayload> {
  return await waitForState(() =>
    mockControlPlane.state.commandNacks.find((candidate: HcpNackPayload): boolean => candidate.command_id === commandId),
  );
}

async function waitForTurnTerminalEvent(turnId: string): Promise<HcpHarnessEventPayload> {
  return await waitForState(
    () =>
      mockControlPlane.state.events.find(
        (event: HcpHarnessEventPayload): boolean =>
          event.turn_id === turnId &&
          (event.event_type === "turn.completed" ||
            event.event_type === "turn.failed" ||
            event.event_type === "turn.cancelled" ||
            event.event_type === "turn.aborted"),
      ),
    120_000,
  );
}

function hasEvent(sessionId: string, eventType: HcpHarnessEventPayload["event_type"]): boolean {
  return mockControlPlane.state.events.some(
    (event: HcpHarnessEventPayload): boolean => event.session_id === sessionId && event.event_type === eventType,
  );
}

async function waitForState<T>(predicate: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value: T | undefined = predicate();
    if (value !== undefined) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for example state.");
}
