import { parseArgs } from "node:util";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadRunnerConfig, RunnerConfigSchema } from "@harness-control/runner/config";
import { startAccountsDashboard } from "./server.js";

export async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    config: { type: "string" }, port: { type: "string", default: "8795" },
    state: { type: "string", default: join(homedir(), ".hcp-runner", "account-dashboard.json") },
    "experimental-claude": { type: "boolean", default: false },
  } });
  const port = Number(values.port);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error("Invalid port.");
  const config = values.config ? await loadRunnerConfig(values.config) : RunnerConfigSchema.parse({
    runner_id: "account-dashboard", host_id: "account-dashboard-local", control_plane_url: "ws://127.0.0.1:1",
    provider_instances: [
      { id: "codex-local", driver_kind: "codex", display_name: "Codex", account_usage: {} },
      { id: "claude-local", driver_kind: "claude", display_name: "Claude Code",
        ...(values["experimental-claude"] ? { account_usage: { allow_experimental_claude: true } } : {}),
      },
    ],
  });
  const dashboard = await startAccountsDashboard({ config, port, statePath: values.state });
  console.log(`HCP account dashboard: ${dashboard.url}`);
  console.log("Local read-only collection. No prompts, purchases or account changes. Keep the URL private.");
  const stop = (): void => { void dashboard.close().then(() => { process.exitCode = 0; }); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : "Dashboard failed."); process.exitCode = 1; });
}
