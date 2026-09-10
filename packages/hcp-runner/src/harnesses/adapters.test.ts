import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import type { HcpSessionStartPayload } from "@harness-control/protocol";

import type { ProviderInstanceConfig } from "../config/index.js";
import {
  HarnessAdapterError,
  OpenCodeHarnessAdapter,
  type HarnessAdapterEvent,
  type OpenCodeRuntime,
  type OpenCodeRuntimeTurnInput,
} from "./adapters.js";

type FilesystemError = Error & {
  code?: string;
};

function provider(executablePath: string, env: Record<string, string> = {}): ProviderInstanceConfig {
  return {
    id: "codex-local",
    driver_kind: "codex",
    enabled: true,
    executable_path: executablePath,
    launch_args: [],
    env,
    models: [
      {
        id: "gpt-test",
        label: "GPT Test",
        capabilities: {
          option_descriptors: [],
        },
      },
    ],
    hidden_models: [],
    model_order: [],
    favorite_models: [],
    local_capabilities: ["filesystem", "git", "shell"],
  };
}

function openCodeProvider(): ProviderInstanceConfig {
  return {
    ...provider("opencode"),
    id: "opencode-local",
    driver_kind: "opencode",
    models: [
      {
        id: "anthropic/claude-sonnet-4",
        label: "Claude Sonnet 4",
        capabilities: { option_descriptors: [] },
      },
    ],
  };
}

function startPayload(workspace: string): HcpSessionStartPayload {
  return {
    session_id: "session-1",
    workspace_id: "workspace-1",
    provider_instance_id: "codex-local",
    driver_kind: "codex",
    cwd: workspace,
    sandbox_mode: "workspace_write",
    approval_policy: "ask",
    continue_session: false,
    model_selection: { model: "gpt-test" },
    mcp_servers: [],
  };
}

function openCodeStartPayload(workspace: string): HcpSessionStartPayload {
  return {
    ...startPayload(workspace),
    provider_instance_id: "opencode-local",
    driver_kind: "opencode",
    model_selection: { model: "anthropic/claude-sonnet-4" },
  };
}

