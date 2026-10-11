import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";

import { loadRunnerConfig, ProviderInstanceConfigSchema, RunnerConfigSchema, type RunnerConfig } from "./config/index.js";
import { createDefaultHarnessAdapterRegistry } from "./harnesses/adapters/registry.js";
import { loadRunnerCredential, requestConnectionToken, RunnerAuthorizationRejected, normalizeControlPlaneUrl, pairWithReferenceControlPlane, writeRunnerCredentials } from "./pairing/index.js";

import { ALREADY_RUNNING, ConnectionOwnership, connectionDirectory } from "./ownership.js";

export type ConnectOptions = {
  controlPlaneUrl: string;
  configPath: string;
  connectionDirectory: string;
  identityPath: string;
  providers?: string[] | undefined;
  pair: boolean;
  openBrowser: boolean;
};

export function parseConnectOptions(args: string[], home: string = homedir()): ConnectOptions {
  if (!args[0]) throw new Error("Usage: hcp-runner connect <control-plane-url> [--config path] [--providers codex,claude,opencode] [--pair] [--no-browser]");
  const controlPlaneUrl = normalizeControlPlaneUrl(args[0]);
  const directory = connectionDirectory(controlPlaneUrl, home);
  const options: ConnectOptions = { controlPlaneUrl, connectionDirectory: directory, identityPath: join(home, ".hcp-runner", "identity.json"), configPath: join(directory, "runner.json"), pair: false, openBrowser: true };
  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--pair") options.pair = true;
    else if (arg === "--no-browser") options.openBrowser = false;
    else if (arg === "--config" || arg === "--providers") {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
      if (arg === "--config") options.configPath = resolve(value);
      else options.providers = parseProviders(value);
    } else throw new Error(`Unknown connect argument: ${arg}`);
  }
  return options;
}

function parseProviders(value: string): string[] {
  const providers = value.split(",").map(item => item.trim()).filter(Boolean);
  if (!providers.length || providers.some(item => !["codex", "claude", "opencode"].includes(item)) || new Set(providers).size !== providers.length) {
    throw new Error("Choose one or more agents: codex,claude,opencode (comma-separated, without duplicates).");
  }
  return providers;
}

export async function openApprovalBrowser(value: string): Promise<boolean> {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid pairing approval URL.");
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url.href] : [url.href];
  return new Promise(resolveOpened => {
    const child = spawn(command, args, { stdio: "ignore", timeout: 5_000 });
    child.once("error", () => resolveOpened(false));
    child.once("exit", code => resolveOpened(code === 0));
  });
}

async function saveJson(path: string, config: RunnerConfig | string): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temp, path);
  } finally { await rm(temp, { force: true }); }
}

async function installationIdentity(path: string, existingRunnerId?: string): Promise<string> {
  const schema = z.object({ runner_id: z.string().min(1).max(200) }).strict();
  if (!existsSync(path)) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ runner_id: existingRunnerId ?? `runner-${randomUUID()}` }), { mode: 0o600, flag: "wx" });
      try { await link(temporary, path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    } finally { await rm(temporary, { force: true }); }
  }
  return schema.parse(JSON.parse(await readFile(path, "utf8"))).runner_id;
}

