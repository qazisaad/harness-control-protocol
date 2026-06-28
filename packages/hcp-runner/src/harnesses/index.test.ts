import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { HarnessSessionError, HarnessSessionManager, type HarnessMcpClient } from "./index.js";
import type { AuditLogEvent } from "../audit/index.js";
import type { LocalCapabilityConfig, RunnerConfig } from "../config/index.js";
import {
  HarnessAdapterError,
  HarnessAdapterRegistry,
  type HarnessAdapter,
  type HarnessAdapterEvent,
  type HarnessAdapterSession,
} from "./adapters.js";

const defaultCapabilities: LocalCapabilityConfig[] = [
  { id: "filesystem", status: "available", scopes: ["workspace_read", "workspace_write"], approval_required: false },
  { id: "git", status: "available", scopes: ["workspace_read"], approval_required: false },
  { id: "shell", status: "available", scopes: ["workspace"], approval_required: true },
];

function createConfig(workspacePath: string, localCapabilities: LocalCapabilityConfig[] = defaultCapabilities): RunnerConfig {
  return {
    runner_id: "runner-test",
    host_id: "host-test",
    control_plane_url: "ws://127.0.0.1:8787",
    workspaces: [{ id: "repo", path: workspacePath }],
    local_capabilities: localCapabilities,
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

function createCodexConfig(workspacePath: string): RunnerConfig {
  return {
    ...createConfig(workspacePath),
    provider_instances: [
      {
        id: "codex-local",
        driver_kind: "codex",
        enabled: true,
        launch_args: [],
        env: {},
        models: [{ id: "gpt-test", label: "GPT Test", capabilities: { option_descriptors: [] } }],
        hidden_models: [],
        model_order: [],
        favorite_models: [],
        local_capabilities: ["filesystem", "git", "shell"],
      },
    ],
  };
}

async function createWorkspace(): Promise<{ root: string; project: string; cleanup: () => Promise<void> }> {
  const root: string = await mkdtemp(join(tmpdir(), "hcp-runner-workspace-"));
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

describe("HarnessSessionManager", () => {
  it("starts sessions and accepts turns with HCP events", async () => {
    const workspace = await createWorkspace();
    const manager = new HarnessSessionManager(createConfig(workspace.root));

    try {
      const sessionEvents = await manager.startSession({
        session_id: "session-1",
        workspace_id: "repo",
        provider_instance_id: "mock-provider",
        driver_kind: "mock",
        cwd: workspace.project,
        sandbox_mode: "workspace_write",
        approval_policy: "ask",
        continue_session: false,
        model_selection: { model: "mock-model" },
        mcp_servers: [],
      });
      const turnEvents = await manager.sendTurn({
        session_id: "session-1",
        turn_id: "turn-1",
        input: "hello",
      });

      assert.deepEqual(
        sessionEvents.map((event) => event.event_type),
        ["session.started", "workspace.preflight.completed", "session.configured"],
      );
      assert.deepEqual(
        turnEvents.map((event) => event.event_type),
        ["turn.started", "turn.completed"],
      );
      assert.equal(sessionEvents[0]?.sequence, 1);
      assert.equal(turnEvents[0]?.sequence, 4);
    } finally {
      await workspace.cleanup();
    }
  });

  it("rejects unknown providers and disallowed workspaces", async () => {
    const workspace = await createWorkspace();
    const outside = await createWorkspace();
    const manager = new HarnessSessionManager(createConfig(workspace.root));

    try {
      await assert.rejects(
        () =>
          manager.startSession({
            session_id: "session-1",
            workspace_id: "repo",
            provider_instance_id: "missing",
            driver_kind: "mock",
            cwd: workspace.root,
            sandbox_mode: "workspace_write",
            approval_policy: "ask",
            continue_session: false,
            model_selection: { model: "mock-model" },
            mcp_servers: [],
          }),
        HarnessSessionError,
      );

      await assert.rejects(
        () =>
          manager.startSession({
            session_id: "session-2",
            workspace_id: "repo",
            provider_instance_id: "mock-provider",
            driver_kind: "mock",
            cwd: outside.root,
            sandbox_mode: "workspace_write",
            approval_policy: "ask",
            continue_session: false,
            model_selection: { model: "mock-model" },
            mcp_servers: [],
          }),
        /not allowed/,
      );
    } finally {
      await workspace.cleanup();
      await outside.cleanup();
    }
  });

  it("rejects session starts when no workspace allowlist is configured", async () => {
    const workspace = await createWorkspace();
    const noWorkspaceConfig: RunnerConfig = {
      ...createConfig(workspace.root),
      workspaces: [],
    };
    const manager = new HarnessSessionManager(noWorkspaceConfig);

    try {
      await assert.rejects(
        () =>
          manager.startSession({
            session_id: "session-1",
            workspace_id: "repo",
            provider_instance_id: "mock-provider",
            driver_kind: "mock",
            cwd: workspace.root,
            sandbox_mode: "workspace_write",
            approval_policy: "ask",
            continue_session: false,
            model_selection: { model: "mock-model" },
            mcp_servers: [],
          }),
        /no workspaces configured/,
      );
    } finally {
      await workspace.cleanup();
    }
  });

  it("rejects symlink workspace escapes", async () => {
    const workspace = await createWorkspace();
    const outside = await createWorkspace();
    const symlinkPath: string = join(workspace.root, "outside-link");
    await symlink(outside.root, symlinkPath);
    const manager = new HarnessSessionManager(createConfig(workspace.root));

    try {
      await assert.rejects(
        () =>
          manager.startSession({
            session_id: "session-1",
            workspace_id: "repo",
            provider_instance_id: "mock-provider",
            driver_kind: "mock",
            cwd: symlinkPath,
            sandbox_mode: "workspace_write",
            approval_policy: "ask",
            continue_session: false,
            model_selection: { model: "mock-model" },
            mcp_servers: [],
          }),
        /not allowed/,
      );
    } finally {
      await workspace.cleanup();
      await outside.cleanup();
    }
  });

  it("rejects local capability leases with mismatched host, workspace, unsupported capabilities, or unavailable scopes", async () => {
    const workspace = await createWorkspace();
    const manager = new HarnessSessionManager(createConfig(workspace.root), "host-test");
    const basePayload = {
      session_id: "session-1",
      workspace_id: "repo",
      provider_instance_id: "mock-provider",
      driver_kind: "mock",
      cwd: workspace.root,
      sandbox_mode: "workspace_write" as const,
      approval_policy: "ask" as const,
      continue_session: false,
      model_selection: { model: "mock-model" },
      mcp_servers: [],
      local_capability_lease: {
        lease_id: "local_lease_123",
        org_id: "org_123",
        workflow_id: "workflow_123",
        run_id: "run_123",
        node_id: "node_123",
        hcp_session_id: "session-1",
        execution_host_id: "host-test",
        provider_instance_id: "mock-provider",
        workspace_id: "repo",
        issued_at: "2026-01-01T00:00:00.000Z",
        expires_at: "2999-01-01T00:00:00.000Z",
        policy_version: "policy_1",
        capabilities: [{ id: "filesystem", scopes: ["workspace_read"] }],
      },
    };

    try {
      const events = await manager.startSession(basePayload);
      assert.equal(events.at(-1)?.event_type, "local_capability.lease.created");

      const badManager = new HarnessSessionManager(createConfig(workspace.root), "host-test");
      await assert.rejects(
        () =>
          badManager.startSession({
            ...basePayload,
            session_id: "session-bad",
            local_capability_lease: {
              ...basePayload.local_capability_lease,
              hcp_session_id: "session-bad",
              capabilities: [{ id: "browser", scopes: ["page"] }],
            },
          }),
        /Capability 'browser'/,
      );

      const readOnlyConfig = createConfig(workspace.root, [
        { id: "filesystem", status: "available", scopes: ["workspace_read"], approval_required: false },
      ]);
      const readOnlyManager = new HarnessSessionManager(readOnlyConfig, "host-test");
      await assert.rejects(
        () =>
          readOnlyManager.startSession({
            ...basePayload,
            session_id: "session-scope-bad",
            local_capability_lease: {
              ...basePayload.local_capability_lease,
              hcp_session_id: "session-scope-bad",
              capabilities: [{ id: "filesystem", scopes: ["workspace_write"] }],
            },
          }),
        /unavailable scopes/,
      );
    } finally {
      await workspace.cleanup();
    }
  });

  it("connects and closes MCP attachment clients for a session", async () => {
    const workspace = await createWorkspace();
    const connected: string[] = [];
    const closed: string[] = [];
    const mcpClient: HarnessMcpClient = {
      async connect(): Promise<void> {
        connected.push("tools");
      },
      async close(): Promise<void> {
        closed.push("tools");
      },
    };
    const manager = new HarnessSessionManager(createConfig(workspace.root), {
      hostId: "host-test",
      mcpClientFactory() {
        return mcpClient;
      },
    });

    try {
      await manager.startSession({
        session_id: "session-1",
        workspace_id: "repo",
        provider_instance_id: "mock-provider",
        driver_kind: "mock",
        cwd: workspace.root,
        sandbox_mode: "workspace_write",
        approval_policy: "ask",
        continue_session: false,
        model_selection: { model: "mock-model" },
        mcp_servers: [
          {
            name: "tools",
            transport: "streamable_http",
            url: "https://example.com/mcp",
            headers: { Authorization: "Bearer token" },
            lease_id: "mcp_lease_123",
            proof_of_possession: {
              scheme: "runner_signed_request",
              key_id: "proof_key_123",
              required_headers: ["x-hcp-proof-signature"],
            },
          },
        ],
      });
      await manager.stopSession("session-1", "done");

      assert.deepEqual(connected, ["tools"]);
      assert.deepEqual(closed, ["tools"]);
    } finally {
      await workspace.cleanup();
    }
  });

  it("validates adapter start, connects MCP clients, then starts the adapter session", async () => {
    const workspace = await createWorkspace();
    const calls: string[] = [];
    const adapter: HarnessAdapter = {
      driverKind: "mock",
      async probe() {
        return {
          provider_instance_id: "mock-provider",
          driver_kind: "mock",
          installed: true,
          available: true,
          status: "ready",
          models: [],
        };
      },
      async validateStart(): Promise<void> {
        calls.push("validate");
      },
      async startSession(input): Promise<HarnessAdapterSession> {
        calls.push("start");
        return { adapter_session_id: input.payload.session_id };
      },
      async sendTurn(): Promise<HarnessAdapterEvent[]> {
        return [];
      },
      async cancelTurn(): Promise<HarnessAdapterEvent[]> {
        return [];
      },
      async stopSession(): Promise<HarnessAdapterEvent[]> {
        return [];
      },
    };
    const manager = new HarnessSessionManager(createConfig(workspace.root), {
      hostId: "host-test",
      adapterRegistry: new HarnessAdapterRegistry([adapter]),
      mcpClientFactory() {
        return {
          async connect(): Promise<void> {
            calls.push("connect");
          },
          async close(): Promise<void> {
            calls.push("close");
          },
        };
      },
    });

    try {
      await manager.startSession({
        session_id: "session-1",
        workspace_id: "repo",
        provider_instance_id: "mock-provider",
        driver_kind: "mock",
        cwd: workspace.root,
        sandbox_mode: "workspace_write",
        approval_policy: "ask",
        continue_session: false,
        model_selection: { model: "mock-model" },
        mcp_servers: [
          {
            name: "tools",
            transport: "streamable_http",
            url: "https://example.com/mcp",
            headers: { Authorization: "Bearer token" },
            lease_id: "mcp_lease_123",
            proof_of_possession: {
              scheme: "runner_signed_request",
              key_id: "proof_key_123",
              required_headers: ["x-hcp-proof-signature"],
            },
          },
        ],
      });

      assert.deepEqual(calls, ["validate", "connect", "start"]);
    } finally {
      await workspace.cleanup();
    }
  });

  it("attempts adapter stop when adapter start and MCP cleanup both fail", async () => {
    const workspace = await createWorkspace();
    const calls: string[] = [];
    const adapter: HarnessAdapter = {
      driverKind: "mock",
      async probe() {
        return {
          provider_instance_id: "mock-provider",
          driver_kind: "mock",
          installed: true,
          available: true,
          status: "ready",
          models: [],
        };
      },
      async validateStart(): Promise<void> {
        calls.push("validate");
      },
      async startSession(): Promise<HarnessAdapterSession> {
        calls.push("start");
        throw new Error("adapter start failed");
      },
      async sendTurn(): Promise<HarnessAdapterEvent[]> {
        return [];
      },
      async cancelTurn(): Promise<HarnessAdapterEvent[]> {
        return [];
      },
      async stopSession(): Promise<HarnessAdapterEvent[]> {
        calls.push("stop");
        return [];
      },
    };
    const manager = new HarnessSessionManager(createConfig(workspace.root), {
      hostId: "host-test",
      adapterRegistry: new HarnessAdapterRegistry([adapter]),
      mcpClientFactory() {
        return {
          async connect(): Promise<void> {
            calls.push("connect");
          },
          async close(): Promise<void> {
            calls.push("close");
            throw new Error("mcp close failed");
          },
        };
      },
    });

    try {
      await assert.rejects(
        () =>
          manager.startSession({
            session_id: "session-1",
            workspace_id: "repo",
            provider_instance_id: "mock-provider",
            driver_kind: "mock",
            cwd: workspace.root,
            sandbox_mode: "workspace_write",
            approval_policy: "ask",
            continue_session: false,
            model_selection: { model: "mock-model" },
            mcp_servers: [
              {
                name: "tools",
                transport: "streamable_http",
                url: "https://example.com/mcp",
                headers: { Authorization: "Bearer token" },
                lease_id: "mcp_lease_123",
                proof_of_possession: {
                  scheme: "runner_signed_request",
                  key_id: "proof_key_123",
                  required_headers: ["x-hcp-proof-signature"],
                },
              },
            ],
          }),
        (error: unknown): boolean =>
          error instanceof HarnessSessionError &&
          error.code === "adapter_start_cleanup_failed" &&
          error.message.includes("adapter start failed") &&
          error.message.includes("mcp close failed"),
      );

      assert.deepEqual(calls, ["validate", "connect", "start", "close", "stop"]);
    } finally {
      await workspace.cleanup();
    }
  });

  it("proxies Codex MCP attachments before adapter start", async () => {
    const workspace = await createWorkspace();
    const connected: string[] = [];
    const manager = new HarnessSessionManager(createCodexConfig(workspace.root), {
      mcpClientFactory(request) {
        return {
          get adapterAttachment() {
            return {
              ...request.attachment,
              url: "http://127.0.0.1:12345/mcp",
              headers: {},
            };
          },
          async connect(): Promise<void> {
            connected.push(request.attachment.name);
          },
          async close(): Promise<void> {
            return;
          },
        };
      },
    });

    try {
      const events = await manager.startSession({
        session_id: "session-1",
        workspace_id: "repo",
        provider_instance_id: "codex-local",
        driver_kind: "codex",
        cwd: workspace.root,
        sandbox_mode: "workspace_write",
        approval_policy: "ask",
        continue_session: false,
        model_selection: { model: "gpt-test" },
        mcp_servers: [
          {
            name: "tools",
            transport: "streamable_http",
            url: "https://example.com/mcp",
            headers: { Authorization: "Bearer token" },
            lease_id: "mcp_lease_123",
            proof_of_possession: {
              scheme: "runner_signed_request",
              key_id: "proof_key_123",
              required_headers: ["x-hcp-proof-signature"],
            },
          },
        ],
      });

      assert.deepEqual(connected, ["tools"]);
      assert.deepEqual(
        events.map((event) => event.event_type),
        ["session.started", "workspace.preflight.completed", "session.configured", "mcp.status.updated"],
      );
      await manager.stopSession("session-1", "done");
    } finally {
      await workspace.cleanup();
    }
  });

  it("closes Codex MCP clients when an attachment factory does not provide a proxy", async () => {
    const workspace = await createWorkspace();
    const connected: string[] = [];
    const closed: string[] = [];
    const manager = new HarnessSessionManager(createCodexConfig(workspace.root), {
      mcpClientFactory(request) {
        return {
          async connect(): Promise<void> {
            connected.push(request.attachment.name);
          },
          async close(): Promise<void> {
            closed.push(request.attachment.name);
          },
        };
      },
    });

    try {
      await assert.rejects(
        () =>
          manager.startSession({
            session_id: "session-1",
            workspace_id: "repo",
            provider_instance_id: "codex-local",
            driver_kind: "codex",
            cwd: workspace.root,
            sandbox_mode: "workspace_write",
            approval_policy: "ask",
            continue_session: false,
            model_selection: { model: "gpt-test" },
            mcp_servers: [
              {
                name: "tools",
                transport: "streamable_http",
                url: "https://example.com/mcp",
                headers: { Authorization: "Bearer token" },
                lease_id: "mcp_lease_123",
                proof_of_possession: {
                  scheme: "runner_signed_request",
                  key_id: "proof_key_123",
                  required_headers: ["x-hcp-proof-signature"],
                },
              },
            ],
          }),
        (error: unknown): boolean =>
          error instanceof HarnessAdapterError && error.code === "codex_mcp_attachment_requires_proxy",
      );
      assert.deepEqual(connected, ["tools"]);
      assert.deepEqual(closed, ["tools"]);
    } finally {
      await workspace.cleanup();
    }
  });

  it("retains replayable events and reports replay gaps", async () => {
    const workspace = await createWorkspace();
    const manager = new HarnessSessionManager(createConfig(workspace.root), {
      replayRetentionEventsPerSession: 4,
    });

    try {
      await manager.startSession({
        session_id: "session-1",
        workspace_id: "repo",
        provider_instance_id: "mock-provider",
        driver_kind: "mock",
        cwd: workspace.root,
        sandbox_mode: "workspace_write",
        approval_policy: "ask",
        continue_session: false,
        model_selection: { model: "mock-model" },
        mcp_servers: [],
      });
      await manager.sendTurn({
        session_id: "session-1",
        turn_id: "turn-1",
        input: "hello",
      });

      const replayed = manager.replayEventsAfter({
        sessions: [{ session_id: "session-1", last_event_sequence: 3 }],
      });
      assert.deepEqual(
        replayed.map((event) => event.event_type),
        ["turn.started", "turn.completed"],
      );

      const unavailable = manager.replayEventsAfter({
        sessions: [{ session_id: "session-1", last_event_sequence: 0 }],
      });
      assert.equal(unavailable[0]?.event_type, "session.replay_unavailable");
      assert.equal((unavailable[0]?.data as Record<string, unknown> | undefined)?.reason, "cursor_outside_retention");
    } finally {
      await workspace.cleanup();
    }
  });

  it("writes redacted audit events through the configured audit logger", async () => {
    const workspace = await createWorkspace();
    const auditEvents: AuditLogEvent[] = [];
    const manager = new HarnessSessionManager(createConfig(workspace.root), {
      auditLogger: {
        async record(event: AuditLogEvent): Promise<void> {
          auditEvents.push(event);
        },
      },
    });

    try {
      await manager.startSession({
        session_id: "session-1",
        workspace_id: "repo",
        provider_instance_id: "mock-provider",
        driver_kind: "mock",
        cwd: workspace.root,
        sandbox_mode: "workspace_write",
        approval_policy: "ask",
        continue_session: false,
        model_selection: { model: "mock-model" },
        mcp_servers: [],
      });
      await manager.sendTurn({
        session_id: "session-1",
        turn_id: "turn-1",
        input: "hello",
      });

      assert.deepEqual(
        auditEvents.map((event) => event.event),
        ["session.started", "turn.completed"],
      );
      assert.equal(auditEvents[0]?.session_id, "session-1");
      assert.equal(auditEvents[1]?.turn_id, "turn-1");
    } finally {
      await workspace.cleanup();
    }
  });
});
