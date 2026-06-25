import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer, type Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { WebSocket, WebSocketServer } from "ws";

import {
  HCP_VERSION,
  createHcpEnvelope,
  parseHcpMessage,
  type HcpMessage,
  type HcpSessionStartPayload,
} from "@hcp-runner/protocol";

import { RunnerConnection } from "./runner-connection.js";
import type { RunnerConfig } from "../config/index.js";

type TestWorkspace = {
  root: string;
  project: string;
  cleanup(): Promise<void>;
};

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
