import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import { HCP_VERSION, type HcpEnvelope } from "@hcp-runner/protocol";
import { startMockControlPlane, type MockControlPlaneServer } from "./index.js";

type ReceivedEnvelope = HcpEnvelope<string, Record<string, unknown>>;

function makeEnvelope<TPayload>(type: string, payload: TPayload): HcpEnvelope<string, TPayload> {
  return {
    id: `${type}-message`,
    type,
    version: HCP_VERSION,
    sent_at: new Date().toISOString(),
    payload,
  };
}

async function openClient(server: MockControlPlaneServer): Promise<WebSocket> {
  const socket = new WebSocket(server.url);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

  return socket;
}

async function nextEnvelope(socket: WebSocket): Promise<ReceivedEnvelope> {
  return await new Promise<ReceivedEnvelope>((resolve, reject) => {
    socket.once("message", (data: WebSocket.RawData) => {
      const parsed: unknown = JSON.parse(data.toString("utf8"));
      resolve(parsed as ReceivedEnvelope);
    });
    socket.once("error", reject);
  });
}

async function closeClient(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) {
    return;
  }

  await new Promise<void>((resolve) => {
    socket.once("close", resolve);
    socket.close();
  });
}

test("accepts host hello with heartbeat settings", async () => {
  const server: MockControlPlaneServer = await startMockControlPlane({ port: 0, heartbeatIntervalSeconds: 7 });
  const socket: WebSocket = await openClient(server);

  try {
    socket.send(
      JSON.stringify(
        makeEnvelope("host.hello", {
          runner_id: "runner-test",
          host_id: "host-test",
          runner_version: "0.0.0-test",
          supported_protocol_versions: [HCP_VERSION],
          capabilities: ["providers", "workspaces"],
        }),
      ),
    );

    const accepted: ReceivedEnvelope = await nextEnvelope(socket);
    assert.equal(accepted.type, "host.accepted");
    assert.equal(accepted.payload.protocol_version, HCP_VERSION);
    assert.equal(accepted.payload.heartbeat_interval_seconds, 7);
    assert.equal(server.state.acceptedRunnerId, "runner-test");
    assert.equal(server.state.acceptedHostId, "host-test");
  } finally {
    await closeClient(socket);
    await server.close();
  }
});

test("records heartbeat and capabilities updates", async () => {
  const server: MockControlPlaneServer = await startMockControlPlane({ port: 0 });
  const socket: WebSocket = await openClient(server);

  try {
    socket.send(
      JSON.stringify(
        makeEnvelope("host.heartbeat", {
          host_id: "host-test",
          status: "online",
          active_sessions: 1,
        }),
      ),
    );
    await waitForState(() => server.state.lastHeartbeatAt !== undefined);
    assert.equal(typeof server.state.lastHeartbeatAt, "string");

    socket.send(
      JSON.stringify(
        makeEnvelope("host.capabilities.updated", {
          providers: [],
          local_capabilities: [
            {
              id: "filesystem",
              status: "available",
              scopes: ["workspace_read"],
              approval_required: false,
            },
          ],
          workspaces: [{ id: "workspace-test", path: "/tmp/workspace-test" }],
        }),
      ),
    );
    await waitForState(() => server.state.latestCapabilities !== undefined);
    assert.deepEqual(server.state.latestCapabilities?.providers, []);
    assert.equal(server.state.latestCapabilities?.local_capabilities[0]?.id, "filesystem");
    assert.equal(server.state.latestCapabilities?.workspaces[0]?.id, "workspace-test");
  } finally {
    await closeClient(socket);
    await server.close();
  }
});

test("nacks unsupported messages", async () => {
  const server: MockControlPlaneServer = await startMockControlPlane({ port: 0 });
  const socket: WebSocket = await openClient(server);

  try {
    socket.send(
      JSON.stringify(
        makeEnvelope("harness.session.start", {
          session_id: "session-1",
          workspace_id: "workspace-test",
          provider_instance_id: "provider-1",
          driver_kind: "mock",
          cwd: "/tmp/workspace-test",
          sandbox_mode: "workspace_write",
          approval_policy: "ask",
          continue_session: false,
          model_selection: { model: "mock-model" },
          mcp_servers: [],
        }),
      ),
    );
    const nack: ReceivedEnvelope = await nextEnvelope(socket);
    assert.equal(nack.type, "hcp.command.nack");
    assert.equal((nack.payload.error as Record<string, unknown>).code, "unsupported_message_type");
  } finally {
    await closeClient(socket);
    await server.close();
  }
});

test("nacks protocol-invalid heartbeat payloads", async () => {
  const server: MockControlPlaneServer = await startMockControlPlane({ port: 0 });
  const socket: WebSocket = await openClient(server);

  try {
    socket.send(JSON.stringify(makeEnvelope("host.heartbeat", {})));
    const nack: ReceivedEnvelope = await nextEnvelope(socket);
    assert.equal(nack.type, "hcp.command.nack");
    assert.equal((nack.payload.error as Record<string, unknown>).code, "invalid_message");
  } finally {
    await closeClient(socket);
    await server.close();
  }
});

test("dispatches harness commands to a connected runner", async () => {
  const server: MockControlPlaneServer = await startMockControlPlane({ port: 0 });
  const socket: WebSocket = await openClient(server);

  try {
    socket.send(
      JSON.stringify(
        makeEnvelope("host.hello", {
          runner_id: "runner-test",
          host_id: "host-test",
          runner_version: "0.0.0-test",
          supported_protocol_versions: [HCP_VERSION],
          capabilities: ["providers", "workspaces"],
        }),
      ),
    );
    await nextEnvelope(socket);

    const commandId: string = server.sendSessionStart({
      session_id: "session-1",
      workspace_id: "workspace-test",
      provider_instance_id: "provider-1",
      driver_kind: "mock",
      cwd: "/tmp/workspace-test",
      sandbox_mode: "workspace_write",
      approval_policy: "ask",
      continue_session: false,
      model_selection: { model: "mock-model" },
      mcp_servers: [],
    });
    const command: ReceivedEnvelope = await nextEnvelope(socket);

    assert.equal(command.id, commandId);
    assert.equal(command.type, "harness.session.start");
    assert.equal(command.payload.session_id, "session-1");
  } finally {
    await closeClient(socket);
    await server.close();
  }
});

async function waitForState(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error("Timed out waiting for mock control plane state.");
}