export async function connectMachine(options: ConnectOptions, run: (path: string) => Promise<number>): Promise<number> {
  const ownership = ConnectionOwnership.acquire(options.connectionDirectory);
  if (ownership === "already_running") {
    if (options.pair || options.providers || options.configPath !== join(options.connectionDirectory, "runner.json")) {
      throw new Error("This connection is already in use. The requested setup changes were not applied. Press Ctrl+C in the original HCP terminal, then run this command again.");
    }
    console.log(ALREADY_RUNNING);
    return 0;
  }
  const setupAbort = new AbortController();
  const cancelSetup = (): void => setupAbort.abort(new Error("Setup cancelled. Run the command again when ready."));
  process.once("SIGINT", cancelSetup);
  process.once("SIGTERM", cancelSetup);
  try {
    const locationPath = join(options.connectionDirectory, "config-path.json");
    const defaultPath = join(options.connectionDirectory, "runner.json");
    const savedPath = existsSync(locationPath) ? z.string().min(1).parse(JSON.parse(await readFile(locationPath, "utf8"))) : existsSync(defaultPath) ? defaultPath : undefined;
    if (savedPath && options.configPath !== defaultPath && options.configPath !== savedPath) {
      throw new Error(`This machine already has a configuration for this server: ${savedPath}. Run the standard connect command to reuse it.`);
    }
    const configPath = savedPath ?? options.configPath;
    await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
    const existing = existsSync(configPath);
    let config: RunnerConfig;
    if (existing) {
      config = await loadRunnerConfig(configPath);
      if (normalizeControlPlaneUrl(config.control_plane_url) !== options.controlPlaneUrl) throw new Error("This config belongs to another control plane. Use its URL or a different --config path.");
      if (await installationIdentity(options.identityPath, config.runner_id) !== config.runner_id) throw new Error("This configuration belongs to a different HCP installation. Use this installation’s saved configuration; do not copy machine credentials between installations.");
    } else {
      const runnerId = await installationIdentity(options.identityPath);
      config = RunnerConfigSchema.parse({ runner_id: runnerId, host_id: hostname(), control_plane_url: options.controlPlaneUrl,
        credentials_path: join(dirname(configPath), "credentials.json"), state_path: join(dirname(configPath), "state.json"),
        workspaces: [], workspace_management: { allowed_roots: [parse(homedir()).root] }, provider_instances: [] });
    }
    const bundled = ["codex", "claude", "opencode"].filter(driver => !config.provider_instances.some(p => p.driver_kind === driver))
      .map(driver => ProviderInstanceConfigSchema.parse({ id: `${driver}-local`, driver_kind: driver, display_name: driver === "claude" ? "Claude Code" : driver === "codex" ? "Codex" : "OpenCode" }));
    const candidates = [...config.provider_instances, ...bundled];
    const registry = createDefaultHarnessAdapterRegistry();
    let statuses;
    try { statuses = await registry.probeProviders(candidates); }
    finally { await registry.close(); }
    console.log("Coding agents on this computer:");
    for (const status of statuses) console.log(`  ${status.driver_kind}: ${!status.installed ? "not installed" : status.authStatus === "unauthenticated" ? "sign in required" : status.status ?? "unknown"}`);
    const installed = [...new Set(statuses.filter(status => status.installed).map(status => status.driver_kind))];
    // Discovery belongs to the runner; execution choices belong to the control plane.
    // Keep --providers as an explicit automation override, never an interactive prompt.
    const selected = options.providers ?? installed;
    console.log("Choose which coding agents to use in your control plane after connecting.");
    if (options.providers && selected.some(driver => !installed.includes(driver))) throw new Error("A selected agent is not installed. Install it before connecting.");
    const providers = candidates.filter(p => config.provider_instances.some(saved => saved.id === p.id) || installed.includes(p.driver_kind))
      .map(p => ({...p, enabled: selected.includes(p.driver_kind)}));
    const updated = RunnerConfigSchema.parse({...config, provider_instances: providers});
    if (!existing || JSON.stringify(updated) !== JSON.stringify(config)) await saveJson(configPath, updated);
    config = updated;
    await saveJson(locationPath, configPath);
    setupAbort.signal.throwIfAborted();
    const credential = await loadRunnerCredential(config);
    let needsPairing = !credential || options.pair;
    if (credential && !needsPairing) {
      try { await requestConnectionToken(config, credential, setupAbort.signal); }
      catch (error) {
        if (!(error instanceof RunnerAuthorizationRejected)) throw error;
        needsPairing = true;
        console.log("This machine's access was removed or expired. Approve it again in your browser to reconnect. Your folders and settings are saved.");
      }
    }
    if (needsPairing) {
      console.log("Approve this computer in your browser. No folder is added automatically. Use your control plane to register existing folders.");
      const pairing = await pairWithReferenceControlPlane({ controlPlaneUrl: config.control_plane_url, runnerId: config.runner_id, hostId: config.host_id ?? config.runner_id, signal: setupAbort.signal,
        onPairingCode: async code => {
          console.log(`Approval link: ${code.pairing_url}\nFallback pairing code: ${code.pairing_code}`);
          if (options.openBrowser && !await openApprovalBrowser(code.pairing_url)) console.log("Could not open a browser. Open the approval link yourself.");
          console.log("Waiting for approval…");
        } });
      config.credentials_path ??= join(dirname(configPath), "credentials.json");
      await writeRunnerCredentials(config.credentials_path, pairing.credential);
      await saveJson(configPath, config);
    }
    process.removeListener("SIGINT", cancelSetup);
    process.removeListener("SIGTERM", cancelSetup);
    console.log(`Configuration: ${configPath}\nKeep this terminal open. Press Ctrl+C to disconnect; run the same command to reconnect.`);
    return await run(configPath);
  } finally {
    process.removeListener("SIGINT", cancelSetup);
    process.removeListener("SIGTERM", cancelSetup);
    ownership.release();
  }
}
