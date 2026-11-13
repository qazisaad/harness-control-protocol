import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import { hcpProviderSetupResultPayloadSchema, type HcpProviderSetupRequestPayload } from "@harness-control/protocol";

import { RunnerConfigSchema, loadRunnerConfig, type RunnerConfig } from "../config/index.js";
import { createDefaultHarnessAdapterRegistry } from "../harnesses/adapters/registry.js";
import { HarnessSessionError } from "../harnesses/index.js";
import { PROVIDER_RELEASES, reportedReleaseVersion } from "../harnesses/provider-releases.js";
import { shellCommandLine } from "../harnesses/adapters/providers/cli-process.js";
import { JsonRunnerStateStore, MemoryRunnerStateStore } from "../state/index.js";
import { ProviderInstallError, ProviderSetup, RemoteProviderSetup, type ProviderPackageInstaller } from "./index.js";

/** A stand-in for Codex's npm package: the same bin layout, answering the real adapter probe. */
async function writeFakeCodex(path: string, version: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli ${version}"; exit 0; fi\nif [ "$1" = "login" ]; then echo "Not logged in" >&2; exit 1; fi\nexit 2\n`);
  await chmod(path, 0o755);
}

function fakeInstaller(version = PROVIDER_RELEASES.codex.version): ProviderPackageInstaller & { calls: string[] } {
  const calls: string[] = [];
  const installer = async ({ packageSpec, prefix }: { packageSpec: string; prefix: string }): Promise<void> => {
    calls.push(packageSpec);
    await writeFakeCodex(join(prefix, "node_modules", ".bin", "codex"), version);
  };
  return Object.assign(installer, { calls });
}

type Fixture = { root: string; configPath: string; installRoot: string; config: RunnerConfig; cleanup(): Promise<void> };

async function fixture(raw: Record<string, unknown> = {}): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hcp-provider-setup-")));
  const configPath = join(root, "runner.json");
  await writeFile(configPath, JSON.stringify({ runner_id: "test", control_plane_url: "ws://localhost:1", ...raw }));
  return { root, configPath, installRoot: join(root, "providers"), config: await loadRunnerConfig(configPath), cleanup: () => rm(root, { recursive: true, force: true }) };
}

function setupFor(context: Fixture, installer: ProviderPackageInstaller, overrides: Partial<ConstructorParameters<typeof ProviderSetup>[0]> = {}): ProviderSetup {
  const registry = createDefaultHarnessAdapterRegistry();
  return new ProviderSetup({
    config: context.config, configPath: context.configPath, installRoot: context.installRoot, installer,
    probe: providers => registry.probeProviders(providers), commitConfiguration: change => change(), ...overrides,
  });
}

const codexVersion = PROVIDER_RELEASES.codex.version;

