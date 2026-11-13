import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import {
  type HcpProviderSetup,
  type HcpProviderSetupAgent,
  type HcpProviderSetupOutcome,
  type HcpProviderSetupRequestPayload,
  type HcpProviderSetupResultPayload,
} from "@harness-control/protocol";
import { z } from "zod";

import {
  ProviderInstanceConfigSchema,
  RunnerConfigUpdateError,
  updateRunnerConfigFile,
  type ProviderInstanceConfig,
  type RunnerConfig,
} from "../config/index.js";
import { HarnessSessionError } from "../harnesses/index.js";
import { PROVIDER_RELEASES, reportedReleaseVersion, type ProviderRelease } from "../harnesses/provider-releases.js";
import { ProviderInstanceRegistry, type ProviderDriverStatus } from "../host/provider-registry.js";
import type { RunnerStateStore } from "../state/index.js";

export type ProviderSetupAction = HcpProviderSetupRequestPayload["action"];

/** Installs one exact package into an empty prefix directory. The only boundary that reaches the network. */
export type ProviderPackageInstaller = (input: { packageSpec: string; prefix: string }) => Promise<void>;

/** A failed package install or an unusable runner-owned install folder. */
export class ProviderInstallError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProviderInstallError";
  }
}

/** The installed command did not report the tested release. */
class ProviderVerificationError extends Error {
  override name = "ProviderVerificationError";
}

const NPM_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const execFileAsync = promisify(execFile);

