import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";

import {
  parseLocalActionErrorPayload,
  parseLocalActionResponsePayload,
  type HcpSessionStartPayload,
  type LocalActionLeaseBinding,
  type LocalActionRequestPayload,
  type LocalActionResponsePayload,
  type LocalCapabilityLease,
} from "@harness-control/protocol";

import type { RunnerConfig } from "../config/index.js";
import { HarnessSessionManager } from "../harnesses/index.js";
import { LocalActionDispatcher, type LocalActionDispatchOutcome } from "./dispatcher.js";
import { LocalCapabilityExecutor } from "./executors.js";

const execFileAsync = promisify(execFile);

type TestWorkspace = {
  root: string;
  project: string;
  cleanup(): Promise<void>;
};

function config(workspaceRoot: string): RunnerConfig {
  return {
    runner_id: "runner-1",
    host_id: "host-1",
    control_plane_url: "ws://127.0.0.1:8787",
    workspaces: [{ id: "workspace-1", path: workspaceRoot }],
    local_capabilities: [
      { id: "filesystem", status: "available", scopes: ["workspace_read", "workspace_write"], approval_required: false },
      { id: "git", status: "available", scopes: ["workspace_read"], approval_required: false },
      { id: "shell", status: "available", scopes: ["workspace"], approval_required: true },
      { id: "dev_server", status: "available", scopes: ["workspace"], approval_required: true },
    ],
    provider_instances: [
      {
        id: "provider-1",
        driver_kind: "mock",
        enabled: true,
        launch_args: [],
        env: {},
        models: [],
        hidden_models: [],
        model_order: [],
        favorite_models: [],
        local_capabilities: ["filesystem", "git", "shell", "dev_server"],
      },
    ],
  };
}

function lease(): LocalCapabilityLease {
  return {
    lease_id: "lease-1",
    org_id: "org-1",
    workflow_id: "workflow-1",
    run_id: "run-1",
    node_id: "node-1",
    hcp_session_id: "session-1",
    execution_host_id: "host-1",
    provider_instance_id: "provider-1",
    workspace_id: "workspace-1",
    issued_at: "2026-01-01T00:00:00.000Z",
    expires_at: "2999-01-01T00:00:00.000Z",
    policy_version: "policy-1",
    capabilities: [
      { id: "filesystem", scopes: ["workspace_read", "workspace_write"] },
      { id: "git", scopes: ["workspace_read"] },
      {
        id: "shell",
        scopes: ["workspace"],
        approval_policy: "full_access",
        command_policy: {
          allowed_executables: [process.execPath],
          argv_patterns: ["^-e "],
          cwd_policy: "selected_workspace_only",
          env_policy: "minimal",
          allow_shell: false,
          timeout_seconds: 5,
          network_policy: "inherit",
        },
      },
      {
        id: "dev_server",
        scopes: ["workspace"],
        approval_policy: "full_access",
        command_policy: {
          allowed_executables: [process.execPath],
          argv_patterns: ["^-e "],
          cwd_policy: "selected_workspace_only",
          env_policy: "minimal",
          allow_shell: false,
          timeout_seconds: 5,
          network_policy: "inherit",
        },
      },
    ],
  };
}

