import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HarnessSessionError, HarnessSessionManager } from "./index.js";
import type { RunnerConfig } from "../config/index.js";

const config: RunnerConfig = {
  runner_id: "runner-test",
  control_plane_url: "ws://127.0.0.1:8787",
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

describe("HarnessSessionManager", () => {
  it("starts sessions and accepts turns with HCP events", () => {
    const manager = new HarnessSessionManager(config);

    const sessionEvents = manager.startSession({
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
    });
    const turnEvents = manager.sendTurn({
      session_id: "session-1",
      turn_id: "turn-1",
      input: "hello",
    });

    assert.deepEqual(
      sessionEvents.map((event) => event.event_type),
      ["session.started", "session.configured"],
    );
    assert.deepEqual(
      turnEvents.map((event) => event.event_type),
      ["turn.started", "turn.completed"],
    );
    assert.equal(turnEvents[0]?.sequence, 2);
  });

  it("rejects unknown providers and disallowed workspaces", () => {
    const manager = new HarnessSessionManager(config);

    assert.throws(
      () =>
        manager.startSession({
          session_id: "session-1",
          provider_instance_id: "missing",
          driver_kind: "mock",
          cwd: "/tmp/repo",
          runtime_mode: "approval_required",
          sandbox_mode: "workspace_write",
          approval_policy: "ask",
          continue_session: false,
          model_selection: { model: "mock-model" },
          mcp_servers: [],
        }),
      HarnessSessionError,
    );

    assert.throws(
      () =>
        manager.startSession({
          session_id: "session-2",
          provider_instance_id: "mock-provider",
          driver_kind: "mock",
          cwd: "/tmp/other",
          runtime_mode: "approval_required",
          sandbox_mode: "workspace_write",
          approval_policy: "ask",
          continue_session: false,
          model_selection: { model: "mock-model" },
          mcp_servers: [],
        }),
      /not allowed/,
    );
  });
});
