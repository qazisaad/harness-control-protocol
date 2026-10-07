import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtemp, writeFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {ProviderInstanceConfigSchema} from "../../../config/index.js";
import {CodexHarnessAdapter} from "./codex.js";
import {HarnessAdapterError} from "../types.js";

async function fixture(version: string, run: (adapter: CodexHarnessAdapter, provider: ReturnType<typeof ProviderInstanceConfigSchema.parse>, cwd: string) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), "hcp-codex-version-")), executable = join(cwd, "codex.cjs");
  await writeFile(executable, `#!${process.execPath}\nif (process.argv.includes('--version')) console.log(${JSON.stringify(version)}); else if (!process.argv.includes('login')) process.exit(3);\n`, {mode: 0o700});
  const provider = ProviderInstanceConfigSchema.parse({id: "fixture", driver_kind: "codex", executable_path: executable,
    models: [{id: "fixture", label: "Fixture"}]});
  const adapter = new CodexHarnessAdapter();
  try {await run(adapter, provider, cwd);} finally {await adapter.close();await rm(cwd, {recursive: true, force: true});}
}
test("persistent Codex profiles accept only individually verified 0.160.0, 0.160.1 and 0.161.0 releases", async () => {
  for (const version of ["codex-cli 0.160.0", "codex-cli 0.160.1", "codex-cli 0.161.0"]) await fixture(version, async (adapter, provider) => {
    const result = await adapter.probe(provider);
    assert.equal(result.available, true);assert.equal(result.execution_capabilities?.execution_profiles?.find(profile => profile.id === "interactive")?.native_owner_closure, "owned_session");
  });
});
test("unknown Codex patches and prereleases neither advertise nor start persistent ownership", async () => {
  for (const version of ["codex-cli 0.160.2", "codex-cli 0.160.1-alpha", "codex-cli 0.161.1", "codex-cli 0.161.0-alpha", "codex-cli 0.162.0"]) await fixture(version, async (adapter, provider, cwd) => {
    assert.equal((await adapter.probe(provider)).execution_capabilities?.execution_profiles, undefined);
    await assert.rejects(adapter.startSession({provider, payload: {session_id: "fixture", workspace_id: "fixture", provider_instance_id: "fixture", driver_kind: "codex",
      cwd, execution_profile: "interactive", continue_session: false, model_selection: {model: "fixture"}, sandbox_mode: "read_only", approval_policy: "ask", mcp_servers: []}}),
      error => error instanceof HarnessAdapterError && error.code === "native_profile_unsupported");
  });
});
