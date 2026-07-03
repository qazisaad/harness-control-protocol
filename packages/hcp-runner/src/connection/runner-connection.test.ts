import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { WebSocket, WebSocketServer } from "ws";

import {
  HCP_VERSION,
  createHcpEnvelope,
  parseHcpMessage,
  type HcpHarnessEventPayload,
  type HcpMessage,
  type HcpSessionStartPayload,
  type HcpTurnSendPayload,
  type LocalGitStatusRequestPayload,
  type LocalActionRequestPayload,
  type LocalCapabilityLease,
} from "@harness-control/protocol";

import { RunnerConnection } from "./runner-connection.js";
import type { RunnerConfig } from "../config/index.js";
import { HarnessSessionManager } from "../harnesses/index.js";

type TestWorkspace = {
  root: string;
  project: string;
  cleanup(): Promise<void>;
};

class BlockingTurnSessionManager extends HarnessSessionManager {
  turnCalls = 0;
  readonly turnStarted: Promise<void>;
  readonly #resolveTurnStarted: () => void;
  #releaseTurn: (() => void) | undefined;

  constructor(config: RunnerConfig) {
    super(config);
    let resolveTurnStarted: () => void = () => undefined;
    this.turnStarted = new Promise<void>((resolve) => {
      resolveTurnStarted = resolve;
    });
    this.#resolveTurnStarted = resolveTurnStarted;
  }

  override async sendTurn(_payload: HcpTurnSendPayload): Promise<HcpHarnessEventPayload[]> {
    this.turnCalls += 1;
    this.#resolveTurnStarted();
    await new Promise<void>((resolve) => {
      this.#releaseTurn = resolve;
    });
    return [];
  }

  releaseTurn(): void {
    this.#releaseTurn?.();
  }
}

