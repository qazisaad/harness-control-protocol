import { hcpProviderSetupAgentSchema, type HcpProviderSetupAgent } from "@harness-control/protocol";

import { loadRunnerConfig } from "../config/index.js";
import { shellCommandLine } from "../harnesses/adapters/providers/cli-process.js";
import { createDefaultHarnessAdapterRegistry } from "../harnesses/adapters/registry.js";
import { PROVIDER_RELEASES, isProviderSetupAgent, reportedReleaseVersion } from "../harnesses/provider-releases.js";
import { ProviderInstanceRegistry } from "../host/provider-registry.js";
import { ConnectionOwnership, connectionDirectory } from "../ownership.js";
import { ProviderSetup, defaultProviderInstallRoot, npmPackageInstaller, type ProviderPackageInstaller, type ProviderSetupAction } from "./index.js";

export const PROVIDERS_USAGE = [
  "Usage: hcp-runner providers install <claude|codex|opencode> --config <path>",
  "       hcp-runner providers update <claude|codex|opencode> --config <path>",
  "       hcp-runner providers status --config <path>",
].join("\n");

type ProvidersCommand =
  | { kind: "status"; configPath: string }
  | { kind: "setup"; action: ProviderSetupAction; agent: HcpProviderSetupAgent; configPath: string };

export function parseProvidersCommand(args: string[]): ProvidersCommand {
  const [subcommand, ...rest] = args;
  let configPath: string | undefined;
  const positional: string[] = [];
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index]!;
    if (arg === "--config") {
      const value = rest[++index];
      if (!value || value.startsWith("--")) throw new Error("--config requires a value.");
      configPath = value;
    } else if (arg.startsWith("--")) throw new Error(`Unknown providers argument: ${arg}`);
    else positional.push(arg);
  }
  if (!configPath) throw new Error("--config is required.");
  if (subcommand === "status" && positional.length === 0) return { kind: "status", configPath };
  if ((subcommand === "install" || subcommand === "update") && positional.length === 1) {
    const agent = hcpProviderSetupAgentSchema.safeParse(positional[0]);
    if (!agent.success) throw new Error(`Unknown agent '${positional[0]}'. Choose claude, codex or opencode.`);
    return { kind: "setup", action: subcommand, agent: agent.data, configPath };
  }
  throw new Error("Unknown providers command.");
}

/** Local install, update and status. Sign-in is printed, never run. */
export async function runProvidersCommand(args: string[], home: string, installer: ProviderPackageInstaller = npmPackageInstaller): Promise<number> {
  let command: ProvidersCommand;
  try { command = parseProvidersCommand(args); }
  catch (error: unknown) {
    if (!(error instanceof Error)) throw error;
    console.error(error.message);
    console.error(PROVIDERS_USAGE);
    return 1;
  }
  const config = await loadRunnerConfig(command.configPath);
  const registry = createDefaultHarnessAdapterRegistry();
  try {
    if (command.kind === "status") {
      const snapshots = new ProviderInstanceRegistry(config, await registry.probeProviders(config.provider_instances)).snapshot().providers;
      if (snapshots.length === 0) console.log("No coding agents are configured. Install one with: hcp-runner providers install <claude|codex|opencode> --config <path>");
      for (const provider of snapshots) {
        console.log(`${provider.provider_instance_id} (${provider.driver_kind}): ${provider.installed ? provider.version ?? "installed, version unknown" : "not installed"}; ${provider.status}`);
        if (provider.auth?.login_command) console.log(`  Sign in on this machine: ${provider.auth.login_command}`);
        if (isProviderSetupAgent(provider.driver_kind)) {
          const tested = PROVIDER_RELEASES[provider.driver_kind].version;
          if (reportedReleaseVersion(provider.version) !== tested) {
            console.log(`  Tested version ${tested}: ${shellCommandLine({}, ["hcp-runner", "providers", provider.installed ? "update" : "install", provider.driver_kind, "--config", command.configPath])}`);
          }
        }
      }
      return 0;
    }

    // The running runner holds this configuration in memory; a second writer would be overwritten or refused.
    const ownership = ConnectionOwnership.acquire(connectionDirectory(config.control_plane_url, home));
    if (ownership === "already_running") {
      console.error("HCP is running with this configuration. Press Ctrl+C in its terminal, run this command again, then reconnect. Apps can also install agents remotely when you allow it in provider_setup.");
      return 1;
    }
    try {
      const release = PROVIDER_RELEASES[command.agent];
      const setup = new ProviderSetup({
        config, configPath: command.configPath, installRoot: defaultProviderInstallRoot(home), installer,
        probe: providers => registry.probeProviders(providers),
        commitConfiguration: change => change(),
      });
      console.log(`${command.action === "install" ? "Installing" : "Updating"} ${release.displayName} ${release.version} in ${setup.installDirectory(command.agent)} …`);
      const outcome = await setup.run(command.agent, command.action);
      if (outcome.kind !== "installed") {
        console.error(outcome.message);
        return 1;
      }
      console.log(outcome.changed
        ? `${release.displayName} ${outcome.version} is installed and set in ${command.configPath}.`
        : `${release.displayName} ${outcome.version} is already installed and configured.`);
      console.log(`Status: ${outcome.status}`);
      if (outcome.login_command) console.log(`Sign in on this machine: ${outcome.login_command}`);
      return 0;
    } finally { ownership.release(); }
  } finally { await registry.close(); }
}