describe("ProviderSetup", () => {
  it("installs the tested release into a runner-owned folder, configures it and reports the sign-in command", async () => {
    const context = await fixture({ provider_instances: [{ id: "claude-local", driver_kind: "claude", executable_path: "/nonexistent/claude" }] });
    try {
      const installer = fakeInstaller();
      const outcome = await setupFor(context, installer).run("codex", "install");
      const executable = join(context.installRoot, "codex", codexVersion, "node_modules", ".bin", "codex");
      assert.deepEqual(outcome, { kind: "installed", version: codexVersion, changed: true, status: "unauthenticated", login_command: `${executable} login` });
      assert.deepEqual(installer.calls, [`@openai/codex@${codexVersion}`]);
      assert.deepEqual(await readdir(join(context.installRoot, "codex")), [codexVersion]);
      const saved = await loadRunnerConfig(context.configPath);
      assert.deepEqual(saved.provider_instances.map(provider => [provider.id, provider.executable_path]), [["claude-local", "/nonexistent/claude"], ["codex-local", executable]]);
      assert.deepEqual(saved, context.config);
      // Raw fields stay as written: defaults are not expanded into the saved file.
      assert.equal(JSON.parse(await readFile(context.configPath, "utf8")).provider_instances[0].launch_args, undefined);
    } finally { await context.cleanup(); }
  });

  it("refuses a second install, and update is a no-op at the tested version", async () => {
    const context = await fixture();
    try {
      const installer = fakeInstaller();
      const setup = setupFor(context, installer);
      assert.equal((await setup.run("codex", "install")).kind, "installed");
      const before = await readFile(context.configPath, "utf8");
      const again = await setup.run("codex", "install");
      assert.equal(again.kind, "refused");
      if (again.kind === "refused") assert.equal(again.reason, "already_installed");
      assert.deepEqual(await setup.run("codex", "update"), { kind: "installed", version: codexVersion, changed: false, status: "unauthenticated",
        login_command: `${join(context.installRoot, "codex", codexVersion, "node_modules", ".bin", "codex")} login` });
      assert.equal(installer.calls.length, 1);
      assert.equal(await readFile(context.configPath, "utf8"), before);
    } finally { await context.cleanup(); }
  });

  it("updates every instance of the agent away from another version without touching that install", async () => {
    const context = await fixture();
    try {
      const userInstall = join(context.root, "user", "codex");
      await writeFakeCodex(userInstall, "0.150.0");
      await writeFile(context.configPath, JSON.stringify({ runner_id: "test", control_plane_url: "ws://localhost:1", provider_instances: [
        { id: "codex-a", driver_kind: "codex", executable_path: userInstall },
        { id: "codex-b", driver_kind: "codex", home: join(context.root, "codex-b") },
        { id: "claude-local", driver_kind: "claude" },
      ] }));
      context.config = await loadRunnerConfig(context.configPath);
      const installer = fakeInstaller();
      const outcome = await setupFor(context, installer).run("codex", "update");
      const executable = join(context.installRoot, "codex", codexVersion, "node_modules", ".bin", "codex");
      assert.equal(outcome.kind, "installed");
      if (outcome.kind === "installed") assert.equal(outcome.changed, true);
      const saved = await loadRunnerConfig(context.configPath);
      assert.deepEqual(saved.provider_instances.map(provider => provider.executable_path), [executable, executable, undefined]);
      assert.match(await readFile(userInstall, "utf8"), /0\.150\.0/);
    } finally { await context.cleanup(); }
  });

  it("reports install, verification and configuration failures without changing configuration", async () => {
    const context = await fixture();
    try {
      const before = await readFile(context.configPath, "utf8");
      const failing: ProviderPackageInstaller = async () => { throw new ProviderInstallError("npm could not install: E404"); };
      assert.deepEqual(await setupFor(context, failing).run("codex", "install"), { kind: "failed", reason: "install_failed", message: "npm could not install: E404" });
      const empty: ProviderPackageInstaller = async () => undefined;
      const missing = await setupFor(context, empty).run("codex", "install");
      assert.equal(missing.kind === "failed" && missing.reason, "install_failed");
      assert.deepEqual(await readdir(context.installRoot).then(entries => readdir(join(context.installRoot, entries[0]!))), [],
        "a failed install leaves no partial folder");

      const wrong = await setupFor(context, fakeInstaller("0.1.0")).run("codex", "install");
      assert.equal(wrong.kind === "failed" && wrong.reason, "verification_failed");
      assert.deepEqual(await readdir(join(context.installRoot, "codex")), [], "an unverified install never becomes a version folder");

      const busy = await setupFor(context, fakeInstaller(), {
        commitConfiguration: async () => { throw new HarnessSessionError("provider_setup_busy", "Stop active sessions before changing coding agents."); },
      }).run("codex", "install");
      assert.equal(busy.kind === "failed" && busy.reason, "configuration_failed");
      assert.match(busy.kind === "failed" ? busy.message : "", /active sessions/);
      await writeFile(context.configPath, before.replace('"test"', '"edited"'));
      const conflict = await setupFor(context, fakeInstaller()).run("codex", "install");
      assert.equal(conflict.kind === "failed" && conflict.reason, "configuration_failed");
      assert.equal(await readFile(context.configPath, "utf8"), before.replace('"test"', '"edited"'));
    } finally { await context.cleanup(); }
  });

  it("serializes setups of one agent so concurrent requests install once", async () => {
    const context = await fixture();
    try {
      const installer = fakeInstaller();
      const setup = setupFor(context, installer);
      const [first, second] = await Promise.all([setup.run("codex", "update"), setup.run("codex", "update")]);
      assert.equal(first.kind === "installed" && first.changed, true);
      assert.equal(second.kind === "installed" && second.changed, false);
      assert.equal(installer.calls.length, 1);
    } finally { await context.cleanup(); }
  });

  it("refuses on Windows", async () => {
    const context = await fixture();
    try {
      const installer = fakeInstaller();
      const outcome = await setupFor(context, installer, { platform: "win32" }).run("codex", "install");
      assert.equal(outcome.kind === "refused" && outcome.reason, "unsupported_platform");
      assert.equal(installer.calls.length, 0);
    } finally { await context.cleanup(); }
  });
});

