import { createHash, randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";

import { loadRunnerConfig, ProviderInstanceConfigSchema, RunnerConfigSchema, type RunnerConfig } from "./config/index.js";
import { createDefaultHarnessAdapterRegistry } from "./harnesses/adapters/registry.js";
import { loadRunnerCredential, normalizeControlPlaneUrl, pairWithReferenceControlPlane, writeRunnerCredentials } from "./pairing/index.js";

export type ConnectOptions = {
  controlPlaneUrl: string;
  configPath: string;
  providers?: string[];
  pair: boolean;
  openBrowser: boolean;
};

export function parseConnectOptions(args: string[], home: string = homedir()): ConnectOptions {
  if (!args[0]) throw new Error("Usage: hcp-runner connect <control-plane-url> [--config path] [--providers codex,claude,opencode] [--pair] [--no-browser]");
  const controlPlaneUrl = normalizeControlPlaneUrl(args[0]);
  const key = createHash("sha256").update(controlPlaneUrl).digest("hex").slice(0, 16);
  const options: ConnectOptions = { controlPlaneUrl, configPath: join(home, ".hcp-runner", "connections", key, "runner.json"), pair: false, openBrowser: true };
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

async function saveConfig(path: string, config: RunnerConfig): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temp, path);
  } finally { await rm(temp, { force: true }); }
}

export async function connectMachine(options: ConnectOptions, run: (path: string) => Promise<number>): Promise<number> {
  const configPath = options.configPath;
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  const lockPath = `${configPath}.lock`;
  let lock;
  try { lock = await open(lockPath, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new Error(`This connection is already in use. Stop its runner first. If it crashed, remove ${lockPath} after confirming it is stopped.`);
  }
  await lock.writeFile(String(process.pid));
  await lock.close();
  const release = (): void => { if (existsSync(lockPath)) unlinkSync(lockPath); };
  process.once("exit", release);
  const setupAbort = new AbortController();
  const cancelSetup = (): void => setupAbort.abort(new Error("Setup cancelled. Run the command again when ready."));
  process.once("SIGINT", cancelSetup);
  process.once("SIGTERM", cancelSetup);
  try {
    const existing = existsSync(configPath);
    let config: RunnerConfig;
    if (existing) {
      config = await loadRunnerConfig(configPath);
      if (normalizeControlPlaneUrl(config.control_plane_url) !== options.controlPlaneUrl) throw new Error("This config belongs to another control plane. Use its URL or a different --config path.");
      if (options.providers && options.providers.slice().sort().join(",") !== config.provider_instances.filter(provider => provider.enabled).map(provider => provider.driver_kind).sort().join(",")) {
        throw new Error("This connection already has different agent settings. Edit its config to change them; reconnect preserves existing settings.");
      }
    } else {
      const providers = ["codex", "claude", "opencode"].map(driver => ProviderInstanceConfigSchema.parse({ id: `${driver}-local`, driver_kind: driver, display_name: driver === "claude" ? "Claude Code" : driver === "codex" ? "Codex" : "OpenCode" }));
      console.log("Checking installed coding agents…");
      const statuses = await createDefaultHarnessAdapterRegistry().probeProviders(providers);
      for (const status of statuses) console.log(`  ${status.driver_kind}: ${!status.installed ? "not installed" : status.authStatus === "unauthenticated" ? "sign in required" : status.status ?? "unknown"}${status.message ? ` — ${status.message}` : ""}`);
      const installed = statuses.filter(status => status.installed).map(status => status.driver_kind);
      let selected = options.providers;
      if (!selected && process.stdin.isTTY && process.stdout.isTTY && installed.length) {
        const prompt = createInterface({ input: process.stdin, output: process.stdout });
        prompt.once("SIGINT", cancelSetup);
        try { selected = parseProviders((await prompt.question(`Agents to enable [${installed.join(",")}]: `, { signal: setupAbort.signal })).trim() || installed.join(",")); }
        finally { prompt.close(); }
      }
      selected ??= installed;
      if (!selected.length) throw new Error("No coding agents found. Install and sign in to an agent, then run this command again.");
      if (selected.some(driver => !installed.includes(driver))) throw new Error("A selected agent is not installed. Install it before connecting.");
      const identity = randomUUID();
      config = RunnerConfigSchema.parse({ runner_id: `runner-${identity}`, host_id: hostname(), control_plane_url: options.controlPlaneUrl,
        credentials_path: join(dirname(configPath), "credentials.json"), state_path: join(dirname(configPath), "state.json"),
        workspaces: [], workspace_management: { allowed_roots: [parse(homedir()).root] }, provider_instances: providers.filter(provider => selected.includes(provider.driver_kind)) });
      await saveConfig(configPath, config);
    }
    setupAbort.signal.throwIfAborted();
    const credential = await loadRunnerCredential(config);
    if (!credential || options.pair) {
      console.log("Approve this computer in your browser. You can then register existing folders in P2A; no folder is added automatically.");
      const pairing = await pairWithReferenceControlPlane({ controlPlaneUrl: config.control_plane_url, runnerId: config.runner_id, hostId: config.host_id ?? config.runner_id, signal: setupAbort.signal,
        onPairingCode: async code => {
          console.log(`Approval link: ${code.pairing_url}\nFallback pairing code: ${code.pairing_code}`);
          if (options.openBrowser && !await openApprovalBrowser(code.pairing_url)) console.log("Could not open a browser. Open the approval link yourself.");
          console.log("Waiting for approval…");
        } });
      config.credentials_path ??= join(dirname(configPath), "credentials.json");
      await writeRunnerCredentials(config.credentials_path, pairing.credential);
      await saveConfig(configPath, config);
    }
    process.removeListener("SIGINT", cancelSetup);
    process.removeListener("SIGTERM", cancelSetup);
    console.log(`Configuration: ${configPath}\nKeep this terminal open. Press Ctrl+C to disconnect; run the same command to reconnect.`);
    return await run(configPath);
  } finally {
    process.removeListener("SIGINT", cancelSetup);
    process.removeListener("SIGTERM", cancelSetup);
    process.removeListener("exit", release);
    release();
  }
}
