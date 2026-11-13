import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, mock } from "node:test";

import { loadRunnerConfig } from "../config/index.js";
import { ConnectionOwnership, connectionDirectory } from "../ownership.js";
import { parseProvidersCommand, runProvidersCommand } from "./cli.js";
import type { ProviderPackageInstaller } from "./index.js";

async function capture(run: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const log = mock.method(console, "log", () => undefined);
  const error = mock.method(console, "error", () => undefined);
  try {
    const code = await run();
    return { code, out: log.mock.calls.map(call => call.arguments.join(" ")).join("\n"), err: error.mock.calls.map(call => call.arguments.join(" ")).join("\n") };
  } finally { log.mock.restore(); error.mock.restore(); }
}

it("parses only the documented providers commands", () => {
  assert.deepEqual(parseProvidersCommand(["install", "codex", "--config", "runner.json"]), { kind: "setup", action: "install", agent: "codex", configPath: "runner.json" });
  assert.deepEqual(parseProvidersCommand(["status", "--config", "runner.json"]), { kind: "status", configPath: "runner.json" });
  for (const args of [["install", "codex"], ["install", "cursor", "--config", "x"], ["update", "--config", "x"], ["status", "codex", "--config", "x"], ["remove", "codex", "--config", "x"], ["install", "codex", "--config", "x", "--version", "1"]]) {
    assert.throws(() => parseProvidersCommand(args), Error, args.join(" "));
  }
});

it("installs into the runner home, prints the sign-in command and status, and refuses while the runner is running", { skip: process.platform === "win32" }, async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "hcp-providers-cli-")));
  try {
    const configPath = join(home, "runner.json");
    await writeFile(configPath, JSON.stringify({ runner_id: "test", control_plane_url: "ws://localhost:1" }));
    const installs: string[] = [];
    const installer: ProviderPackageInstaller = async ({ packageSpec, prefix }) => {
      installs.push(packageSpec);
      const binary = join(prefix, "node_modules", ".bin", "codex");
      await mkdir(join(prefix, "node_modules", ".bin"), { recursive: true });
      await writeFile(binary, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo \"codex-cli 0.161.0\"; exit 0; fi\nexit 1\n");
      await chmod(binary, 0o755);
    };
    const executable = join(home, ".hcp-runner", "providers", "codex", "0.161.0", "node_modules", ".bin", "codex");

    const owner = ConnectionOwnership.acquire(connectionDirectory("ws://localhost:1", home));
    assert.notEqual(owner, "already_running");
    try {
      const refused = await capture(() => runProvidersCommand(["install", "codex", "--config", configPath], home, installer));
      assert.equal(refused.code, 1);
      assert.match(refused.err, /HCP is running/);
    } finally { if (owner !== "already_running") owner.release(); }
    assert.deepEqual(installs, []);

    const installed = await capture(() => runProvidersCommand(["install", "codex", "--config", configPath], home, installer));
    assert.equal(installed.code, 0, installed.err);
    assert.match(installed.out, /Codex 0\.161\.0 is installed/);
    assert.ok(installed.out.includes(`Sign in on this machine: ${executable} login`), installed.out);
    assert.equal((await loadRunnerConfig(configPath)).provider_instances[0]?.executable_path, executable);

    const status = await capture(() => runProvidersCommand(["status", "--config", configPath], home, installer));
    assert.equal(status.code, 0);
    assert.ok(status.out.includes("codex-local (codex): codex-cli 0.161.0; unauthenticated"), status.out);
    assert.ok(status.out.includes(`Sign in on this machine: ${executable} login`), status.out);
    assert.doesNotMatch(status.out, /Tested version/);
    assert.deepEqual(installs, ["@openai/codex@0.161.0"]);
  } finally { await rm(home, { recursive: true, force: true }); }
});
