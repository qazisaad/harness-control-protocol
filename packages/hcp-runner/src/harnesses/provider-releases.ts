import { HCP_PROVIDER_SETUP_AGENTS, type HcpProviderSetupAgent } from "@harness-control/protocol";
import { CODEX_RETAINED_PROFILE_VERSIONS } from "./adapters/providers/codex.js";
import { OPENCODE_CONTROLLED_PROFILE_VERSION } from "./adapters/providers/opencode.js";

/**
 * The single table of coding agents this runner release can install: the official npm package, the
 * binary it provides and exactly one tested version. The CLI, remote setup, capability snapshots and
 * the generated provider docs all read it. Codex and OpenCode pins are the newest versions their
 * adapters publish execution profiles for, so a runner-installed agent always passes its probe gate.
 */
export type ProviderRelease = {
  agent: HcpProviderSetupAgent;
  displayName: string;
  npmPackage: string;
  binary: string;
  version: string;
};

/** Claude Code has no probe version gate; this is the release the native acceptance runs used. */
const CLAUDE_TESTED_VERSION = "2.1.289";

export const PROVIDER_RELEASES: { readonly [Agent in HcpProviderSetupAgent]: ProviderRelease & { agent: Agent } } = {
  claude: { agent: "claude", displayName: "Claude Code", npmPackage: "@anthropic-ai/claude-code", binary: "claude", version: CLAUDE_TESTED_VERSION },
  codex: { agent: "codex", displayName: "Codex", npmPackage: "@openai/codex", binary: "codex", version: CODEX_RETAINED_PROFILE_VERSIONS.at(-1)! },
  opencode: { agent: "opencode", displayName: "OpenCode", npmPackage: "opencode-ai", binary: "opencode", version: OPENCODE_CONTROLLED_PROFILE_VERSION },
};

export function isProviderSetupAgent(driverKind: string): driverKind is HcpProviderSetupAgent {
  return (HCP_PROVIDER_SETUP_AGENTS as readonly string[]).includes(driverKind);
}

/** Extracts the release number from a probe's version line, e.g. `codex-cli 0.161.0` or `2.1.289 (Claude Code)`. */
export function reportedReleaseVersion(versionLine: string | undefined): string | undefined {
  return /(?:^|[^\d.])v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?![\d.])/.exec(versionLine ?? "")?.[1];
}
