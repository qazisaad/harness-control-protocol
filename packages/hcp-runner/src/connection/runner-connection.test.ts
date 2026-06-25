import assert from "node:assert/strict";
import { createServer, type Server as HttpServer } from "node:http";
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

const configBase: Omit<RunnerConfig, "control_plane_url"> = {
  runner_id: "runner-test",
  workspaces: [{ id: "repo", path: "/tmp/repo" }],
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
    },
  ],
};

const sessionStartPayload: HcpSessionStartPayload = {
  session_id: "session-1",
  provider_instance_id: "mock-provider",
  driver_kind: "mock",
  cwd: "/tmp/repo/project",
  runtime_mode: "approval_required",
  sandbox_mode: "workspace_write",
  approval_policy: "ask",
  continue_session: false,
  model_selection: { model: "mock-model" },
  mcp_servers: [],
};

describe("RunnerConnection", () => {
  it("handles accepted, session.start, and turn.send with events and acks", async () => {
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
      const sessionStart = createHcpEnvelope("session.start", sessionStartPayload);
      socket.send(JSON.stringify(sessionStart));
      const turnSend = createHcpEnvelope("turn.send", {
        session_id: "session-1",
        turn_id: "turn-1",
        input: "hello",
      });
      socket.send(JSON.stringify(turnSend));
    });
    const connection = new RunnerConnection({
      config: { ...configBase, control_plane_url: server.url },
      runnerVersion: "0.0.0-test",
    });

    try {
      await connection.connect();
      const ack = await waitForAckCount(server.messages, 2);
      const events = server.messages.filter((message) => message.type === "harness.event");

      assert.equal(ack.payload.status, "ack");
      assert.deepEqual(
        events.map((event) => event.payload.event_type),
        ["session.started", "session.configured", "turn.started", "turn.completed"],
      );
    } finally {
      await connection.close();
      await server.close();
    }
  });

  it("nacks invalid messages and invalid session starts", async () => {
    const server = await startServer(async (socket: WebSocket, messages: HcpMessage[]) => {
      await waitForMessage(messages, "host.hello");
      socket.send(JSON.stringify({ id: "bad-message", type: "turn.send", version: HCP_VERSION, sent_at: new Date().toISOString(), payload: {} }));
      await waitForNack(messages, "bad-message");
      const sessionStart = createHcpEnvelope("session.start", {
        ...sessionStartPayload,
        session_id: "session-bad",
        cwd: "/tmp/not-allowed",
      });
      socket.send(JSON.stringify(sessionStart));
    });
    const connection = new RunnerConnection({
      config: { ...configBase, control_plane_url: server.url },
      runnerVersion: "0.0.0-test",
    });

    try {
      await connection.connect();
      const workspaceNack = await waitForNackCode(server.messages, "workspace_not_allowed");
      assert.equal(workspaceNack.payload.error.code, "workspace_not_allowed");
    } finally {
      await connection.close();
      await server.close();
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

async function waitForAck(messages: HcpMessage[], receivedMessageId: string) {
  return waitFor(
    messages,
    (message): message is Extract<HcpMessage, { type: "ack" }> =>
      message.type === "ack" && message.payload.received_message_id === receivedMessageId,
  );
}

async function waitForAckCount(messages: HcpMessage[], count: number) {
  return waitFor(
    messages,
    (message): message is Extract<HcpMessage, { type: "ack" }> =>
      message.type === "ack" && messages.filter((candidate) => candidate.type === "ack").length >= count,
  );
}

async function waitForNack(messages: HcpMessage[], receivedIdPrefix: string) {
  return waitFor(
    messages,
    (message): message is Extract<HcpMessage, { type: "nack" }> =>
      message.type === "nack" && message.payload.received_message_id.startsWith(receivedIdPrefix),
  );
}

async function waitForNackCode(messages: HcpMessage[], code: string) {
  return waitFor(
    messages,
    (message): message is Extract<HcpMessage, { type: "nack" }> =>
      message.type === "nack" && message.payload.error.code === code,
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
