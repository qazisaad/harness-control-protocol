import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { ProviderInstanceConfig } from "../config/index.js";
import { CodexHarnessAdapter, HarnessAdapterError } from "./adapters.js";

function provider(executablePath: string): ProviderInstanceConfig {
  return {
    id: "codex-local",
    driver_kind: "codex",
    enabled: true,
    executable_path: executablePath,
    launch_args: [],
    env: {},
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

async function fakeCodexScript(authenticated: boolean): Promise<{ root: string; executable: string; cleanup(): Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "hcp-fake-codex-"));
  const executable = join(root, "codex");
  await writeFile(
    executable,
    [
      "#!/bin/sh",
      "if [ \"$1\" = \"--version\" ]; then echo 'codex-cli 9.9.9'; exit 0; fi",
      "if [ \"$1\" = \"login\" ] && [ \"$2\" = \"status\" ]; then",
      authenticated ? "  echo 'Logged in'; exit 0" : "  echo 'Not logged in' >&2; exit 1",
      "fi",
      "if [ \"$1\" = \"exec\" ]; then",
      "  output=''",
      "  prev=''",
      "  for arg in \"$@\"; do",
      "    if [ \"$prev\" = \"--output-last-message\" ]; then output=\"$arg\"; fi",
      "    prev=\"$arg\"",
      "  done",
      "  echo 'fake codex final' > \"$output\"",
      "  echo '{\"event\":\"done\"}'",
      "  exit 0",
      "fi",
      "echo 'unexpected args' >&2",
      "exit 2",
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(executable, 0o700);
  return {
    root,
    executable,
    cleanup: async (): Promise<void> => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe("CodexHarnessAdapter", () => {
  it("reports unauthenticated status when Codex login status fails", async () => {
    const fake = await fakeCodexScript(false);
    const adapter = new CodexHarnessAdapter();

    try {
      const status = await adapter.probe(provider(fake.executable));
      assert.equal(status.installed, true);
      assert.equal(status.available, false);
      assert.equal(status.status, "unauthenticated");
      assert.match(status.message ?? "", /Not logged in/);
    } finally {
      await fake.cleanup();
    }
  });

  it("runs a fake Codex turn and normalizes final output", async () => {
    const fake = await fakeCodexScript(true);
    const workspace = await mkdtemp(join(tmpdir(), "hcp-codex-workspace-"));
    const adapter = new CodexHarnessAdapter();
    const selectedProvider = provider(fake.executable);

    try {
      const status = await adapter.probe(selectedProvider);
      assert.equal(status.available, true);
      assert.equal(status.version, "codex-cli 9.9.9");

      const startPayload = {
        session_id: "session-1",
        workspace_id: "workspace-1",
        provider_instance_id: "codex-local",
        driver_kind: "codex",
        cwd: workspace,
        sandbox_mode: "workspace_write" as const,
        approval_policy: "ask" as const,
        continue_session: false,
        model_selection: { model: "gpt-test" },
        mcp_servers: [],
      };
      const session = await adapter.startSession({ payload: startPayload, provider: selectedProvider });
      const events = await adapter.sendTurn({
        session,
        startPayload,
        provider: selectedProvider,
        payload: {
          session_id: "session-1",
          turn_id: "turn-1",
          input: "Say hello.",
        },
      });

      assert.deepEqual(
        events.map((event) => event.event_type),
        ["turn.started", "content.delta", "turn.completed"],
      );
      assert.deepEqual(events.at(-1)?.data.final_output, { final_text: "fake codex final\n" });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await fake.cleanup();
    }
  });

  it("fails closed when Codex sessions include MCP attachments", async () => {
    const fake = await fakeCodexScript(true);
    const workspace = await mkdtemp(join(tmpdir(), "hcp-codex-workspace-"));
    const adapter = new CodexHarnessAdapter();
    const selectedProvider = provider(fake.executable);

    try {
      await assert.rejects(
        () =>
          adapter.startSession({
            provider: selectedProvider,
            payload: {
              session_id: "session-1",
              workspace_id: "workspace-1",
              provider_instance_id: "codex-local",
              driver_kind: "codex",
              cwd: workspace,
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
            },
          }),
        (error: unknown): boolean =>
          error instanceof HarnessAdapterError && error.code === "codex_mcp_attachment_unsupported",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await fake.cleanup();
    }
  });
});