async function createWorkspace(): Promise<{ root: string; cleanup(): Promise<void> }> {
  const root: string = await mkdtemp(join(tmpdir(), "hcp-codex-workspace-"));
  return {
    root,
    cleanup: async (): Promise<void> => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function waitForPath(path: string): Promise<void> {
  const deadline: number = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch (error: unknown) {
      if (!isMissingPathError(error)) {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${path}.`);
}

function isMissingPathError(error: unknown): error is FilesystemError {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

describe("OpenCodeHarnessAdapter", () => {
  it("runs the OpenCode server HTTP and SSE lifecycle", async () => {
    const workspace = await createWorkspace();
    const fixturePath: string = fileURLToPath(new URL("../../test-fixtures/fake-opencode-server.mjs", import.meta.url));
    const selectedProvider: ProviderInstanceConfig = {
      ...openCodeProvider(),
      executable_path: process.execPath,
      launch_args: [fixturePath],
    };
    const selectedStartPayload: HcpSessionStartPayload = openCodeStartPayload(workspace.root);
    const adapter = new OpenCodeHarnessAdapter();
    let started = false;

    try {
      const status = await adapter.probe(selectedProvider);
      assert.equal(status.available, true);
      assert.equal(status.version, "opencode 1.2.3-test");
      const session = await adapter.startSession({ payload: selectedStartPayload, provider: selectedProvider });
      started = true;
      const streamed: HarnessAdapterEvent[] = [];
      const terminal = await adapter.sendTurn({
        session,
        startPayload: selectedStartPayload,
        provider: selectedProvider,
        payload: { session_id: "session-1", turn_id: "turn-http", input: "hello" },
        emitEvent(event: HarnessAdapterEvent): void {
          streamed.push(event);
        },
      });
      assert.deepEqual(
        streamed.map((event: HarnessAdapterEvent): string => event.event_type),
        ["reasoning.delta", "content.delta"],
      );
      assert.equal(terminal[0]?.event_type, "turn.completed");
      assert.deepEqual(terminal[0]?.data.final_output, { final_text: "hello" });
    } finally {
      if (started) await adapter.stopSession({ sessionId: "session-1" });
      await workspace.cleanup();
    }
  });

  it("streams provider deltas before returning the terminal event", async () => {
    const workspace = await createWorkspace();
    const runtimeCalls: string[] = [];
    const runtime: OpenCodeRuntime = {
      sessionId: "opencode-session-1",
      async sendTurn(input: OpenCodeRuntimeTurnInput): Promise<string> {
        runtimeCalls.push(`${input.model}:${input.input}`);
        input.emitEvent({ event_type: "reasoning.delta", turn_id: input.turnId, data: { delta: "thinking" } });
        input.emitEvent({ event_type: "content.delta", turn_id: input.turnId, data: { delta: "hello" } });
        return "hello";
      },
      async cancelTurn(): Promise<void> {
        runtimeCalls.push("cancel");
      },
      async close(): Promise<void> {
        runtimeCalls.push("close");
      },
    };
    const adapter = new OpenCodeHarnessAdapter({ runtimeFactory: async (): Promise<OpenCodeRuntime> => runtime });
    const selectedProvider: ProviderInstanceConfig = openCodeProvider();
    const selectedStartPayload: HcpSessionStartPayload = openCodeStartPayload(workspace.root);

    try {
      const session = await adapter.startSession({ payload: selectedStartPayload, provider: selectedProvider });
      const streamed: HarnessAdapterEvent[] = [];
      const terminal: HarnessAdapterEvent[] = await adapter.sendTurn({
        session,
        startPayload: selectedStartPayload,
        provider: selectedProvider,
        payload: { session_id: "session-1", turn_id: "turn-1", input: "Say hello." },
        emitEvent(event: HarnessAdapterEvent): void {
          streamed.push(event);
        },
      });

      assert.deepEqual(
        streamed.map((event: HarnessAdapterEvent): string => event.event_type),
        ["reasoning.delta", "content.delta"],
      );
      assert.equal(terminal[0]?.event_type, "turn.completed");
      assert.deepEqual(terminal[0]?.data.final_output, { final_text: "hello" });
      assert.deepEqual(runtimeCalls, ["anthropic/claude-sonnet-4:Say hello."]);
      await adapter.stopSession({ sessionId: "session-1" });
      assert.deepEqual(runtimeCalls, ["anthropic/claude-sonnet-4:Say hello.", "close"]);
    } finally {
      await workspace.cleanup();
    }
  });

  it("passes only runner-proxied MCP URLs into OpenCode server config", async () => {
    const workspace = await createWorkspace();
    let configuredUrl = "";
    const runtime: OpenCodeRuntime = {
      sessionId: "opencode-session-1",
      async sendTurn(): Promise<string> {
        return "";
      },
      async cancelTurn(): Promise<void> {},
      async close(): Promise<void> {},
    };
    const adapter = new OpenCodeHarnessAdapter({
      runtimeFactory: async (input): Promise<OpenCodeRuntime> => {
        configuredUrl = input.mcpServers.tools?.url ?? "";
        return runtime;
      },
    });
    const selectedProvider: ProviderInstanceConfig = openCodeProvider();
    const selectedStartPayload: HcpSessionStartPayload = {
      ...openCodeStartPayload(workspace.root),
      mcp_servers: [
        {
          name: "tools",
          transport: "streamable_http",
          url: "http://127.0.0.1:12345/mcp",
          headers: {},
          lease_id: "mcp_lease_123",
          proof_of_possession: {
            scheme: "runner_signed_request",
            key_id: "proof_key_123",
            required_headers: ["x-hcp-proof-signature"],
          },
        },
      ],
    };

    try {
      await adapter.startSession({ payload: selectedStartPayload, provider: selectedProvider });
      assert.equal(configuredUrl, "http://127.0.0.1:12345/mcp");
      await adapter.stopSession({ sessionId: "session-1" });
    } finally {
      await workspace.cleanup();
    }
  });

  it("returns cancellation without also emitting a failed terminal event", async () => {
    const workspace = await createWorkspace();
    let rejectTurn: (error: Error) => void = () => {};
    let markStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const runtime: OpenCodeRuntime = {
      sessionId: "opencode-session-1",
      async sendTurn(): Promise<string> {
        markStarted();
        return await new Promise<string>((_resolve, reject) => {
          rejectTurn = reject;
        });
      },
      async cancelTurn(): Promise<void> {
        rejectTurn(new Error("aborted"));
      },
      async close(): Promise<void> {},
    };
    const adapter = new OpenCodeHarnessAdapter({ runtimeFactory: async (): Promise<OpenCodeRuntime> => runtime });
    const selectedProvider: ProviderInstanceConfig = openCodeProvider();
    const selectedStartPayload: HcpSessionStartPayload = openCodeStartPayload(workspace.root);

    try {
      const session = await adapter.startSession({ payload: selectedStartPayload, provider: selectedProvider });
      const turnCompletion = adapter.sendTurn({
        session,
        startPayload: selectedStartPayload,
        provider: selectedProvider,
        payload: { session_id: "session-1", turn_id: "turn-cancel", input: "wait" },
      });
      await started;
      const cancellation = await adapter.cancelTurn({ sessionId: "session-1", turnId: "turn-cancel" });
      assert.deepEqual(await turnCompletion, []);
      assert.equal(cancellation[0]?.event_type, "turn.cancelled");
      await adapter.stopSession({ sessionId: "session-1" });
    } finally {
      await workspace.cleanup();
    }
  });
});
