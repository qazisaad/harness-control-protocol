import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";

import type { LocalCapabilityLease } from "@hcp-runner/protocol";

import type { RunnerConfig } from "../config/index.js";
import { LocalCapabilityEngine, LocalCapabilityLeaseManager } from "./index.js";
import { LocalCapabilityExecutionError, LocalCapabilityExecutor, type LocalCapabilityExecutionContext } from "./executors.js";

const execFileAsync = promisify(execFile);

function config(): RunnerConfig {
  return {
    runner_id: "runner-1",
    host_id: "host-1",
    control_plane_url: "ws://127.0.0.1:8787",
    workspaces: [],
    local_capabilities: [
      { id: "filesystem", status: "available", scopes: ["workspace_read", "workspace_write"], approval_required: false },
      { id: "git", status: "available", scopes: ["workspace_read", "workspace_write"], approval_required: false },
      { id: "shell", status: "available", scopes: ["workspace"], approval_required: true },
      { id: "dev_server", status: "available", scopes: ["workspace"], approval_required: true },
    ],
    provider_instances: [],
  };
}

function lease(overrides: Partial<LocalCapabilityLease> = {}): LocalCapabilityLease {
  return {
    lease_id: "local_lease_123",
    org_id: "org_123",
    workflow_id: "workflow_123",
    run_id: "run_123",
    node_id: "node_123",
    hcp_session_id: "session-1",
    execution_host_id: "host-1",
    provider_instance_id: "provider-1",
    workspace_id: "workspace-1",
    issued_at: "2026-01-01T00:00:00.000Z",
    expires_at: "2999-01-01T00:00:00.000Z",
    policy_version: "policy_1",
    capabilities: [
      { id: "filesystem", scopes: ["workspace_read", "workspace_write"] },
      { id: "git", scopes: ["workspace_read", "workspace_write"] },
      {
        id: "shell",
        scopes: ["workspace"],
        approval_policy: "full_access",
        command_policy: {
          allowed_executables: [process.execPath],
          denied_executables: [],
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
          denied_executables: [],
          argv_patterns: ["^-e "],
          cwd_policy: "selected_workspace_only",
          env_policy: "minimal",
          allow_shell: false,
          timeout_seconds: 5,
          network_policy: "inherit",
        },
      },
    ],
    ...overrides,
  };
}

async function createWorkspace(): Promise<{ root: string; cleanup(): Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "hcp-local-executor-"));
  return {
    root,
    cleanup: async (): Promise<void> => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

function executor(): LocalCapabilityExecutor {
  return new LocalCapabilityExecutor(new LocalCapabilityEngine(new LocalCapabilityLeaseManager(config(), "host-1")));
}

function context(workspaceRoot: string, leasePayload: LocalCapabilityLease = lease()): LocalCapabilityExecutionContext {
  return {
    session_id: "session-1",
    turn_id: "turn-1",
    workspace_id: "workspace-1",
    provider_instance_id: "provider-1",
    workspace_root: workspaceRoot,
    sandbox_mode: "workspace_write",
    lease: leasePayload,
  };
}

describe("LocalCapabilityExecutor", () => {
  it("executes filesystem reads and writes inside the selected workspace", async () => {
    const workspace = await createWorkspace();
    const localExecutor = executor();

    try {
      const writeResult = await localExecutor.writeFile(context(workspace.root), "notes/output.txt", "hello");
      const readResult = await localExecutor.readFile(context(workspace.root), "notes/output.txt");

      assert.equal(await readFile(join(workspace.root, "notes", "output.txt"), "utf8"), "hello");
      assert.equal(writeResult.result.path, "notes/output.txt");
      assert.equal(readResult.result.content, "hello");
      assert.deepEqual(
        writeResult.events.map((event) => event.event_type),
        ["local_capability.action.started", "local_capability.action.completed"],
      );
    } finally {
      await workspace.cleanup();
    }
  });

  it("rejects symlink escapes and read-only writes with failed action events", async () => {
    const workspace = await createWorkspace();
    const outside = await createWorkspace();
    const localExecutor = executor();
    await writeFile(join(outside.root, "secret.txt"), "secret");
    await symlink(join(outside.root, "secret.txt"), join(workspace.root, "secret-link"));

    try {
      await assert.rejects(
        () => localExecutor.readFile(context(workspace.root), "secret-link"),
        (error: unknown): boolean =>
          error instanceof LocalCapabilityExecutionError &&
          error.events.at(-1)?.event_type === "local_capability.action.failed",
      );

      await assert.rejects(
        () =>
          localExecutor.writeFile(
            {
              ...context(workspace.root),
              sandbox_mode: "read_only",
            },
            "denied.txt",
            "nope",
          ),
        LocalCapabilityExecutionError,
      );
    } finally {
      await workspace.cleanup();
      await outside.cleanup();
    }
  });

  it("executes git read operations inside the workspace", async () => {
    const workspace = await createWorkspace();
    const localExecutor = executor();

    try {
      await execFileAsync("git", ["init"], { cwd: workspace.root });
      await writeFile(join(workspace.root, "tracked.txt"), "tracked");
      const result = await localExecutor.git(context(workspace.root), "status");

      assert.equal(result.result.operation, "status");
      assert.match(result.result.stdout, /\?\? tracked\.txt/);
      assert.equal(result.result.exit_code, 0);
    } finally {
      await workspace.cleanup();
    }
  });

  it("executes allowed shell commands and rejects denied argv", async () => {
    const workspace = await createWorkspace();
    const localExecutor = executor();

    try {
      const result = await localExecutor.shell(context(workspace.root), {
        executable: process.execPath,
        argv: ["-e", "console.log('ok')"],
        timeout_seconds: 5,
      });
      assert.equal(result.result.exit_code, 0);
      assert.equal(result.result.stdout.trim(), "ok");

      await assert.rejects(
        () =>
          localExecutor.shell(context(workspace.root), {
            executable: process.execPath,
            argv: ["--version"],
            timeout_seconds: 5,
          }),
        LocalCapabilityExecutionError,
      );
    } finally {
      await workspace.cleanup();
    }
  });

  it("starts and stops session-owned dev servers", async () => {
    const workspace = await createWorkspace();
    const localExecutor = executor();

    try {
      const started = await localExecutor.startDevServer(context(workspace.root), {
        server_id: "dev-1",
        executable: process.execPath,
        argv: ["-e", "setInterval(() => undefined, 1000)"],
        timeout_seconds: 5,
        host: "127.0.0.1",
        port: 43210,
      });
      assert.equal(started.result.server_id, "dev-1");
      assert.equal(localExecutor.listDevServers().length, 1);

      const stopped = await localExecutor.stopDevServer(context(workspace.root), "dev-1");
      assert.equal(stopped.result.server_id, "dev-1");
      assert.equal(localExecutor.listDevServers().length, 0);
    } finally {
      for (const server of localExecutor.listDevServers()) {
        await localExecutor.stopDevServer(context(workspace.root), server.server_id);
      }
      await workspace.cleanup();
    }
  });
});