async function createWorkspace(): Promise<TestWorkspace> {
  const root: string = await mkdtemp(join(tmpdir(), "hcp-runner-connection-"));
  const project: string = join(root, "project");
  await mkdir(project);
  return {
    root,
    project,
    cleanup: async (): Promise<void> => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

function createConfigBase(workspaceRoot: string): Omit<RunnerConfig, "control_plane_url"> {
  return {
    runner_id: "runner-test",
    workspaces: [{ id: "repo", path: workspaceRoot }],
    local_capabilities: [
      { id: "filesystem", status: "available", scopes: ["workspace_read", "workspace_write"], approval_required: false },
      { id: "git", status: "available", scopes: ["workspace_read"], approval_required: false },
      { id: "shell", status: "available", scopes: ["workspace"], approval_required: true },
    ],
    provider_instances: [
      {
        id: "mock-provider",
        driver_kind: "mock",
        enabled: true,
        launch_args: [],
        env: {},
        models: [],
        hidden_models: [],
        model_order: [],
        favorite_models: [],
        local_capabilities: ["filesystem", "git", "shell"],
      },
    ],
  };
}

function createSessionStartPayload(cwd: string): HcpSessionStartPayload {
  return {
    session_id: "session-1",
    workspace_id: "repo",
    provider_instance_id: "mock-provider",
    driver_kind: "mock",
    cwd,
    sandbox_mode: "workspace_write",
    approval_policy: "ask",
    continue_session: false,
    model_selection: { model: "mock-model" },
    mcp_servers: [],
  };
}

function createLocalCapabilityLease(overrides: Partial<LocalCapabilityLease> = {}): LocalCapabilityLease {
  return {
    lease_id: "lease-1",
    org_id: "org-1",
    workflow_id: "workflow-1",
    run_id: "run-1",
    node_id: "node-1",
    hcp_session_id: "session-1",
    execution_host_id: "runner-test",
    provider_instance_id: "mock-provider",
    workspace_id: "repo",
    issued_at: "2026-01-01T00:00:00.000Z",
    expires_at: "2999-01-01T00:00:00.000Z",
    policy_version: "policy-1",
    capabilities: [{ id: "filesystem", scopes: ["workspace_read", "workspace_write"], max_calls: 1 }],
    ...overrides,
  };
}

function createFilesystemReadRequest(workspace: TestWorkspace, path = "project/notes.txt"): LocalActionRequestPayload {
  return {
    request_id: "local-read-1",
    action: "local.filesystem.read",
    issued_at: "2026-01-01T00:00:00.000Z",
    attribution: {
      session_id: "session-1",
      turn_id: "turn-1",
      workspace_id: "repo",
      provider_instance_id: "mock-provider",
      run_id: "run-1",
    },
    lease: {
      lease_id: "lease-1",
      capability_id: "filesystem",
      scope: "workspace_read",
      run_id: "run-1",
      hcp_session_id: "session-1",
      execution_host_id: "runner-test",
      provider_instance_id: "mock-provider",
      workspace_id: "repo",
      expires_at: "2999-01-01T00:00:00.000Z",
    },
    sandbox: {
      mode: "workspace_write",
      workspace_root: workspace.root,
      cwd: workspace.project,
      requires_workspace_containment: true,
    },
    approval: { status: "not_required" },
    output_limits: { content_bytes: 65_536 },
    cancellation: { cancellable: false },
    audit: {
      started_event_type: "local_capability.action.started",
      completed_event_type: "local_capability.action.completed",
      failed_event_type: "local_capability.action.failed",
    },
    input: { path, encoding: "utf8" },
  };
}

describe("RunnerConnection", () => {
  it("handles accepted, harness.session.start, and harness.turn.send with events and command acks", async () => {
    const workspace = await createWorkspace();
    const sessionStartPayload: HcpSessionStartPayload = createSessionStartPayload(workspace.project);
    const server = await startServer(async (socket: WebSocket, messages: HcpMessage[]) => {
      await waitForMessage(messages, "host.hello");
      socket.send(
        JSON.stringify(
          createHcpEnvelope("host.accepted", {
            protocol_version: HCP_VERSION,
            heartbeat_interval_seconds: 60,
          }),
        ),
      );
      const sessionStart = createHcpEnvelope("harness.session.start", sessionStartPayload);
      socket.send(JSON.stringify(sessionStart));
      await waitForAck(messages, sessionStart.id);
      const turnSend = createHcpEnvelope("harness.turn.send", {
        session_id: "session-1",
        turn_id: "turn-1",
        input: "hello",
      });
      socket.send(JSON.stringify(turnSend));
    });
    const connection = new RunnerConnection({
      config: { ...createConfigBase(workspace.root), control_plane_url: server.url },
      runnerVersion: "0.0.0-test",
    });

    try {
      await connection.connect();
      const ack = await waitForAckCount(server.messages, 2);
      await waitForEventCount(server.messages, 5);
      const events = server.messages.filter((message) => message.type === "harness.event");

      assert.equal(ack.payload.duplicate, false);
      assert.deepEqual(
        events.map((event) => event.payload.event_type),
        ["session.started", "workspace.preflight.completed", "session.configured", "turn.started", "turn.completed"],
      );
    } finally {
      await connection.close();
      await server.close();
      await workspace.cleanup();
    }
  });

  it("nacks invalid messages and invalid session starts", async () => {
    const workspace = await createWorkspace();
    const outside = await createWorkspace();
    const sessionStartPayload: HcpSessionStartPayload = createSessionStartPayload(workspace.project);
    const server = await startServer(async (socket: WebSocket, messages: HcpMessage[]) => {
      await waitForMessage(messages, "host.hello");
      socket.send(JSON.stringify({ id: "bad-message", type: "harness.turn.send", version: HCP_VERSION, sent_at: new Date().toISOString(), payload: {} }));
      await waitForNack(messages, "bad-message");
      const sessionStart = createHcpEnvelope("harness.session.start", {
        ...sessionStartPayload,
        session_id: "session-bad",
        cwd: outside.root,
      });
      socket.send(JSON.stringify(sessionStart));
    });
    const connection = new RunnerConnection({
      config: { ...createConfigBase(workspace.root), control_plane_url: server.url },
      runnerVersion: "0.0.0-test",
    });

    try {
      await connection.connect();
      const workspaceNack = await waitForNackCode(server.messages, "workspace_not_allowed");
      assert.equal(workspaceNack.payload.error.code, "workspace_not_allowed");
    } finally {
      await connection.close();
      await server.close();
      await workspace.cleanup();
      await outside.cleanup();
    }
  });

  it("acknowledges duplicate commands and nacks payload mismatches", async () => {
    const workspace = await createWorkspace();
    const changedProject = join(workspace.root, "changed");
    await mkdir(changedProject);
    const sessionStartPayload: HcpSessionStartPayload = createSessionStartPayload(workspace.project);
    const server = await startServer(async (socket: WebSocket, messages: HcpMessage[]) => {
      await waitForMessage(messages, "host.hello");
      socket.send(
        JSON.stringify(
          createHcpEnvelope("host.accepted", {
            protocol_version: HCP_VERSION,
            heartbeat_interval_seconds: 60,
          }),
        ),
      );

      const command = createHcpEnvelope("harness.session.start", sessionStartPayload);
      socket.send(JSON.stringify(command));
      await waitForAck(messages, command.id);
      socket.send(JSON.stringify(command));
      await waitForDuplicateAck(messages, command.id);
      socket.send(
        JSON.stringify({
          ...command,
          payload: {
            ...sessionStartPayload,
            cwd: changedProject,
          },
        }),
      );
    });
    const connection = new RunnerConnection({
      config: { ...createConfigBase(workspace.root), control_plane_url: server.url },
      runnerVersion: "0.0.0-test",
    });

    try {
      await connection.connect();
      const mismatch = await waitForNackCode(server.messages, "duplicate_command_payload_mismatch");
      assert.equal(mismatch.payload.command_id.startsWith("message-"), false);
    } finally {
      await connection.close();
      await server.close();
      await workspace.cleanup();
    }
  });

  it("replays nacks for duplicate rejected commands instead of executing later", async () => {
    const workspace = await createWorkspace();
    const outside = await createWorkspace();
    const badPayload: HcpSessionStartPayload = createSessionStartPayload(outside.root);
    const server = await startServer(async (socket: WebSocket, messages: HcpMessage[]) => {
      await waitForMessage(messages, "host.hello");
      socket.send(
        JSON.stringify(
          createHcpEnvelope("host.accepted", {
            protocol_version: HCP_VERSION,
            heartbeat_interval_seconds: 60,
          }),
        ),
      );

      const command = createHcpEnvelope("harness.session.start", badPayload);
      socket.send(JSON.stringify(command));
      await waitForNack(messages, command.id);
      socket.send(JSON.stringify(command));
    });
    const connection = new RunnerConnection({
      config: { ...createConfigBase(workspace.root), control_plane_url: server.url },
      runnerVersion: "0.0.0-test",
    });

    try {
      await connection.connect();
      await waitForNackCount(server.messages, "workspace_not_allowed", 2);
      assert.equal(server.messages.some((message) => message.type === "harness.event"), false);
    } finally {
      await connection.close();
      await server.close();
      await workspace.cleanup();
      await outside.cleanup();
    }
  });

  it("does not execute duplicate in-flight commands twice", async () => {
    const workspace = await createWorkspace();
    const config: RunnerConfig = { ...createConfigBase(workspace.root), control_plane_url: "ws://placeholder.invalid" };
    const harnessSessions = new BlockingTurnSessionManager(config);
    const server = await startServer(async (socket: WebSocket, messages: HcpMessage[]) => {
      await waitForMessage(messages, "host.hello");
      socket.send(
        JSON.stringify(
          createHcpEnvelope("host.accepted", {
            protocol_version: HCP_VERSION,
            heartbeat_interval_seconds: 60,
          }),
        ),
      );

      const command = createHcpEnvelope("harness.turn.send", {
        session_id: "session-1",
        turn_id: "turn-1",
        input: "hello",
      });
      socket.send(JSON.stringify(command));
      await harnessSessions.turnStarted;
      socket.send(JSON.stringify(command));
      harnessSessions.releaseTurn();
    });
    const connection = new RunnerConnection({
      config: { ...config, control_plane_url: server.url },
      runnerVersion: "0.0.0-test",
      harnessSessions,
    });

    try {
      await connection.connect();
      await waitForAckCount(server.messages, 2);
      assert.equal(harnessSessions.turnCalls, 1);
      assert.equal(server.messages.filter((message) => message.type === "hcp.command.ack" && message.payload.duplicate).length, 1);
    } finally {
      await connection.close();
      await server.close();
      await workspace.cleanup();
    }
  });

  it("handles local action requests with response replay and payload mismatch errors", async () => {
    const workspace = await createWorkspace();
    await writeFile(join(workspace.project, "notes.txt"), "hello", "utf8");
    const sessionStartPayload: HcpSessionStartPayload = {
      ...createSessionStartPayload(workspace.project),
      local_capability_lease: createLocalCapabilityLease(),
    };
    const readRequest: LocalActionRequestPayload = createFilesystemReadRequest(workspace);
    const mismatchRequest: LocalGitStatusRequestPayload = {
      ...readRequest,
      action: "local.git.status",
      lease: {
        ...readRequest.lease,
        lease_id: "lease-mismatch",
        capability_id: "git",
        scope: "workspace_read",
      },
      output_limits: { status_bytes: 65_536 },
      input: { porcelain_version: "v1", include_branch: true },
    };
    const server = await startServer(async (socket: WebSocket, messages: HcpMessage[]) => {
      await waitForMessage(messages, "host.hello");
      socket.send(
        JSON.stringify(
          createHcpEnvelope("host.accepted", {
            protocol_version: HCP_VERSION,
            heartbeat_interval_seconds: 60,
          }),
        ),
      );

      const sessionStart = createHcpEnvelope("harness.session.start", sessionStartPayload);
      socket.send(JSON.stringify(sessionStart));
      await waitForAck(messages, sessionStart.id);

      const localAction = createHcpEnvelope("local.action.request", readRequest);
      socket.send(JSON.stringify(localAction));
      await waitForLocalActionResponseCount(messages, "local-read-1", 1);
      socket.send(JSON.stringify(localAction));
      await waitForLocalActionResponseCount(messages, "local-read-1", 2);
      socket.send(JSON.stringify(createHcpEnvelope("local.action.request", mismatchRequest)));
      await waitForLocalActionErrorCount(messages, "local-read-1", "local_capability_action_failed", 1);
      socket.send(JSON.stringify(createHcpEnvelope("local.action.request", mismatchRequest)));
    });
    const connection = new RunnerConnection({
      config: { ...createConfigBase(workspace.root), control_plane_url: server.url },
      runnerVersion: "0.0.0-test",
    });

    try {
      await connection.connect();
      const response = await waitForLocalActionResponseCount(server.messages, "local-read-1", 2);
      const mismatch = await waitForLocalActionErrorCount(server.messages, "local-read-1", "local_capability_action_failed", 2);
      const localActionEvents: Array<Extract<HcpMessage, { type: "harness.event" }>> = server.messages.filter(
        (message): message is Extract<HcpMessage, { type: "harness.event" }> =>
          message.type === "harness.event" &&
          (message.payload.event_type === "local_capability.action.started" ||
            message.payload.event_type === "local_capability.action.completed"),
      );
      const mismatchEvents: Array<Extract<HcpMessage, { type: "harness.event" }>> = server.messages.filter(
        (message): message is Extract<HcpMessage, { type: "harness.event" }> =>
          message.type === "harness.event" &&
          message.payload.event_type === "local_capability.action.failed" &&
          "action" in message.payload.data &&
          message.payload.data.action === "local.git.status",
      );

      if (response.payload.action !== "local.filesystem.read") {
        throw new Error("Expected local.filesystem.read response.");
      }
      assert.equal(response.payload.output.content, "hello");
      assert.equal(response.payload.audit_events.completed.event_type, "local_capability.action.completed");
      assert.equal(mismatch.payload.status, "failed");
      assert.equal(mismatch.payload.action, "local.git.status");
      if (!mismatch.payload.lease) {
        throw new Error("Expected mismatch error payload to include lease attribution.");
      }
      assert.equal(mismatch.payload.lease.lease_id, "lease-mismatch");
      assert.equal(mismatch.payload.lease.capability_id, "git");
      assert.equal(localActionEvents.length, 2);
      assert.equal(mismatchEvents.length, 1);
      const mismatchEvent = mismatchEvents[0];
      if (!mismatchEvent || !("lease_id" in mismatchEvent.payload.data)) {
        throw new Error("Expected mismatch failed event to include lease attribution.");
      }
      assert.equal(mismatchEvent.payload.data.lease_id, "lease-mismatch");
      assert.equal(
        server.messages.some(
          (message) => message.type === "hcp.command.ack" && message.payload.command_id === "local-read-1",
        ),
        false,
      );
    } finally {
      await connection.close();
      await server.close();
      await workspace.cleanup();
    }
  });

  it("returns protocol local action errors for denied filesystem paths", async () => {
    const workspace = await createWorkspace();
    const sessionStartPayload: HcpSessionStartPayload = {
      ...createSessionStartPayload(workspace.project),
      local_capability_lease: createLocalCapabilityLease({
        capabilities: [{ id: "filesystem", scopes: ["workspace_read", "workspace_write"] }],
      }),
    };
    const deniedRequest: LocalActionRequestPayload = {
      ...createFilesystemReadRequest(workspace, "../secret.txt"),
      request_id: "local-read-denied",
    };
    const server = await startServer(async (socket: WebSocket, messages: HcpMessage[]) => {
      await waitForMessage(messages, "host.hello");
      socket.send(
        JSON.stringify(
          createHcpEnvelope("host.accepted", {
            protocol_version: HCP_VERSION,
            heartbeat_interval_seconds: 60,
          }),
        ),
      );

      const sessionStart = createHcpEnvelope("harness.session.start", sessionStartPayload);
      socket.send(JSON.stringify(sessionStart));
      await waitForAck(messages, sessionStart.id);
      socket.send(JSON.stringify(createHcpEnvelope("local.action.request", deniedRequest)));
    });
    const connection = new RunnerConnection({
      config: { ...createConfigBase(workspace.root), control_plane_url: server.url },
      runnerVersion: "0.0.0-test",
    });

    try {
      await connection.connect();
      const error = await waitForLocalActionError(server.messages, "local-read-denied", "local_capability_path_denied");
      const failedEvent = await waitForHarnessEvent(server.messages, "local_capability.action.failed");

      assert.equal(error.payload.audit_events.failed.sequence, failedEvent.payload.sequence);
      assert.equal(error.payload.error.retryable, false);
    } finally {
      await connection.close();
      await server.close();
      await workspace.cleanup();
    }
  });

  it("reconnects and sends host hello after a dropped socket", async () => {
    const workspace = await createWorkspace();
    let connectionCount = 0;
    const server = await startServer(async (socket: WebSocket, messages: HcpMessage[]) => {
      connectionCount += 1;
      if (connectionCount === 1) {
        await waitForMessageCount(messages, "host.hello", 1);
        socket.close();
        return;
      }

      await waitForMessageCount(messages, "host.hello", 2);
      socket.send(
        JSON.stringify(
          createHcpEnvelope("host.accepted", {
            protocol_version: HCP_VERSION,
            heartbeat_interval_seconds: 60,
          }),
        ),
      );
    });
    const connection = new RunnerConnection({
      config: { ...createConfigBase(workspace.root), control_plane_url: server.url },
      runnerVersion: "0.0.0-test",
      reconnect: { initialDelayMs: 10, maxDelayMs: 10 },
    });

    try {
      await connection.connect();
      await waitForMessageCount(server.messages, "host.hello", 2);
      assert.equal(connectionCount, 2);
    } finally {
      await connection.close();
      await server.close();
      await workspace.cleanup();
    }
  });

  it("replays retained session events after an accepted resume cursor", async () => {
    const workspace = await createWorkspace();
    const config: RunnerConfig = { ...createConfigBase(workspace.root), control_plane_url: "ws://placeholder.invalid" };
    const harnessSessions = new HarnessSessionManager(config);
    await harnessSessions.startSession(createSessionStartPayload(workspace.project));
    await harnessSessions.sendTurn({
      session_id: "session-1",
      turn_id: "turn-1",
      input: "hello",
    });
    const server = await startServer(async (socket: WebSocket, messages: HcpMessage[]) => {
      const hello = await waitForMessage(messages, "host.hello");
      assert.deepEqual(hello.payload.resume?.sessions, [{ session_id: "session-1", last_event_sequence: 3 }]);
      socket.send(
        JSON.stringify(
          createHcpEnvelope("host.accepted", {
            protocol_version: HCP_VERSION,
            heartbeat_interval_seconds: 60,
          }),
        ),
      );
    });
    const connection = new RunnerConnection({
      config: { ...config, control_plane_url: server.url },
      runnerVersion: "0.0.0-test",
      harnessSessions,
      resumeCursor: { sessions: [{ session_id: "session-1", last_event_sequence: 3 }] },
    });

    try {
      await connection.connect();
      await waitForEventCount(server.messages, 2);
      const events = server.messages.filter((message) => message.type === "harness.event");
      assert.deepEqual(
        events.map((event) => event.payload.event_type),
        ["turn.started", "turn.completed"],
      );
    } finally {
      await connection.close();
      await server.close();
      await workspace.cleanup();
    }
  });
});

type TestServer = {
  url: string;
  messages: HcpMessage[];
  close(): Promise<void>;
};

async function startServer(onConnection: (socket: WebSocket, messages: HcpMessage[]) => Promise<void>): Promise<TestServer> {
  const httpServer: HttpServer = createServer();
  const webSocketServer = new WebSocketServer({ server: httpServer });
  const messages: HcpMessage[] = [];

  webSocketServer.on("connection", (socket: WebSocket) => {
    socket.on("message", (data: WebSocket.RawData) => {
      const parsed: HcpMessage = parseHcpMessage(JSON.parse(data.toString("utf8")));
      messages.push(parsed);
    });
    onConnection(socket, messages).catch((error: unknown) => {
      socket.close(1011, error instanceof Error ? error.message : "test server failed");
    });
  });

  const port = await new Promise<number>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => {
      const address = httpServer.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });

  return {
    url: `ws://127.0.0.1:${port}`,
    messages,
    close: async (): Promise<void> => {
      await new Promise<void>((resolve, reject) => {
        webSocketServer.close((socketError?: Error) => {
          if (socketError) {
            reject(socketError);
            return;
          }
          httpServer.close((serverError?: Error) => {
            if (serverError) {
              reject(serverError);
              return;
            }
            resolve();
          });
        });
      });
    },
  };
}

async function waitForMessage<TType extends HcpMessage["type"]>(
  messages: HcpMessage[],
  type: TType,
): Promise<Extract<HcpMessage, { type: TType }>> {
  return waitFor(messages, (message): message is Extract<HcpMessage, { type: TType }> => message.type === type);
}

async function waitForMessageCount<TType extends HcpMessage["type"]>(
  messages: HcpMessage[],
  type: TType,
  count: number,
): Promise<void> {
  await waitFor(
    messages,
    (message): message is Extract<HcpMessage, { type: TType }> =>
      message.type === type && messages.filter((candidate) => candidate.type === type).length >= count,
  );
}

async function waitForAck(messages: HcpMessage[], receivedMessageId: string) {
  return waitFor(
    messages,
    (message): message is Extract<HcpMessage, { type: "hcp.command.ack" }> =>
      message.type === "hcp.command.ack" && message.payload.command_id === receivedMessageId,
  );
}

async function waitForAckCount(messages: HcpMessage[], count: number) {
  return waitFor(
    messages,
    (message): message is Extract<HcpMessage, { type: "hcp.command.ack" }> =>
      message.type === "hcp.command.ack" &&
      messages.filter((candidate) => candidate.type === "hcp.command.ack").length >= count,
  );
}

async function waitForDuplicateAck(messages: HcpMessage[], commandId: string) {
  return waitFor(
    messages,
    (message): message is Extract<HcpMessage, { type: "hcp.command.ack" }> =>
      message.type === "hcp.command.ack" && message.payload.command_id === commandId && message.payload.duplicate,
  );
}

async function waitForEventCount(messages: HcpMessage[], count: number) {
  return waitFor(
    messages,
    (message): message is Extract<HcpMessage, { type: "harness.event" }> =>
      message.type === "harness.event" &&
      messages.filter((candidate) => candidate.type === "harness.event").length >= count,
  );
}

async function waitForHarnessEvent(messages: HcpMessage[], eventType: HcpHarnessEventPayload["event_type"]) {
  return waitFor(
    messages,
    (message): message is Extract<HcpMessage, { type: "harness.event" }> =>
      message.type === "harness.event" && message.payload.event_type === eventType,
  );
}

async function waitForLocalActionResponseCount(messages: HcpMessage[], requestId: string, count: number) {
  return waitFor(
    messages,
    (message): message is Extract<HcpMessage, { type: "local.action.response" }> =>
      message.type === "local.action.response" &&
      message.payload.request_id === requestId &&
      messages.filter(
        (candidate) => candidate.type === "local.action.response" && candidate.payload.request_id === requestId,
      ).length >= count,
  );
}

async function waitForLocalActionError(messages: HcpMessage[], requestId: string, code: string) {
  return waitFor(
    messages,
    (message): message is Extract<HcpMessage, { type: "local.action.error" }> =>
      message.type === "local.action.error" &&
      message.payload.request_id === requestId &&
      message.payload.error.code === code,
  );
}

async function waitForLocalActionErrorCount(messages: HcpMessage[], requestId: string, code: string, count: number) {
  return waitFor(
    messages,
    (message): message is Extract<HcpMessage, { type: "local.action.error" }> =>
      message.type === "local.action.error" &&
      message.payload.request_id === requestId &&
      message.payload.error.code === code &&
      messages.filter(
        (candidate) =>
          candidate.type === "local.action.error" &&
          candidate.payload.request_id === requestId &&
          candidate.payload.error.code === code,
      ).length >= count,
  );
}

async function waitForNack(messages: HcpMessage[], receivedIdPrefix: string) {
  return waitFor(
    messages,
    (message): message is Extract<HcpMessage, { type: "hcp.command.nack" }> =>
      message.type === "hcp.command.nack" && message.payload.command_id.startsWith(receivedIdPrefix),
  );
}

async function waitForNackCode(messages: HcpMessage[], code: string) {
  return waitFor(
    messages,
    (message): message is Extract<HcpMessage, { type: "hcp.command.nack" }> =>
      message.type === "hcp.command.nack" && message.payload.error.code === code,
  );
}

async function waitForNackCount(messages: HcpMessage[], code: string, count: number) {
  return waitFor(
    messages,
    (message): message is Extract<HcpMessage, { type: "hcp.command.nack" }> =>
      message.type === "hcp.command.nack" &&
      messages.filter((candidate) => candidate.type === "hcp.command.nack" && candidate.payload.error.code === code)
        .length >= count,
  );
}

async function waitFor<T extends HcpMessage>(
  messages: HcpMessage[],
  predicate: (message: HcpMessage) => message is T,
): Promise<T> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const found: T | undefined = messages.find(predicate);
    if (found) {
      return found;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`Timed out waiting for runner message. Received: ${messages.map((message) => message.type).join(", ")}`);
}