/** Runs the user's npm with an argument array: no shell, no sudo, no global install. */
export const npmPackageInstaller: ProviderPackageInstaller = async ({ packageSpec, prefix }) => {
  try {
    await execFileAsync("npm", ["install", "--prefix", prefix, "--global=false", "--save-exact", "--no-audit", "--no-fund",
      "--no-update-notifier", "--loglevel=error", packageSpec], { timeout: NPM_INSTALL_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
  } catch (error: unknown) {
    if (!(error instanceof Error)) throw error;
    const stderr = "stderr" in error && typeof error.stderr === "string" ? error.stderr.trim() : "";
    const detail = errorCode(error) === "ENOENT" ? "npm was not found. Install Node.js with npm, then try again." : stderr.slice(-800) || error.message;
    throw new ProviderInstallError(`npm could not install ${packageSpec}: ${detail}`, { cause: error });
  }
};

/** Runner-owned agent installs live beside the runner's other machine state, one folder per agent version. */
export function defaultProviderInstallRoot(home: string = homedir()): string {
  return join(home, ".hcp-runner", "providers");
}

export type ProviderSetupOptions = {
  config: RunnerConfig;
  configPath: string;
  installRoot: string;
  installer: ProviderPackageInstaller;
  probe: (providers: ProviderInstanceConfig[]) => Promise<ProviderDriverStatus[]>;
  /** Runs the configuration change behind the boundary that excludes session starts. */
  commitConfiguration: <T>(change: () => Promise<T>) => Promise<T>;
  platform?: NodeJS.Platform;
};

/**
 * The one owner of installing a tested agent release and pointing the runner's provider instances at it.
 * The local CLI and remote setup both call `run`; neither has its own install logic.
 */
export class ProviderSetup {
  readonly #options: ProviderSetupOptions;
  readonly #queues = new Map<HcpProviderSetupAgent, Promise<unknown>>();

  constructor(options: ProviderSetupOptions) {
    this.#options = options;
  }

  /** Setups of one agent run one at a time; different agents may install concurrently. */
  run(agent: HcpProviderSetupAgent, action: ProviderSetupAction): Promise<HcpProviderSetupOutcome> {
    const result = (this.#queues.get(agent) ?? Promise.resolve()).then(() => this.#run(PROVIDER_RELEASES[agent], action));
    this.#queues.set(agent, result.then(() => undefined, () => undefined));
    return result;
  }

  /** Where the tested release of `agent` is, or would be, installed. */
  installDirectory(agent: HcpProviderSetupAgent): string {
    return join(this.#options.installRoot, agent, PROVIDER_RELEASES[agent].version);
  }

  async #run(release: ProviderRelease, action: ProviderSetupAction): Promise<HcpProviderSetupOutcome> {
    const { config, probe } = this.#options;
    if ((this.#options.platform ?? process.platform) === "win32") {
      return { kind: "refused", reason: "unsupported_platform", message: "Runner-managed agent installs are not available on Windows yet. Install the agent yourself." };
    }
    const instances = config.provider_instances.filter(provider => provider.driver_kind === release.agent);
    const current = await probe(instances);
    if (action === "install") {
      const installed = current.find(status => status.installed);
      if (installed) {
        return { kind: "refused", reason: "already_installed", message: reportedReleaseVersion(installed.version) === release.version
          ? `${release.displayName} ${release.version} is already installed.`
          : `${release.displayName} is already installed${installed.version ? ` (${installed.version})` : ""}. Use update to switch to the tested version ${release.version}.` };
      }
    }
    if (current.length > 0 && current.every(status => status.installed && reportedReleaseVersion(status.version) === release.version)) {
      return this.#describe(release, current, false);
    }

    let executable: string;
    try { executable = await this.#ensureInstalled(release, path => this.#verify(release, instances[0], path)); }
    catch (error: unknown) {
      if (error instanceof ProviderVerificationError) return { kind: "failed", reason: "verification_failed", message: error.message.slice(0, 1000) };
      if (!(error instanceof ProviderInstallError)) throw error;
      return { kind: "failed", reason: "install_failed", message: error.message.slice(0, 1000) };
    }

    try {
      await this.#options.commitConfiguration(() => updateRunnerConfigFile(this.#options.configPath, config, raw => withExecutable(raw, release, executable)));
    } catch (error: unknown) {
      if (!(error instanceof HarnessSessionError || error instanceof RunnerConfigUpdateError)) throw error;
      return { kind: "failed", reason: "configuration_failed", message: `${release.displayName} ${release.version} is installed at ${executable}, but the runner configuration was not changed: ${error.message}`.slice(0, 1000) };
    }
    return this.#describe(release, await probe(config.provider_instances.filter(provider => provider.driver_kind === release.agent)), true);
  }

  /** Proves a command is the tested release, using the agent's own probe, before anything points at it. */
  async #verify(release: ProviderRelease, instance: ProviderInstanceConfig | undefined, executable: string): Promise<void> {
    const candidate = ProviderInstanceConfigSchema.parse({ ...(instance ?? defaultInstance(release)), executable_path: executable });
    const [verified] = await this.#options.probe([candidate]);
    if (!verified?.installed || reportedReleaseVersion(verified.version) !== release.version) {
      throw new ProviderVerificationError(`${executable} reported ${verified?.version ?? "no version"} instead of ${release.version}.${verified?.message ? ` ${verified.message}` : ""}`);
    }
  }

  async #ensureInstalled(release: ProviderRelease, verify: (executable: string) => Promise<void>): Promise<string> {
    const directory = join(this.#options.installRoot, release.agent, release.version);
    const executable = (prefix: string): string => join(prefix, "node_modules", ".bin", release.binary);
    try {
      if (await exists(directory)) {
        if (!await exists(executable(directory))) throw new ProviderInstallError(`${directory} has no ${release.binary} command. Remove that folder and try again.`);
        await verify(executable(directory));
        return executable(directory);
      }
      await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
      // npm installs into a private folder that is verified, then renamed into place,
      // so an existing version folder always holds a whole, working install.
      const staging = `${directory}.${randomUUID()}.partial`;
      try {
        await mkdir(staging, { mode: 0o700 });
        await this.#options.installer({ packageSpec: `${release.npmPackage}@${release.version}`, prefix: staging });
        if (!await exists(executable(staging))) throw new ProviderInstallError(`${release.npmPackage}@${release.version} did not provide the ${release.binary} command.`);
        await verify(executable(staging));
        try { await rename(staging, directory); }
        catch (error: unknown) {
          // Another runner on this machine finished the same version first; its folder is equivalent.
          if (!["EEXIST", "ENOTEMPTY"].includes(errorCode(error) ?? "")) throw error;
        }
      } finally { await rm(staging, { recursive: true, force: true }); }
      return executable(directory);
    } catch (error: unknown) {
      if (!(error instanceof Error) || errorCode(error) === undefined) throw error;
      throw new ProviderInstallError(`Cannot write ${directory}: ${error.message}`, { cause: error });
    }
  }

  #describe(release: ProviderRelease, statuses: ProviderDriverStatus[], changed: boolean): HcpProviderSetupOutcome {
    const instances = this.#options.config.provider_instances.filter(provider => provider.driver_kind === release.agent);
    const snapshot = ProviderInstanceRegistry.fromConfig({ ...this.#options.config, provider_instances: instances }, statuses).snapshot().providers[0];
    const version = reportedReleaseVersion(snapshot?.version) ?? release.version;
    const status = snapshot?.status ?? "unknown";
    const loginCommand = status === "unauthenticated" ? snapshot?.auth?.login_command : undefined;
    return { kind: "installed", version, changed, status, ...(loginCommand ? { login_command: loginCommand } : {}) };
  }
}

/** Remote setup: the local policy gate, durable receipts and the published snapshot. */
export class RemoteProviderSetup {
  readonly #config: RunnerConfig;
  readonly #setup: ProviderSetup | undefined;
  readonly #stateStore: RunnerStateStore;
  readonly #pending = new Map<string, { payloadHash: string; result: Promise<HcpProviderSetupResultPayload> }>();

  /** `setup` is absent when the runner has no configuration file to record an install in. */
  constructor(config: RunnerConfig, setup: ProviderSetup | undefined, stateStore: RunnerStateStore) {
    this.#config = config;
    this.#setup = setup;
    this.#stateStore = stateStore;
  }

  snapshot(): HcpProviderSetup {
    const agents = this.#setup ? this.#config.provider_setup?.remote_agents ?? [] : [];
    return { agents: agents.map(agent => ({ agent, version: PROVIDER_RELEASES[agent].version })) };
  }

  /**
   * The same request id always yields the same result; a lost result is recovered by resending that id.
   * `replayed` marks a result that was recorded earlier, so nothing changed on this call.
   */
  async execute(requestId: string, request: HcpProviderSetupRequestPayload): Promise<{ result: HcpProviderSetupResultPayload; replayed: boolean }> {
    const payloadHash = createHash("sha256").update(JSON.stringify([request.agent, request.action, request.expires_at])).digest("hex");
    const reused = { replayed: true, result: this.#result(requestId, request, { kind: "refused", reason: "request_id_reused",
      message: "This request id was already used for a different setup request. Send a new id." }) };
    const receipt = this.#stateStore.getProviderSetupReceipt(requestId);
    if (receipt) return receipt.payloadHash === payloadHash ? { result: receipt.result, replayed: true } : reused;
    const pending = this.#pending.get(requestId);
    if (pending) return pending.payloadHash === payloadHash ? { result: await pending.result, replayed: true } : reused;
    const result = this.#settle(requestId, request, payloadHash);
    this.#pending.set(requestId, { payloadHash, result });
    try { return { result: await result, replayed: false }; }
    finally { this.#pending.delete(requestId); }
  }

  async #settle(requestId: string, request: HcpProviderSetupRequestPayload, payloadHash: string): Promise<HcpProviderSetupResultPayload> {
    const result = this.#result(requestId, request, await this.#outcome(request));
    this.#stateStore.setProviderSetupReceipt(requestId, { payloadHash, settledAt: new Date().toISOString(), result });
    return result;
  }

  async #outcome(request: HcpProviderSetupRequestPayload): Promise<HcpProviderSetupOutcome> {
    const allowed = this.snapshot().agents;
    if (!this.#setup || allowed.length === 0) {
      return { kind: "refused", reason: "remote_setup_disabled", message: "Remote agent setup is off on this machine. Its user can enable it with provider_setup.remote_agents in the runner configuration." };
    }
    if (!allowed.some(entry => entry.agent === request.agent)) {
      return { kind: "refused", reason: "agent_not_allowed", message: `This machine does not allow remote setup of ${PROVIDER_RELEASES[request.agent].displayName}.` };
    }
    if (Date.parse(request.expires_at) <= Date.now()) {
      return { kind: "refused", reason: "request_expired", message: "The setup request expired before the runner received it. Read capabilities and try again." };
    }
    return this.#setup.run(request.agent, request.action);
  }

  #result(requestId: string, request: HcpProviderSetupRequestPayload, outcome: HcpProviderSetupOutcome): HcpProviderSetupResultPayload {
    return { request_id: requestId, agent: request.agent, action: request.action, outcome };
  }
}

function defaultInstance(release: ProviderRelease): Record<string, unknown> {
  return { id: `${release.agent}-local`, driver_kind: release.agent, display_name: release.displayName };
}

/** Points every instance of the agent at the installed command, adding one instance when none exists. */
function withExecutable(raw: Record<string, unknown>, release: ProviderRelease, executable: string): Record<string, unknown> {
  const providers = z.array(z.record(z.string(), z.unknown())).parse(raw.provider_instances ?? []);
  const configured = providers.some(provider => provider.driver_kind === release.agent);
  return {
    ...raw,
    provider_instances: configured
      ? providers.map(provider => provider.driver_kind === release.agent ? { ...provider, executable_path: executable } : provider)
      : [...providers, { ...defaultInstance(release), executable_path: executable }],
  };
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; }
  catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
