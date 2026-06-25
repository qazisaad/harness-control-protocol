import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RunnerConfigSchema } from "./index.js";

describe("RunnerConfigSchema", () => {
  it("parses local runner config with workspace and provider defaults", () => {
    const config = RunnerConfigSchema.parse({
      runner_id: "runner-local",
      control_plane_url: "ws://localhost:8787/hcp",
      workspaces: [{ id: "workspace-main", path: "/tmp/workspace" }],
      provider_instances: [
        {
          id: "provider-main",
          driver_kind: "example-driver",
          display_name: "Example Driver",
          models: [{ id: "default", label: "Default" }],
        },
      ],
    });

    assert.equal(config.provider_instances[0]?.enabled, true);
    assert.deepEqual(config.provider_instances[0]?.models[0]?.capabilities, {
      option_descriptors: [],
    });
    assert.deepEqual(config.provider_instances[0]?.hidden_models, []);
  });

  it("rejects control plane URLs with unsupported protocols", () => {
    assert.throws(
      () =>
        RunnerConfigSchema.parse({
          runner_id: "runner-local",
          control_plane_url: "file:///tmp/control-plane.sock",
        }),
      /Control plane URL/,
    );
  });

  it("rejects provider instances without a driver kind", () => {
    assert.throws(
      () =>
        RunnerConfigSchema.parse({
          runner_id: "runner-local",
          control_plane_url: "https://control.example.test",
          provider_instances: [{ id: "provider-main" }],
        }),
      /driver_kind/,
    );
  });
});

