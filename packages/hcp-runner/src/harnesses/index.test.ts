import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { HarnessSessionError, HarnessSessionManager, type HarnessMcpClient } from "./index.js";
import type { AuditLogEvent } from "../audit/index.js";
import type { LocalCapabilityConfig, RunnerConfig } from "../config/index.js";
import type { HcpHarnessEventPayload, HcpSessionStartPayload } from "@harness-control/protocol";
import { JsonRunnerStateStore } from "../state/index.js";
import { HarnessMcpReview } from "./mcp-review.js";
import { McpInputRequiredError, parseMcpPendingInput } from "../mcp/input-required.js";
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
    mcp_stdio_profiles: [],
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

function createClaudeConfig(workspacePath: string): RunnerConfig {
  return {
    ...createConfig(workspacePath),
    provider_instances: [
      {
        id: "claude-local",
        driver_kind: "claude",
        enabled: true,
        launch_args: [],
        env: {},
        models: [{ id: "sonnet", label: "Claude Sonnet", capabilities: { option_descriptors: [] } }],
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
  for (const closeFails of [false, true]) {
    it(`records MCP startup cleanup only after the failed client closes (closeFails=${closeFails})`, async () => {
      const workspace = await createWorkspace();
      let closed = 0;
      const manager = new HarnessSessionManager(createConfig(workspace.root), {
        mcpClientFactory: () => ({
          async connect() { throw new Error("MCP connection rejected"); },
          async close() { closed++; if (closeFails) throw new Error("MCP close failed"); },
        }),
      });
      try {
        await assert.rejects(manager.startSession({
          session_id: "failed-start", workspace_id: "repo", provider_instance_id: "mock-provider",
          driver_kind: "mock", cwd: workspace.root, sandbox_mode: "read_only", approval_policy: "ask",
          continue_session: false, model_selection: {model: "mock-model"},
          mcp_servers: [{name: "tools", transport: "streamable_http", url: "https://example.com/mcp",
            headers: {}, lease_id: "lease", proof_of_possession: {scheme: "runner_signed_request",
              key_id: "key", required_headers: ["x-hcp-proof-signature"]}}],
        }));
        assert.equal(closed, 1);
        const replay = manager.replayEventsAfter({sessions: [{session_id: "failed-start", last_event_sequence: 0}]});
        assert.deepEqual(replay.events.map(event => event.event_type), closeFails ? [] : ["session.exited"]);
        assert.equal(manager.activeSessionCount(), 0);
        if (!closeFails) assert.deepEqual(await manager.stopSession("failed-start", "cleanup"), []);
      } finally { await workspace.cleanup(); }
    });
  }
  it("restores a waiting MCP input and delivers the result through the original native continuation", async () => {
    const workspace = await createWorkspace();
    const path = join(workspace.root, "runner-state.json");
    const store = new JsonRunnerStateStore(path);
    const start: HcpSessionStartPayload = {session_id: "input-session", workspace_id: "repo", provider_instance_id: "codex-local",
      driver_kind: "codex", cwd: workspace.project, sandbox_mode: "read_only", approval_policy: "full_access",
      continue_session: false, model_selection: {model: "gpt-test"}, mcp_servers: [{name: "tools", transport: "streamable_http",
        url: "https://example.com/mcp", lease_id: "lease", expires_at: new Date(Date.now() + 60000).toISOString(),
        headers: {}, proof_of_possession: {scheme: "runner_signed_request", key_id: "key", required_headers: ["x-hcp-proof-signature"]}}]};
    const turn = {session_id: start.session_id, turn_id: "turn", input: "Read"};
    let notify!: () => void;
    const published = new Promise<void>(resolve => {notify = resolve;});
    const owner = new HarnessMcpReview(store, start, turn, event => {if (event.event_type === "input.requested") notify();});
    const request = {attachment_name: "tools", tool_name: "lookup", arguments: {query: "exact"},
      native_thread_id: "native-thread", native_turn_id: "native-turn", native_call_id: "native-call"};
    const pending = parseMcpPendingInput({requestState: "opaque-original", inputRequests: {q: {
      method: "elicitation/create", params: {message: "Name?", requestedSchema: {type: "object", properties: {name: {type: "string"}}}},
    }}});
    const abandoned = owner.invoke(request, async () => {throw new McpInputRequiredError(pending);}, new AbortController().signal);
    await published;
    owner.interrupt();
    await assert.rejects(abandoned, /interrupted/);
    const retained = new JsonRunnerStateStore(path).getMcpReview(start.session_id)!;
    assert.ok(retained.outcome.phase === "input_waiting");
    const events: HcpHarnessEventPayload[] = [];
    let calls = 0;
    let nativeCompletions = 0;
    const adapter: HarnessAdapter = {
      driverKind: "codex", durableMcpContinuation: true,
      async probe() {return {provider_instance_id: "codex-local", driver_kind: "codex", installed: true, available: true, status: "ready", models: []};},
      async validateStart() {},
      async startSession(input) {return {adapter_session_id: input.payload.session_id};},
      async sendTurn(input) {
        nativeCompletions++;
        assert.equal(input.mcpContinuation?.native_thread_id, "native-thread");
        assert.equal(input.mcpContinuation?.request_id, retained.request_id);
        assert.deepEqual(input.mcpContinuation?.outcome, {kind: "completed", result: {is_error: false, content: [{type: "text", text: "done"}]}});
        return [{event_type: "turn.completed", data: {status: "completed", final_output: {final_text: "done"}}}];
      },
      async cancelTurn() {return [];},
      async stopSession() {return [];},
    };
    const manager = new HarnessSessionManager(createCodexConfig(workspace.root), {
      stateStore: new JsonRunnerStateStore(path), adapterRegistry: new HarnessAdapterRegistry([adapter]),
      mcpClientFactory: () => ({
        async connect() {}, async close() {},
        async listTools() {return [{name: "lookup", input_schema: {type: "object"}}];},
        async callTool(name, args, grant, reply) {
          calls++;
          assert.equal(name, "lookup"); assert.deepEqual(args, {query: "exact"}); assert.equal(grant, undefined);
          assert.deepEqual(reply, {pending, responses: {q: {action: "accept", content: {name: "Ada"}}}});
          assert.equal(new JsonRunnerStateStore(path).getMcpReview(start.session_id)?.outcome.phase, "input_resuming");
          return {is_error: false, content: [{type: "text", text: "done"}]};
        },
      }),
    });
    try {
      await manager.recoverMcpReviews(event => events.push(event), () => assert.fail("Waiting input must not auto-resume"));
      assert.equal(calls, 0);
      const response = {session_id: start.session_id, turn_id: turn.turn_id, request_id: retained.outcome.input_request_id,
        actor_id: "actor", value: {q: {action: "accept", content: {name: "Ada"}}}};
      const resolution = await manager.respondToMcpInput(response, event => events.push(event));
      assert.equal(resolution.kind, "resumed");
      if (resolution.kind === "resumed") await resolution.completion;
      assert.equal(calls, 1); assert.equal(nativeCompletions, 1);
      assert.ok(events.some(event => event.event_type === "turn.completed"));
      assert.equal(new JsonRunnerStateStore(path).getMcpReview(start.session_id), undefined);
      await assert.rejects(manager.respondToMcpInput(response, event => events.push(event)), /No waiting/);
      assert.equal(calls, 1);
    } finally {await manager.stopSession(start.session_id, "test complete"); await workspace.cleanup();}
  });

  it("rejects unimplemented workspace expectations before reporting preflight success", async () => {
    const workspace = await createWorkspace();
    try {
      const manager = new HarnessSessionManager(createConfig(workspace.root));
      await assert.rejects(manager.startSession({ session_id: "preflight", workspace_id: "repo", provider_instance_id: "mock-provider", driver_kind: "mock",
        cwd: workspace.root, sandbox_mode: "workspace_write", approval_policy: "ask", continue_session: false,
        model_selection: { model: "mock" }, mcp_servers: [], workspace_preflight: { workspace_id: "repo", required_paths: ["missing"] } }),
        (error: unknown) => error instanceof HarnessSessionError && error.code === "preflight_unsupported");
    } finally { await workspace.cleanup(); }
  });
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

  it("resolves a named runner stdio profile without accepting backend command fields", async () => {
    const workspace = await createWorkspace();
    const fixturePath: string = fileURLToPath(new URL("../../test-fixtures/sample-mcp-stdio.mjs", import.meta.url));
    const config: RunnerConfig = {
      ...createConfig(workspace.root),
      mcp_stdio_profiles: [
        {
          id: "sample-tools",
          command: process.execPath,
          args: [fixturePath],
          env: {},
          workspace_relative_cwd: ".",
          provider_instance_ids: ["mock-provider"],
          allowed_tools: ["echo", "secret_admin"],
          denied_tools: ["secret_admin"],
        },
      ],
    };
    const manager = new HarnessSessionManager(config);

    try {
      const events = await manager.startSession({
        session_id: "session-stdio",
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
            name: "sample",
            transport: "runner_stdio_profile",
            profile_id: "sample-tools",
            allowed_tools: ["echo", "secret_admin"],
          },
        ],
      });
      const discovery = events.find(
        (event): boolean =>
          event.event_type === "mcp.status.updated" && "status" in event.data && event.data.status === "tools_discovered",
      );
      assert.equal(discovery && "message" in discovery.data ? discovery.data.message : undefined, "allowed tools: echo");
      await manager.stopSession("session-stdio", "done");
    } finally {
      await workspace.cleanup();
    }
  });

  for (const waitingAt of ["connect", "start"] as const) {
  it(`stops a session after in-flight ${waitingAt} completes and cleans both resource owners`, async () => {
    const workspace = await createWorkspace();
    const calls: string[] = [];
    let reached!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { reached = resolve; });
    const continueStart = new Promise<void>(resolve => { release = resolve; });
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
        if (waitingAt === "start") { reached(); await continueStart; }
        return { adapter_session_id: input.payload.session_id };
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
            if (waitingAt === "connect") { reached(); await continueStart; }
          },
          async close(): Promise<void> {
            calls.push("close");
          },
        };
      },
    });

    try {
      const starting = manager.startSession({
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

      await waiting;
      const stopping = manager.stopSession("session-1", "cancel during startup");
      release();
      const [started, stopped] = await Promise.all([starting, stopping]);
      assert.equal(started.filter(event => event.event_type === "session.started").length, 1);
      assert.equal(stopped.filter(event => event.event_type === "session.exited").length, 1);
      assert.deepEqual(calls, ["validate", "connect", "start", "stop", "close"]);
      assert.equal(manager.activeSessionCount(), 0);
    } finally {
      release();
      await workspace.cleanup();
    }
  });
  }

  for (const failure of ["none", "client", "adapter", "both"] as const) {
  it(`records adapter-start cleanup only when both owners close (failure=${failure})`, async () => {
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
        if (failure === "adapter" || failure === "both") throw new Error("adapter stop failed");
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
            if (failure === "client" || failure === "both") throw new Error("mcp close failed");
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
        (error: unknown): boolean => failure === "none"
          ? error instanceof Error && error.message === "adapter start failed"
          : error instanceof HarnessSessionError &&
            error.code === "adapter_start_cleanup_failed" &&
            error.message.includes("adapter start failed") &&
            (failure === "adapter" || error.message.includes("mcp close failed")) &&
            (failure === "client" || error.message.includes("adapter stop failed")),
      );

      assert.deepEqual(calls, ["validate", "connect", "start", "close", "stop"]);
      const replay = manager.replayEventsAfter({sessions: [{session_id: "session-1", last_event_sequence: 0}]});
      assert.deepEqual(replay.events.map(event => event.event_type), failure === "none" ? ["session.exited"] : []);
      if (failure === "none") {
        assert.deepEqual(replay.events[0]?.data, {
          provider_instance_id: "mock-provider", reason: "adapter_start_failed",
        });
        assert.deepEqual(await manager.stopSession("session-1", "cleanup"), []);
      }
    } finally {
      await workspace.cleanup();
    }
  });
  }

  it("binds Codex MCP clients without requiring a loopback proxy", async () => {
    const workspace = await createWorkspace();
    const connected: string[] = [];
    const manager = new HarnessSessionManager(createCodexConfig(workspace.root), {
      mcpClientFactory(request) {
        return {
          async listTools() { return [{name: "echo", input_schema: {type: "object"}}]; },
          async callTool() { return {is_error: false}; },
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
        approval_policy: "full_access",
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
        ["session.started", "workspace.preflight.completed", "session.configured", "mcp.status.updated", "mcp.status.updated"],
      );
      await manager.stopSession("session-1", "done");
    } finally {
      await workspace.cleanup();
    }
  });

  it("closes Codex MCP clients when an attachment factory cannot invoke tools", async () => {
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
            approval_policy: "full_access",
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
          error instanceof HarnessAdapterError && error.code === "mcp_bridge_missing",
      );
      assert.deepEqual(connected, ["tools"]);
      assert.deepEqual(closed, ["tools"]);
    } finally {
      await workspace.cleanup();
    }
  });

  it("proxies Claude MCP attachments before adapter start", async () => {
    const workspace = await createWorkspace();
    const connected: string[] = [];
    const manager = new HarnessSessionManager(createClaudeConfig(workspace.root), {
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
        provider_instance_id: "claude-local",
        driver_kind: "claude",
        cwd: workspace.root,
        sandbox_mode: "danger_full_access",
        approval_policy: "full_access",
        continue_session: false,
        model_selection: { model: "sonnet" },
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
        replayed.events.map((event) => event.event_type),
        ["turn.started", "turn.completed"],
      );

      const unavailable = manager.replayEventsAfter({
        sessions: [{ session_id: "session-1", last_event_sequence: 0 }],
      });
      assert.equal(unavailable.events.length, 0);
      assert.equal(unavailable.unavailable[0]?.reason, "cursor_outside_retention");
      assert.deepEqual(unavailable.unavailable[0]?.retained_range, {
        first_event_sequence: 2,
        last_event_sequence: 5,
      });
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

it("recovered approval remains waiting after preparation failure and serializes competing resumes", async () => {
  const workspace = await createWorkspace();
  const path = join(workspace.root, "approval-state.json");
  const store = new JsonRunnerStateStore(path);
  const start: HcpSessionStartPayload = {session_id: "review-session", workspace_id: "repo", provider_instance_id: "codex-local",
    driver_kind: "codex", cwd: workspace.project, sandbox_mode: "read_only", approval_policy: "full_access",
    continue_session: false, model_selection: {model: "gpt-test"}, mcp_servers: [{name: "tools", transport: "streamable_http",
      url: "https://example.com/mcp", lease_id: "lease", expires_at: new Date(Date.now() + 60000).toISOString(),
      headers: {}, proof_of_possession: {scheme: "runner_signed_request", key_id: "key", required_headers: ["x-hcp-proof-signature"]}}]};
  const owner = new HarnessMcpReview(store, start, {session_id: start.session_id, turn_id: "turn", input: "Read"}, () => {});
  const controller = new AbortController();
  const waiting = owner.request({attachment_name: "tools", tool_name: "lookup", arguments: {},
    native_thread_id: "thread", native_turn_id: "native-turn", native_call_id: "call"}, controller.signal);
  controller.abort();
  await assert.rejects(waiting, /interrupted/);
  const retained = store.getMcpReview(start.session_id)!;
  const response = {session_id: start.session_id, turn_id: "turn", request_id: retained.request_id,
    action_hash: retained.action_hash, actor_id: "actor", decision: "accept" as const};
  let attempts = 0;
  let calls = 0;
  let notifyConnecting!: () => void;
  let releaseConnection!: () => void;
  const connecting = new Promise<void>(resolve => {notifyConnecting = resolve;});
  const connected = new Promise<void>(resolve => {releaseConnection = resolve;});
  const adapter: HarnessAdapter = {
    driverKind: "codex", durableMcpContinuation: true,
    async probe() {return {provider_instance_id: "codex-local", driver_kind: "codex", installed: true, available: true, status: "ready", models: []};},
    async validateStart() {}, async startSession(input) {return {adapter_session_id: input.payload.session_id};},
    async sendTurn(input) {
      assert.equal(input.mcpContinuation?.request_id, retained.request_id);
      assert.deepEqual(input.mcpContinuation?.outcome, {kind: "completed", result: {is_error: false, content: []}});
      return [{event_type: "turn.completed", data: {status: "completed", final_output: {final_text: "done"}}}];
    },
    async cancelTurn() {return [];}, async stopSession() {return [];},
  };
  const manager = new HarnessSessionManager(createCodexConfig(workspace.root), {
    stateStore: store, adapterRegistry: new HarnessAdapterRegistry([adapter]),
    mcpClientFactory: () => ({
      async connect() {
        attempts++;
        if (attempts === 1) throw new Error("connection unavailable");
        notifyConnecting();
        await connected;
      },
      async close() {}, async listTools() {return [{name: "lookup", input_schema: {type: "object"}}];},
      async callTool(name, args, grant) {
        calls++;
        assert.equal(name, "lookup"); assert.deepEqual(args, {});
        assert.deepEqual(grant, {request_id: retained.request_id, action_json: retained.action_json});
        assert.equal(new JsonRunnerStateStore(path).getMcpReview(start.session_id)?.outcome.phase, "dispatching");
        return {is_error: false, content: []};
      },
    }),
  });
  const events: HcpHarnessEventPayload[] = [];
  try {
    await assert.rejects(manager.respondToMcpReview({...response, action_hash: "wrong"}, () => {}), /does not match/);
    assert.equal(attempts, 0);
    await assert.rejects(manager.respondToMcpReview(response, () => {}), /connection unavailable/);
    assert.equal(new JsonRunnerStateStore(path).getMcpReview(start.session_id)?.outcome.phase, "waiting");
    assert.equal(calls, 0);
    const resuming = manager.respondToMcpReview(response, event => events.push(event));
    await connecting;
    await assert.rejects(manager.respondToMcpReview(response, () => {}), /already resuming/);
    assert.equal(attempts, 2);
    assert.equal(store.getMcpReview(start.session_id)?.outcome.phase, "waiting");
    releaseConnection();
    const resumed = await resuming;
    assert.equal(resumed.kind, "resumed");
    if (resumed.kind === "resumed") await resumed.completion;
    assert.equal(calls, 1);
    assert.equal(events.filter(event => event.event_type === "approval.resolved").length, 1);
    assert.equal(events.filter(event => event.event_type === "turn.completed").length, 1);
    assert.equal(new JsonRunnerStateStore(path).getMcpReview(start.session_id), undefined);
  } finally {
    releaseConnection();
    await manager.stopSession(start.session_id, "test complete");
    await workspace.cleanup();
  }
});
