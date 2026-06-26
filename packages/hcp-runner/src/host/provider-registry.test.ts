import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RunnerConfig } from "../config/index.js";
import { ProviderInstanceRegistry } from "./provider-registry.js";

const config: RunnerConfig = {
  runner_id: "runner-local",
  control_plane_url: "ws://localhost:8787/hcp",
  workspaces: [{ id: "workspace-main", path: "/tmp/workspace" }],
  local_capabilities: [
    { id: "filesystem", status: "available", scopes: ["workspace_read", "workspace_write"], approval_required: false },
    { id: "git", status: "available", scopes: ["workspace_read"], approval_required: false },
    { id: "shell", status: "available", scopes: ["workspace"], approval_required: true },
  ],
  provider_instances: [
    {
      id: "provider-ready",
      driver_kind: "example-driver",
      enabled: true,
      launch_args: [],
      env: {},
      models: [],
      hidden_models: [],
      model_order: [],
      favorite_models: [],
      local_capabilities: ["filesystem", "git", "shell"],
    },
    {
      id: "provider-unknown",
      driver_kind: "unknown-driver",
      enabled: true,
      launch_args: [],
      env: {},
      models: [],
      hidden_models: [],
      model_order: [],
      favorite_models: [],
      local_capabilities: ["filesystem"],
    },
    {
      id: "provider-disabled",
      driver_kind: "example-driver",
      enabled: false,
      launch_args: [],
      env: {},
      models: [],
      hidden_models: [],
      model_order: [],
      favorite_models: [],
      local_capabilities: ["filesystem"],
    },
  ],
};

describe("ProviderInstanceRegistry", () => {
  it("publishes typed snapshots for ready, unknown, and disabled providers", () => {
    const registry = ProviderInstanceRegistry.fromConfig(config, [
      {
        driver_kind: "example-driver",
        installed: true,
        available: true,
        version: "1.2.3",
        models: [{ id: "default", label: "Default", capabilities: { option_descriptors: [] } }],
      },
    ]);

    const snapshot = registry.snapshot(new Date("2026-01-01T00:00:00.000Z"));

    assert.equal(snapshot.providers[0]?.status, "ready");
    assert.equal(snapshot.providers[0]?.availability, "available");
    assert.equal(snapshot.providers[0]?.version, "1.2.3");
    assert.equal(snapshot.providers[0]?.models[0]?.id, "default");
    assert.deepEqual(snapshot.providers[0]?.local_capabilities, ["filesystem", "git", "shell"]);
    assert.equal(snapshot.providers[1]?.status, "unavailable");
    assert.match(snapshot.providers[1]?.message ?? "", /Unsupported provider driver/);
    assert.equal(snapshot.providers[2]?.status, "disabled");
    assert.equal(snapshot.local_capabilities[0]?.id, "filesystem");
    assert.deepEqual(snapshot.workspaces, [{ id: "workspace-main", path: "/tmp/workspace" }]);
  });

  it("marks registered but unavailable drivers as unavailable", () => {
    const registry = ProviderInstanceRegistry.fromConfig(config, [
      {
        driver_kind: "example-driver",
        installed: true,
        available: false,
        version: "1.2.3",
        message: "Executable is not available.",
        models: [],
      },
    ]);

    const snapshot = registry.snapshot(new Date("2026-01-01T00:00:00.000Z"));

    assert.equal(snapshot.providers[0]?.status, "unavailable");
    assert.equal(snapshot.providers[0]?.installed, true);
    assert.equal(snapshot.providers[0]?.message, "Executable is not available.");
  });

  it("keeps probe status separate for provider instances with the same driver", () => {
    const sameDriverConfig: RunnerConfig = {
      ...config,
      provider_instances: [
        {
          id: "provider-work",
          driver_kind: "example-driver",
          enabled: true,
          launch_args: [],
          env: {},
          models: [],
          hidden_models: [],
          model_order: [],
          favorite_models: [],
          local_capabilities: ["filesystem"],
        },
        {
          id: "provider-personal",
          driver_kind: "example-driver",
          enabled: true,
          launch_args: [],
          env: {},
          models: [],
          hidden_models: [],
          model_order: [],
          favorite_models: [],
          local_capabilities: ["filesystem"],
        },
      ],
    };
    const registry = ProviderInstanceRegistry.fromConfig(sameDriverConfig, [
      {
        provider_instance_id: "provider-work",
        driver_kind: "example-driver",
        installed: true,
        available: true,
        version: "1.2.3",
        models: [],
      },
      {
        provider_instance_id: "provider-personal",
        driver_kind: "example-driver",
        installed: true,
        available: false,
        status: "unauthenticated",
        message: "Provider-specific login is missing.",
        models: [],
      },
    ]);

    const snapshot = registry.snapshot(new Date("2026-01-01T00:00:00.000Z"));

    assert.equal(snapshot.providers[0]?.status, "ready");
    assert.equal(snapshot.providers[0]?.availability, "available");
    assert.equal(snapshot.providers[1]?.status, "unauthenticated");
    assert.equal(snapshot.providers[1]?.message, "Provider-specific login is missing.");
  });

  it("computes placeholder continuation groups", () => {
    const registry = ProviderInstanceRegistry.fromConfig(config);

    assert.deepEqual(registry.computeContinuationGroups(), [
      {
        key: "driver:example-driver",
        driver_kind: "example-driver",
        provider_instance_ids: ["provider-ready", "provider-disabled"],
      },
      {
        key: "driver:unknown-driver",
        driver_kind: "unknown-driver",
        provider_instance_ids: ["provider-unknown"],
      },
    ]);
  });

  it("computes Codex continuation groups from runner-local home paths", () => {
    const registry = ProviderInstanceRegistry.fromConfig({
      ...config,
      provider_instances: [
        {
          id: "codex-work",
          driver_kind: "codex",
          enabled: true,
          home: "/tmp/codex-work",
          launch_args: [],
          env: {},
          models: [],
          hidden_models: [],
          model_order: [],
          favorite_models: [],
          local_capabilities: ["filesystem"],
        },
        {
          id: "codex-personal",
          driver_kind: "codex",
          enabled: true,
          home: "/tmp/codex-personal",
          launch_args: [],
          env: {},
          models: [],
          hidden_models: [],
          model_order: [],
          favorite_models: [],
          local_capabilities: ["filesystem"],
        },
      ],
    });

    assert.deepEqual(registry.computeContinuationGroups(), [
      {
        key: "codex:/tmp/codex-work",
        driver_kind: "codex",
        provider_instance_ids: ["codex-work"],
      },
      {
        key: "codex:/tmp/codex-personal",
        driver_kind: "codex",
        provider_instance_ids: ["codex-personal"],
      },
    ]);
  });
});