async function createWorkspace(): Promise<TestWorkspace> {
  const root: string = await mkdtemp(join(tmpdir(), "hcp-local-dispatcher-"));
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

async function createStartedDispatcher(workspace: TestWorkspace): Promise<{
  manager: HarnessSessionManager;
  dispatcher: LocalActionDispatcher;
}> {
  const manager = new HarnessSessionManager(config(workspace.root));
  await manager.startSession(sessionStartPayload(workspace, lease()));
  const dispatcher = new LocalActionDispatcher({
    executor: new LocalCapabilityExecutor(manager.localCapabilityEngine()),
    resolveContext: (request: LocalActionRequestPayload) => manager.resolveLocalActionContext(request),
    emitEvents: (sessionId, turnId, events) => manager.recordLocalActionEvents(sessionId, turnId, events),
  });
  return { manager, dispatcher };
}

function sessionStartPayload(workspace: TestWorkspace, localLease: LocalCapabilityLease): HcpSessionStartPayload {
  return {
    session_id: "session-1",
    workspace_id: "workspace-1",
    provider_instance_id: "provider-1",
    driver_kind: "mock",
    cwd: workspace.project,
    sandbox_mode: "workspace_write",
    approval_policy: "ask",
    continue_session: false,
    model_selection: { model: "mock" },
    local_capability_lease: localLease,
    mcp_servers: [],
  };
}

function leaseBinding(capabilityId: "filesystem" | "git" | "shell" | "dev_server", scope: string): LocalActionLeaseBinding {
  return {
    lease_id: "lease-1",
    capability_id: capabilityId,
    scope,
    run_id: "run-1",
    hcp_session_id: "session-1",
    execution_host_id: "host-1",
    provider_instance_id: "provider-1",
    workspace_id: "workspace-1",
    expires_at: "2999-01-01T00:00:00.000Z",
  };
}

function requestBase(workspace: TestWorkspace) {
  return {
    issued_at: "2026-01-01T00:00:00.000Z",
    attribution: {
      session_id: "session-1",
      turn_id: "turn-1",
      workspace_id: "workspace-1",
      provider_instance_id: "provider-1",
      run_id: "run-1",
    },
    sandbox: {
      mode: "workspace_write" as const,
      workspace_root: workspace.root,
      cwd: workspace.project,
      requires_workspace_containment: true,
    },
    cancellation: { cancellable: false },
    audit: {
      started_event_type: "local_capability.action.started" as const,
      completed_event_type: "local_capability.action.completed" as const,
      failed_event_type: "local_capability.action.failed" as const,
    },
  };
}

function approvedRequestBase(workspace: TestWorkspace) {
  return {
    ...requestBase(workspace),
    approval: {
      status: "approved" as const,
      request_id: "approval-1",
      action_hash: "sha256:test",
      decision: "accept" as const,
      actor_id: "user-1",
      approved_at: "2026-01-01T00:00:01.000Z",
    },
  };
}

function sha256(content: string): string {
  return `sha256:${createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex")}`;
}

async function expectResponse<TAction extends LocalActionResponsePayload["action"]>(
  outcome: LocalActionDispatchOutcome,
  action: TAction,
): Promise<Extract<LocalActionResponsePayload, { action: TAction }>> {
  if (outcome.type === "error") {
    throw new Error(outcome.payload.error.message);
  }
  const payload: LocalActionResponsePayload = parseLocalActionResponsePayload(outcome.payload);
  assert.equal(payload.action, action);
  if (payload.action !== action) {
    throw new Error(`Expected ${action} response but received ${payload.action}.`);
  }
  return payload as Extract<LocalActionResponsePayload, { action: TAction }>;
}

describe("LocalActionDispatcher", () => {
  it("dispatches filesystem read, write, and patch actions with protocol outputs", async () => {
    const workspace = await createWorkspace();
    const { dispatcher } = await createStartedDispatcher(workspace);
    const filePath = join(workspace.project, "README.md");
    await writeFile(filePath, "old\n", "utf8");

    try {
      const readRequest: LocalActionRequestPayload = {
        ...requestBase(workspace),
        request_id: "read-1",
        action: "local.filesystem.read",
        lease: leaseBinding("filesystem", "workspace_read"),
        approval: { status: "not_required" },
        output_limits: { content_bytes: 3 },
        input: { path: "project/README.md", encoding: "utf8" },
      };
      const readResponse = await expectResponse(await dispatcher.dispatch(readRequest), "local.filesystem.read");
      assert.equal(readResponse.output.content, "old");
      assert.equal(readResponse.output.hash, sha256("old\n"));
      assert.equal(readResponse.output.truncated, true);
      assert.equal(readResponse.audit_events.completed.event_type, "local_capability.action.completed");

      const writeRequest: LocalActionRequestPayload = {
        ...requestBase(workspace),
        request_id: "write-1",
        action: "local.filesystem.write",
        lease: leaseBinding("filesystem", "workspace_write"),
        approval: { status: "not_required" },
        output_limits: {},
        input: {
          path: "project/README.md",
          content: "new\n",
          encoding: "utf8",
          mode: "overwrite",
          create_parents: false,
          expected_base_hash: sha256("old\n"),
        },
      };
      const writeResponse = await expectResponse(await dispatcher.dispatch(writeRequest), "local.filesystem.write");
      assert.equal(writeResponse.output.new_hash, sha256("new\n"));

      const patchRequest: LocalActionRequestPayload = {
        ...requestBase(workspace),
        request_id: "patch-1",
        action: "local.filesystem.patch",
        lease: leaseBinding("filesystem", "workspace_write"),
        approval: { status: "not_required" },
        output_limits: {},
        input: {
          path: "project/README.md",
          expected_base_hash: sha256("new\n"),
          patch: {
            format: "unified_diff",
            content: "--- a/project/README.md\n+++ b/project/README.md\n@@ -1 +1 @@\n-new\n+next\n",
          },
        },
      };
      const patchResponse = await expectResponse(await dispatcher.dispatch(patchRequest), "local.filesystem.patch");
      assert.equal(patchResponse.output.changed, true);
      assert.equal(patchResponse.output.new_hash, sha256("next\n"));
      assert.equal(await readFile(filePath, "utf8"), "next\n");
    } finally {
      await dispatcher.stopDevServersForSession("session-1");
      await workspace.cleanup();
    }
  });

  it("dispatches Git, shell, and dev-server actions through the active lease", async () => {
    const workspace = await createWorkspace();
    const { dispatcher } = await createStartedDispatcher(workspace);

    try {
      await execFileAsync("git", ["init"], { cwd: workspace.root });
      await writeFile(join(workspace.project, "tracked.txt"), "changed", "utf8");
      const statusRequest: LocalActionRequestPayload = {
        ...requestBase(workspace),
        request_id: "status-1",
        action: "local.git.status",
        lease: leaseBinding("git", "workspace_read"),
        approval: { status: "not_required" },
        output_limits: { status_bytes: 65_536 },
        input: { porcelain_version: "v1", include_branch: true },
      };
      const statusResponse = await expectResponse(await dispatcher.dispatch(statusRequest), "local.git.status");
      assert.match(statusResponse.output.porcelain, /\?\? project\//);

      const shellRequest: LocalActionRequestPayload = {
        ...approvedRequestBase(workspace),
        request_id: "shell-1",
        action: "local.shell.exec",
        lease: leaseBinding("shell", "workspace"),
        output_limits: { stdout_bytes: 3, stderr_bytes: 65_536 },
        cancellation: { cancellable: true, timeout_ms: 5000 },
        input: {
          executable: process.execPath,
          argv: ["-e", "process.stdin.pipe(process.stdout)"],
          cwd: workspace.project,
          use_shell: false,
          stdin: "abcdef",
        },
      };
      const shellResponse = await expectResponse(await dispatcher.dispatch(shellRequest), "local.shell.exec");
      assert.equal(shellResponse.output.stdout, "abc");
      assert.equal(shellResponse.output.stdout_truncated, true);

      const devStartRequest: LocalActionRequestPayload = {
        ...approvedRequestBase(workspace),
        request_id: "dev-start-1",
        action: "local.dev_server.start",
        lease: leaseBinding("dev_server", "workspace"),
        output_limits: {},
        cancellation: { cancellable: true, timeout_ms: 5000 },
        input: {
          server_id: "dev-1",
          executable: process.execPath,
          argv: ["-e", "setInterval(() => undefined, 1000)"],
          cwd: workspace.project,
          host: "127.0.0.1",
          port: 43211,
          use_shell: false,
        },
      };
      const devStartResponse = await expectResponse(await dispatcher.dispatch(devStartRequest), "local.dev_server.start");
      assert.equal(devStartResponse.output.server_id, "dev-1");
      assert.equal(devStartResponse.output.url, "http://127.0.0.1:43211");

      const devStopRequest: LocalActionRequestPayload = {
        ...requestBase(workspace),
        request_id: "dev-stop-1",
        action: "local.dev_server.stop",
        lease: leaseBinding("dev_server", "workspace"),
        approval: { status: "not_required" },
        output_limits: {},
        cancellation: { cancellable: true, timeout_ms: 5000 },
        input: { server_id: "dev-1", signal: "SIGTERM" },
      };
      const devStopResponse = await expectResponse(await dispatcher.dispatch(devStopRequest), "local.dev_server.stop");
      assert.equal(devStopResponse.output.server_id, "dev-1");
    } finally {
      await dispatcher.stopDevServersForSession("session-1");
      await workspace.cleanup();
    }
  });

  it("returns protocol-valid local action errors with failed audit references", async () => {
    const workspace = await createWorkspace();
    const { dispatcher } = await createStartedDispatcher(workspace);
    const filePath = join(workspace.project, "README.md");
    await writeFile(filePath, "old\n", "utf8");

    try {
      const request: LocalActionRequestPayload = {
        ...requestBase(workspace),
        request_id: "write-bad-hash",
        action: "local.filesystem.write",
        lease: leaseBinding("filesystem", "workspace_write"),
        approval: { status: "not_required" },
        output_limits: {},
        input: {
          path: "project/README.md",
          content: "new\n",
          encoding: "utf8",
          mode: "overwrite",
          create_parents: false,
          expected_base_hash: "sha256:bad",
        },
      };
      const outcome = await dispatcher.dispatch(request);
      assert.equal(outcome.type, "error");
      if (outcome.type !== "error") {
        throw new Error("Expected local action error.");
      }
      const errorPayload = parseLocalActionErrorPayload(outcome.payload);
      assert.equal(errorPayload.error.code, "local_capability_expected_hash_mismatch");
      assert.equal(errorPayload.audit_events.failed.event_type, "local_capability.action.failed");
      assert.ok(errorPayload.audit_events.failed.sequence);
      assert.equal(await readFile(filePath, "utf8"), "old\n");
    } finally {
      await dispatcher.stopDevServersForSession("session-1");
      await workspace.cleanup();
    }
  });

  it("rejects unsafe Git diff base refs before spawning git", async () => {
    const workspace = await createWorkspace();
    const { dispatcher } = await createStartedDispatcher(workspace);

    try {
      await execFileAsync("git", ["init"], { cwd: workspace.root });
      const request: LocalActionRequestPayload = {
        ...requestBase(workspace),
        request_id: "diff-unsafe-base",
        action: "local.git.diff",
        lease: leaseBinding("git", "workspace_read"),
        approval: { status: "not_required" },
        output_limits: { diff_bytes: 65_536 },
        input: {
          base_ref: "--output=/tmp/hcp-runner-unsafe-diff",
        },
      };
      const outcome = await dispatcher.dispatch(request);
      assert.equal(outcome.type, "error");
      if (outcome.type !== "error") {
        throw new Error("Expected local action error.");
      }
      const errorPayload = parseLocalActionErrorPayload(outcome.payload);
      assert.equal(errorPayload.error.code, "local_capability_command_denied");
    } finally {
      await dispatcher.stopDevServersForSession("session-1");
      await workspace.cleanup();
    }
  });
});