describe("RemoteProviderSetup", () => {
  const request = (overrides: Partial<HcpProviderSetupRequestPayload> = {}): HcpProviderSetupRequestPayload =>
    ({ agent: "codex", action: "install", expires_at: new Date(Date.now() + 60_000).toISOString(), ...overrides });

  it("is off by default and when the runner has no configuration file", async () => {
    const context = await fixture();
    try {
      const installer = fakeInstaller();
      const remote = new RemoteProviderSetup(context.config, setupFor(context, installer), new MemoryRunnerStateStore());
      assert.deepEqual(remote.snapshot(), { agents: [] });
      const { result } = await remote.execute("r1", request());
      assert.equal(result.outcome.kind === "refused" && result.outcome.reason, "remote_setup_disabled");
      const enabled = RunnerConfigSchema.parse({ ...context.config, provider_setup: { remote_agents: ["codex"] } });
      const unconfigured = new RemoteProviderSetup(enabled, undefined, new MemoryRunnerStateStore());
      assert.deepEqual(unconfigured.snapshot(), { agents: [] });
      assert.equal((await unconfigured.execute("r2", request())).result.outcome.kind, "refused");
      assert.equal(installer.calls.length, 0);
    } finally { await context.cleanup(); }
  });

  it("allows only the listed agents and unexpired requests", async () => {
    const context = await fixture({ provider_setup: { remote_agents: ["opencode", "codex"] } });
    try {
      const installer = fakeInstaller();
      const remote = new RemoteProviderSetup(context.config, setupFor(context, installer), new MemoryRunnerStateStore());
      assert.deepEqual(remote.snapshot(), { agents: [
        { agent: "opencode", version: PROVIDER_RELEASES.opencode.version }, { agent: "codex", version: codexVersion }] });
      const { result: claude } = await remote.execute("claude", request({ agent: "claude" }));
      assert.equal(claude.outcome.kind === "refused" && claude.outcome.reason, "agent_not_allowed");
      const { result: expired } = await remote.execute("expired", request({ expires_at: new Date(0).toISOString() }));
      assert.equal(expired.outcome.kind === "refused" && expired.outcome.reason, "request_expired");
      const { result: installed, replayed } = await remote.execute("install", request());
      assert.equal(replayed, false);
      assert.deepEqual(hcpProviderSetupResultPayloadSchema.parse(installed), installed);
      assert.equal(installed.outcome.kind === "installed" && installed.outcome.status, "unauthenticated");
      assert.equal(installer.calls.length, 1);
    } finally { await context.cleanup(); }
  });

  it("returns the recorded result for a repeated request id, also after a restart, and refuses a reused id", async () => {
    const context = await fixture({ provider_setup: { remote_agents: ["codex"] } });
    try {
      const statePath = join(context.root, "state.json");
      const installer = fakeInstaller();
      const remote = new RemoteProviderSetup(context.config, setupFor(context, installer), new JsonRunnerStateStore(statePath));
      const payload = request({ action: "update" });
      const [first, concurrent] = await Promise.all([remote.execute("same", payload), remote.execute("same", payload)]);
      assert.deepEqual(concurrent, { ...first, replayed: true });
      assert.equal(first.replayed, false);
      assert.equal(first.result.outcome.kind === "installed" && first.result.outcome.changed, true);
      const restarted = new RemoteProviderSetup(context.config, setupFor(context, installer), new JsonRunnerStateStore(statePath));
      assert.deepEqual(await restarted.execute("same", payload), { result: first.result, replayed: true });
      assert.equal(installer.calls.length, 1);
      const { result: reused } = await restarted.execute("same", request({ action: "install" }));
      assert.equal(reused.outcome.kind === "refused" && reused.outcome.reason, "request_id_reused");
    } finally { await context.cleanup(); }
  });
});

describe("provider setup contracts", () => {
  it("accepts only an explicit, unique list of known agents in local configuration", () => {
    const base = { runner_id: "test", control_plane_url: "ws://localhost:1" };
    assert.equal(RunnerConfigSchema.parse(base).provider_setup, undefined);
    for (const provider_setup of [{ remote_agents: [] }, { remote_agents: ["codex", "codex"] }, { remote_agents: ["cursor"] }, { allow_remote: true, remote_agents: ["codex"] }]) {
      assert.equal(RunnerConfigSchema.safeParse({ ...base, provider_setup }).success, false, JSON.stringify(provider_setup));
    }
  });

  it("pins tested versions that the release table and probes agree on", () => {
    assert.deepEqual(Object.values(PROVIDER_RELEASES).map(release => `${release.npmPackage}@${release.version}`),
      ["@anthropic-ai/claude-code@2.1.289", "@openai/codex@0.161.0", "opencode-ai@1.18.34"]);
    assert.equal(reportedReleaseVersion("codex-cli 0.161.0"), "0.161.0");
    assert.equal(reportedReleaseVersion("2.1.289 (Claude Code)"), "2.1.289");
    assert.equal(reportedReleaseVersion("opencode v1.18.34"), "1.18.34");
    assert.equal(reportedReleaseVersion("1.18.34-beta.1"), "1.18.34-beta.1");
    assert.equal(reportedReleaseVersion("no version"), undefined);
  });

  it("quotes sign-in command lines for a POSIX shell without echoing other environment", () => {
    assert.equal(shellCommandLine({}, ["/opt/codex/bin/codex", "login"]), "/opt/codex/bin/codex login");
    assert.equal(shellCommandLine({ CODEX_HOME: "/Users/a b/.codex" }, ["/x/it's/codex", "login"]),
      "CODEX_HOME='/Users/a b/.codex' '/x/it'\\''s/codex' login");
  });
});
