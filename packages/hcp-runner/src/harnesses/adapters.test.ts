import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import type { HcpSessionStartPayload } from "@harness-control/protocol";

import type { ProviderInstanceConfig } from "../config/index.js";
import {
  ClaudeHarnessAdapter,
  CodexHarnessAdapter,
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

function claudeProvider(executablePath: string, env: Record<string, string> = {}): ProviderInstanceConfig {
  return {
    id: "claude-local",
    driver_kind: "claude",
    enabled: true,
    executable_path: executablePath,
    launch_args: [],
    env,
    models: [
      {
        id: "sonnet",
        label: "Claude Sonnet",
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

function claudeStartPayload(workspace: string): HcpSessionStartPayload {
  return {
    session_id: "session-1",
    workspace_id: "workspace-1",
    provider_instance_id: "claude-local",
    driver_kind: "claude",
    cwd: workspace,
    sandbox_mode: "workspace_write",
    approval_policy: "ask",
    continue_session: false,
    model_selection: { model: "sonnet" },
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

async function fakeCodexScript(authenticated: boolean): Promise<{ root: string; executable: string; cleanup(): Promise<void> }> {
  const root: string = await mkdtemp(join(tmpdir(), "hcp-fake-codex-"));
  const executable: string = join(root, "codex");
  await writeFile(
    executable,
    [
      "#!/bin/sh",
      "if [ -n \"$HCP_FAKE_CODEX_ARGS_PATH\" ]; then printf '%s\\n' \"$*\" >> \"$HCP_FAKE_CODEX_ARGS_PATH\"; fi",
      "is_exec=0",
      "is_version=0",
      "is_login_status=0",
      "output=''",
      "prev=''",
      "for arg in \"$@\"; do",
      "  if [ \"$arg\" = \"--version\" ]; then is_version=1; fi",
      "  if [ \"$prev\" = \"login\" ] && [ \"$arg\" = \"status\" ]; then is_login_status=1; fi",
      "  if [ \"$arg\" = \"exec\" ]; then is_exec=1; fi",
      "  if [ \"$prev\" = \"--output-last-message\" ]; then output=\"$arg\"; fi",
      "  prev=\"$arg\"",
      "done",
      "if [ \"$is_version\" = \"1\" ]; then echo 'codex-cli 9.9.9'; exit 0; fi",
      "if [ \"$is_login_status\" = \"1\" ]; then",
      authenticated ? "  echo 'Logged in'; exit 0" : "  echo 'Not logged in' >&2; exit 1",
      "fi",
      "if [ \"$is_exec\" = \"1\" ]; then",
      "  if [ -n \"$HCP_FAKE_CODEX_STARTED_PATH\" ]; then echo started > \"$HCP_FAKE_CODEX_STARTED_PATH\"; fi",
      "  if [ -n \"$HCP_FAKE_CODEX_TERMINATED_PATH\" ]; then",
      "    trap 'echo terminated > \"$HCP_FAKE_CODEX_TERMINATED_PATH\"; exit 143' TERM INT",
      "  fi",
      "  if [ \"${HCP_FAKE_CODEX_REQUIRE_STDIN_EOF:-0}\" = \"1\" ]; then cat >/dev/null; fi",
      "  case \"${HCP_FAKE_CODEX_EXEC_MODE:-success}\" in",
      "    fail)",
      "      echo 'fake failure at /Users/example/.codex/config.toml:5:16 with Bearer abc123 and api_key=secret123' >&2",
      "      exit 42",
      "      ;;",
      "    sleep)",
      "      while true; do sleep 1; done",
      "      ;;",
      "    no_output)",
      "      exit 0",
      "      ;;",
      "    large_output)",
      "      i=0",
      "      while [ \"$i\" -lt 2048 ]; do",
      "        printf '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' >&2",
      "        i=$((i + 1))",
      "      done",
      "      printf 'tail-secret' >&2",
      "      exit 42",
      "      ;;",
      "    *)",
      "      echo 'fake codex final' > \"$output\"",
      "      echo '{\"event\":\"done\"}'",
      "      exit 0",
      "      ;;",
      "  esac",
      "fi",
      "echo \"unexpected args: $*\" >&2",
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

async function fakeClaudeScript(authenticated: boolean): Promise<{ root: string; executable: string; cleanup(): Promise<void> }> {
  const root: string = await mkdtemp(join(tmpdir(), "hcp-fake-claude-"));
  const executable: string = join(root, "claude");
  await writeFile(
    executable,
    [
      "#!/bin/sh",
      "if [ -n \"$HCP_FAKE_CLAUDE_ARGS_PATH\" ]; then printf '%s\\n' \"$*\" >> \"$HCP_FAKE_CLAUDE_ARGS_PATH\"; fi",
      "is_print=0",
      "is_version=0",
      "is_auth_status=0",
      "prev=''",
      "for arg in \"$@\"; do",
      "  if [ \"$arg\" = \"--version\" ] || [ \"$arg\" = \"-v\" ]; then is_version=1; fi",
      "  if [ \"$prev\" = \"auth\" ] && [ \"$arg\" = \"status\" ]; then is_auth_status=1; fi",
      "  if [ \"$arg\" = \"-p\" ] || [ \"$arg\" = \"--print\" ]; then is_print=1; fi",
      "  prev=\"$arg\"",
      "done",
      "if [ \"$is_version\" = \"1\" ]; then echo '2.9.9 (Claude Code)'; exit 0; fi",
      "if [ \"$is_auth_status\" = \"1\" ]; then",
      authenticated ? "  echo '{\"loggedIn\":true}'; exit 0" : "  echo '{\"loggedIn\":false}'; exit 1",
      "fi",
      "if [ \"$is_print\" = \"1\" ]; then",
      "  if [ -n \"$HCP_FAKE_CLAUDE_STARTED_PATH\" ]; then echo started > \"$HCP_FAKE_CLAUDE_STARTED_PATH\"; fi",
      "  if [ -n \"$HCP_FAKE_CLAUDE_TERMINATED_PATH\" ]; then",
      "    trap 'echo terminated > \"$HCP_FAKE_CLAUDE_TERMINATED_PATH\"; exit 143' TERM INT",
      "  fi",
      "  case \"${HCP_FAKE_CLAUDE_EXEC_MODE:-success}\" in",
      "    fail)",
      "      echo 'fake failure at /Users/example/.claude/settings.json with Bearer abc123 and api_key=secret123' >&2",
      "      exit 42",
      "      ;;",
      "    sleep)",
      "      while true; do sleep 1; done",
      "      ;;",
      "    invalid_json)",
      "      echo '{not-json'",
      "      exit 0",
      "      ;;",
      "    error_json)",
      "      echo '{\"type\":\"result\",\"subtype\":\"error\",\"is_error\":true,\"result\":\"fake claude error\"}'",
      "      exit 0",
      "      ;;",
      "    *)",
      "      echo '{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"fake claude final\",\"terminal_reason\":\"completed\"}'",
      "      exit 0",
      "      ;;",
      "  esac",
      "fi",
      "echo \"unexpected args: $*\" >&2",
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
    const workspace = await createWorkspace();
    const adapter = new CodexHarnessAdapter();
    const selectedProvider = provider(fake.executable);

    try {
      const status = await adapter.probe(selectedProvider);
      assert.equal(status.available, true);
      assert.equal(status.version, "codex-cli 9.9.9");

      const selectedStartPayload: HcpSessionStartPayload = startPayload(workspace.root);
      const session = await adapter.startSession({ payload: selectedStartPayload, provider: selectedProvider });
      const events = await adapter.sendTurn({
        session,
        startPayload: selectedStartPayload,
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
      assert.deepEqual(await adapter.cancelTurn({ sessionId: "session-1", turnId: "turn-1" }), []);
    } finally {
      await workspace.cleanup();
      await fake.cleanup();
    }
  });

  it("passes runner-local Codex launch args to probes and turns", async () => {
    const fake = await fakeCodexScript(true);
    const workspace = await createWorkspace();
    const argsPath: string = join(fake.root, "args.log");
    const adapter = new CodexHarnessAdapter();
    const selectedProvider: ProviderInstanceConfig = {
      ...provider(fake.executable, { HCP_FAKE_CODEX_ARGS_PATH: argsPath }),
      launch_args: ["-c", "service_tier=fast"],
    };

    try {
      const status = await adapter.probe(selectedProvider);
      assert.equal(status.available, true);

      const selectedStartPayload: HcpSessionStartPayload = startPayload(workspace.root);
      const session = await adapter.startSession({ payload: selectedStartPayload, provider: selectedProvider });
      await adapter.sendTurn({
        session,
        startPayload: selectedStartPayload,
        provider: selectedProvider,
        payload: {
          session_id: "session-1",
          turn_id: "turn-1",
          input: "Say hello.",
        },
      });

      const lines: string[] = (await readFile(argsPath, "utf8")).trim().split(/\r?\n/);
      assert.match(lines[0] ?? "", /^-c service_tier=fast --version$/);
      assert.match(lines[1] ?? "", /^-c service_tier=fast login status$/);
      assert.match(lines[2] ?? "", /^-c service_tier=fast --ask-for-approval on-request exec /);
    } finally {
      await workspace.cleanup();
      await fake.cleanup();
    }
  });

  it("passes proxied MCP config to Codex turns", async () => {
    const fake = await fakeCodexScript(true);
    const workspace = await createWorkspace();
    const argsPath: string = join(fake.root, "args.log");
    const adapter = new CodexHarnessAdapter();
    const selectedProvider: ProviderInstanceConfig = provider(fake.executable, { HCP_FAKE_CODEX_ARGS_PATH: argsPath });

    try {
      const selectedStartPayload: HcpSessionStartPayload = {
        ...startPayload(workspace.root),
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
      const session = await adapter.startSession({ payload: selectedStartPayload, provider: selectedProvider });
      await adapter.sendTurn({
        session,
        startPayload: selectedStartPayload,
        provider: selectedProvider,
        payload: {
          session_id: "session-1",
          turn_id: "turn-1",
          input: "Say hello.",
        },
      });

      const lines: string[] = (await readFile(argsPath, "utf8")).trim().split(/\r?\n/);
      assert.match(
        lines[0] ?? "",
        /^-c mcp_servers\.tools\.url="http:\/\/127\.0\.0\.1:12345\/mcp" --ask-for-approval on-request exec /,
      );
    } finally {
      await workspace.cleanup();
      await fake.cleanup();
    }
  });

  it("closes Codex stdin after passing the prompt as an argument", async () => {
    const fake = await fakeCodexScript(true);
    const workspace = await createWorkspace();
    const adapter = new CodexHarnessAdapter({ turnTimeoutMs: 2_000 });
    const selectedProvider: ProviderInstanceConfig = provider(fake.executable, { HCP_FAKE_CODEX_REQUIRE_STDIN_EOF: "1" });

    try {
      const selectedStartPayload: HcpSessionStartPayload = startPayload(workspace.root);
      const session = await adapter.startSession({ payload: selectedStartPayload, provider: selectedProvider });
      const events: HarnessAdapterEvent[] = await adapter.sendTurn({
        session,
        startPayload: selectedStartPayload,
        provider: selectedProvider,
        payload: {
          session_id: "session-1",
          turn_id: "turn-1",
          input: "Say hello.",
        },
      });

      assert.equal(events.at(-1)?.event_type, "turn.completed");
    } finally {
      await workspace.cleanup();
      await fake.cleanup();
    }
  });

  it("normalizes Codex exec failures without leaking local paths", async () => {
    const fake = await fakeCodexScript(true);
    const workspace = await createWorkspace();
    const adapter = new CodexHarnessAdapter();
    const selectedProvider = provider(fake.executable, { HCP_FAKE_CODEX_EXEC_MODE: "fail" });

    try {
      const selectedStartPayload: HcpSessionStartPayload = startPayload(workspace.root);
      const session = await adapter.startSession({ payload: selectedStartPayload, provider: selectedProvider });
      const events = await adapter.sendTurn({
        session,
        startPayload: selectedStartPayload,
        provider: selectedProvider,
        payload: {
          session_id: "session-1",
          turn_id: "turn-1",
          input: "Fail.",
        },
      });
      const failed = events.at(-1);
      const error = failed?.data.error as { code?: string; message?: string } | undefined;

      assert.deepEqual(
        events.map((event) => event.event_type),
        ["turn.started", "turn.failed"],
      );
      assert.equal(error?.code, "codex_exec_failed");
      assert.match(error?.message ?? "", /<local-path>/);
      assert.doesNotMatch(error?.message ?? "", /\/Users\/example/);
      assert.doesNotMatch(error?.message ?? "", /abc123|secret123/);
    } finally {
      await workspace.cleanup();
      await fake.cleanup();
    }
  });

  it("caps captured Codex output for noisy failures", async () => {
    const fake = await fakeCodexScript(true);
    const workspace = await createWorkspace();
    const adapter = new CodexHarnessAdapter();
    const selectedProvider = provider(fake.executable, { HCP_FAKE_CODEX_EXEC_MODE: "large_output" });

    try {
      const selectedStartPayload: HcpSessionStartPayload = startPayload(workspace.root);
      const session = await adapter.startSession({ payload: selectedStartPayload, provider: selectedProvider });
      const events = await adapter.sendTurn({
        session,
        startPayload: selectedStartPayload,
        provider: selectedProvider,
        payload: {
          session_id: "session-1",
          turn_id: "turn-1",
          input: "Fail loudly.",
        },
      });
      const failed = events.at(-1);
      const error = failed?.data.error as { code?: string; message?: string } | undefined;

      assert.equal(error?.code, "codex_exec_failed");
      assert.ok(Buffer.byteLength(error?.message ?? "", "utf8") <= 64 * 1024);
      assert.doesNotMatch(error?.message ?? "", /tail-secret/);
    } finally {
      await workspace.cleanup();
      await fake.cleanup();
    }
  });

  it("terminates timed-out Codex turns and cleans temporary output", async () => {
    const fake = await fakeCodexScript(true);
    const workspace = await createWorkspace();
    const tempRoot: string = await mkdtemp(join(tmpdir(), "hcp-codex-temp-root-"));
    const adapter = new CodexHarnessAdapter({ processKillGraceMs: 50, temporaryDirectoryRoot: tempRoot, turnTimeoutMs: 50 });
    const selectedProvider = provider(fake.executable, { HCP_FAKE_CODEX_EXEC_MODE: "sleep" });

    try {
      const selectedStartPayload: HcpSessionStartPayload = startPayload(workspace.root);
      const session = await adapter.startSession({ payload: selectedStartPayload, provider: selectedProvider });
      const events = await adapter.sendTurn({
        session,
        startPayload: selectedStartPayload,
        provider: selectedProvider,
        payload: {
          session_id: "session-1",
          turn_id: "turn-1",
          input: "Timeout.",
        },
      });
      const failed = events.at(-1);
      const finalOutput = failed?.data.final_output as { exit_reason?: string } | undefined;
      const error = failed?.data.error as { code?: string } | undefined;

      assert.deepEqual(
        events.map((event) => event.event_type),
        ["turn.started", "turn.failed"],
      );
      assert.equal(finalOutput?.exit_reason, "timeout");
      assert.equal(error?.code, "codex_exec_timeout");
      assert.deepEqual(await readdir(tempRoot), []);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
      await workspace.cleanup();
      await fake.cleanup();
    }
  });

  it("cancels a running Codex child process", async () => {
    const fake = await fakeCodexScript(true);
    const workspace = await createWorkspace();
    const tempRoot: string = await mkdtemp(join(tmpdir(), "hcp-codex-temp-root-"));
    const startedPath: string = join(fake.root, "started");
    const adapter = new CodexHarnessAdapter({ processKillGraceMs: 50, temporaryDirectoryRoot: tempRoot });
    const selectedProvider = provider(fake.executable, {
      HCP_FAKE_CODEX_EXEC_MODE: "sleep",
      HCP_FAKE_CODEX_STARTED_PATH: startedPath,
    });

    try {
      const selectedStartPayload: HcpSessionStartPayload = startPayload(workspace.root);
      const session = await adapter.startSession({ payload: selectedStartPayload, provider: selectedProvider });
      const turnPromise: Promise<HarnessAdapterEvent[]> = adapter.sendTurn({
        session,
        startPayload: selectedStartPayload,
        provider: selectedProvider,
        payload: {
          session_id: "session-1",
          turn_id: "turn-1",
          input: "Cancel.",
        },
      });
      await waitForPath(startedPath);

      const cancelEvents = await adapter.cancelTurn({ sessionId: "session-1", turnId: "turn-1" });
      const turnEvents = await turnPromise;

      assert.deepEqual(
        cancelEvents.map((event) => event.event_type),
        ["turn.cancelled"],
      );
      assert.deepEqual(turnEvents, []);
      assert.deepEqual(await readdir(tempRoot), []);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
      await workspace.cleanup();
      await fake.cleanup();
    }
  });

  it("stops active Codex child processes and cleans temporary output", async () => {
    const fake = await fakeCodexScript(true);
    const workspace = await createWorkspace();
    const tempRoot: string = await mkdtemp(join(tmpdir(), "hcp-codex-temp-root-"));
    const startedPath: string = join(fake.root, "started");
    const adapter = new CodexHarnessAdapter({ processKillGraceMs: 50, temporaryDirectoryRoot: tempRoot });
    const selectedProvider = provider(fake.executable, {
      HCP_FAKE_CODEX_EXEC_MODE: "sleep",
      HCP_FAKE_CODEX_STARTED_PATH: startedPath,
    });

    try {
      const selectedStartPayload: HcpSessionStartPayload = startPayload(workspace.root);
      const session = await adapter.startSession({ payload: selectedStartPayload, provider: selectedProvider });
      const turnPromise: Promise<HarnessAdapterEvent[]> = adapter.sendTurn({
        session,
        startPayload: selectedStartPayload,
        provider: selectedProvider,
        payload: {
          session_id: "session-1",
          turn_id: "turn-1",
          input: "Stop.",
        },
      });
      await waitForPath(startedPath);

      const stopEvents = await adapter.stopSession({ sessionId: "session-1", reason: "test-stop" });
      const turnEvents = await turnPromise;

      assert.deepEqual(
        stopEvents.map((event) => event.event_type),
        ["turn.cancelled"],
      );
      assert.equal((stopEvents[0]?.data.final_output as { exit_reason?: string } | undefined)?.exit_reason, "session_stopped");
      assert.deepEqual(turnEvents, []);
      assert.deepEqual(await readdir(tempRoot), []);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
      await workspace.cleanup();
      await fake.cleanup();
    }
  });

  it("fails closed when Codex sessions include unproxied MCP attachments", async () => {
    const fake = await fakeCodexScript(true);
    const workspace = await createWorkspace();
    const adapter = new CodexHarnessAdapter();
    const selectedProvider = provider(fake.executable);

    try {
      await assert.rejects(
        () =>
          adapter.startSession({
            provider: selectedProvider,
            payload: {
              ...startPayload(workspace.root),
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
          error instanceof HarnessAdapterError && error.code === "codex_mcp_attachment_requires_proxy",
      );
    } finally {
      await workspace.cleanup();
      await fake.cleanup();
    }
  });
});

describe("ClaudeHarnessAdapter", () => {
  it("reports unauthenticated status when Claude auth status fails", async () => {
    const fake = await fakeClaudeScript(false);
    const adapter = new ClaudeHarnessAdapter();

    try {
      const status = await adapter.probe(claudeProvider(fake.executable));
      assert.equal(status.installed, true);
      assert.equal(status.available, false);
      assert.equal(status.status, "unauthenticated");
      assert.match(status.message ?? "", /loggedIn/);
    } finally {
      await fake.cleanup();
    }
  });

  it("runs a fake Claude turn and normalizes JSON result output", async () => {
    const fake = await fakeClaudeScript(true);
    const workspace = await createWorkspace();
    const adapter = new ClaudeHarnessAdapter();
    const selectedProvider = claudeProvider(fake.executable);

    try {
      const selectedStartPayload: HcpSessionStartPayload = claudeStartPayload(workspace.root);
      const session = await adapter.startSession({ payload: selectedStartPayload, provider: selectedProvider });
      const events: HarnessAdapterEvent[] = await adapter.sendTurn({
        session,
        startPayload: selectedStartPayload,
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
      assert.deepEqual(events.at(-1)?.data.final_output, { final_text: "fake claude final" });
      assert.deepEqual(await adapter.cancelTurn({ sessionId: "session-1", turnId: "turn-1" }), []);
    } finally {
      await workspace.cleanup();
      await fake.cleanup();
    }
  });

  it("passes proxied MCP config to Claude turns", async () => {
    const fake = await fakeClaudeScript(true);
    const workspace = await createWorkspace();
    const argsPath: string = join(fake.root, "args.log");
    const adapter = new ClaudeHarnessAdapter();
    const selectedProvider: ProviderInstanceConfig = claudeProvider(fake.executable, { HCP_FAKE_CLAUDE_ARGS_PATH: argsPath });

    try {
      const selectedStartPayload: HcpSessionStartPayload = {
        ...claudeStartPayload(workspace.root),
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
      const session = await adapter.startSession({ payload: selectedStartPayload, provider: selectedProvider });
      await adapter.sendTurn({
        session,
        startPayload: selectedStartPayload,
        provider: selectedProvider,
        payload: {
          session_id: "session-1",
          turn_id: "turn-1",
          input: "Say hello.",
        },
      });

      const lines: string[] = (await readFile(argsPath, "utf8")).trim().split(/\r?\n/);
      assert.match(
        lines[0] ?? "",
        /^--mcp-config \{"mcpServers":\{"tools":\{"type":"http","url":"http:\/\/127\.0\.0\.1:12345\/mcp"\}\}\} --strict-mcp-config -p --output-format json --no-session-persistence --permission-mode default --model sonnet /,
      );
    } finally {
      await workspace.cleanup();
      await fake.cleanup();
    }
  });

  it("fails closed when Claude sessions include unproxied MCP attachments", async () => {
    const fake = await fakeClaudeScript(true);
    const workspace = await createWorkspace();
    const adapter = new ClaudeHarnessAdapter();
    const selectedProvider = claudeProvider(fake.executable);

    try {
      await assert.rejects(
        () =>
          adapter.startSession({
            provider: selectedProvider,
            payload: {
              ...claudeStartPayload(workspace.root),
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
          error instanceof HarnessAdapterError && error.code === "claude_mcp_attachment_requires_proxy",
      );
    } finally {
      await workspace.cleanup();
      await fake.cleanup();
    }
  });

  it("stops active Claude child processes", async () => {
    const fake = await fakeClaudeScript(true);
    const workspace = await createWorkspace();
    const startedPath: string = join(fake.root, "started");
    const terminatedPath: string = join(fake.root, "terminated");
    const adapter = new ClaudeHarnessAdapter({ turnTimeoutMs: 10_000 });
    const selectedProvider = claudeProvider(fake.executable, {
      HCP_FAKE_CLAUDE_EXEC_MODE: "sleep",
      HCP_FAKE_CLAUDE_STARTED_PATH: startedPath,
      HCP_FAKE_CLAUDE_TERMINATED_PATH: terminatedPath,
    });

    try {
      const selectedStartPayload: HcpSessionStartPayload = claudeStartPayload(workspace.root);
      const session = await adapter.startSession({ payload: selectedStartPayload, provider: selectedProvider });
      const turnPromise: Promise<HarnessAdapterEvent[]> = adapter.sendTurn({
        session,
        startPayload: selectedStartPayload,
        provider: selectedProvider,
        payload: {
          session_id: "session-1",
          turn_id: "turn-1",
          input: "Stop.",
        },
      });
      await waitForPath(startedPath);

      const stopEvents = await adapter.stopSession({ sessionId: "session-1", reason: "test-stop" });
      const turnEvents = await turnPromise;

      assert.deepEqual(
        stopEvents.map((event) => event.event_type),
        ["turn.cancelled"],
      );
      assert.equal((stopEvents[0]?.data.final_output as { exit_reason?: string } | undefined)?.exit_reason, "session_stopped");
      assert.deepEqual(turnEvents, []);
      await waitForPath(terminatedPath);
    } finally {
      await workspace.cleanup();
      await fake.cleanup();
    }
  });
});

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
