import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { LocalCapabilityLease } from "@hcp-runner/protocol";

import type { RunnerConfig } from "../config/index.js";
import {
  LocalCapabilityEngine,
  LocalCapabilityLeaseManager,
  LocalCapabilityPolicyError,
} from "./index.js";

const lease: LocalCapabilityLease = {
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
      command_policy: {
        allowed_executables: ["npm"],
        denied_executables: ["rm"],
        argv_patterns: ["^test"],
        cwd_policy: "selected_workspace_only",
        env_policy: "minimal",
        allow_shell: false,
        timeout_seconds: 30,
        network_policy: "inherit",
      },
    },
    { id: "dev_server", scopes: ["workspace"] },
  ],
};

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

async function createWorkspace(): Promise<{ root: string; child: string; cleanup(): Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "hcp-local-actions-"));
  const child = join(root, "child");
  await mkdir(child);
  return {
    root,
    child,
    cleanup: async (): Promise<void> => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe("LocalCapabilityEngine", () => {
  it("maps filesystem and git actions to leased scopes", () => {
    const engine = new LocalCapabilityEngine(new LocalCapabilityLeaseManager(config(), "host-1"));

    assert.equal(
      engine.authorizeFilesystemAction(lease, {
        session_id: "session-1",
        turn_id: "turn-1",
        workspace_id: "workspace-1",
        provider_instance_id: "provider-1",
        action: "read",
      }).id,
      "filesystem",
    );
    assert.equal(
      engine.authorizeGitAction(lease, {
        session_id: "session-1",
        turn_id: "turn-1",
        workspace_id: "workspace-1",
        provider_instance_id: "provider-1",
        action: "commit",
      }).id,
      "git",
    );
  });

  it("enforces structured shell command policy and workspace cwd", async () => {
    const workspace = await createWorkspace();
    const outside = await createWorkspace();
    const engine = new LocalCapabilityEngine(new LocalCapabilityLeaseManager(config(), "host-1"));

    try {
      const grant = await engine.authorizeShellCommand(lease, {
        session_id: "session-1",
        turn_id: "turn-1",
        workspace_id: "workspace-1",
        provider_instance_id: "provider-1",
        executable: "npm",
        argv: ["test"],
        cwd: workspace.child,
        workspace_root: workspace.root,
        use_shell: false,
        timeout_seconds: 20,
      });
      assert.equal(grant.id, "shell");

      await assert.rejects(
        () =>
          engine.authorizeShellCommand(lease, {
            session_id: "session-1",
            turn_id: "turn-1",
            workspace_id: "workspace-1",
            provider_instance_id: "provider-1",
            executable: "rm",
            argv: ["-rf", "."],
            cwd: workspace.child,
            workspace_root: workspace.root,
            use_shell: false,
            timeout_seconds: 20,
          }),
        LocalCapabilityPolicyError,
      );

      await assert.rejects(
        () =>
          engine.authorizeShellCommand(lease, {
            session_id: "session-1",
            turn_id: "turn-1",
            workspace_id: "workspace-1",
            provider_instance_id: "provider-1",
            executable: "npm",
            argv: ["test"],
            cwd: outside.root,
            workspace_root: workspace.root,
            use_shell: false,
            timeout_seconds: 20,
          }),
        /outside the selected workspace/,
      );
    } finally {
      await workspace.cleanup();
      await outside.cleanup();
    }
  });

  it("authorizes dev server actions through the dev_server capability", () => {
    const engine = new LocalCapabilityEngine(new LocalCapabilityLeaseManager(config(), "host-1"));

    assert.equal(
      engine.authorizeDevServerAction(lease, {
        session_id: "session-1",
        turn_id: "turn-1",
        workspace_id: "workspace-1",
        provider_instance_id: "provider-1",
        action: "inspect",
      }).id,
      "dev_server",
    );
  });
});
