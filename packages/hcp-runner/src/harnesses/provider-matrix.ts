import {
  harnessExecutionProfileCapabilitiesSchema,
  harnessProviderSnapshotSchema,
  type HarnessExecutionCapabilities,
} from "@harness-control/protocol";
import { isDeepStrictEqual } from "node:util";
import { CODEX_RETAINED_PROFILE_VERSIONS, codexExecutionCapabilities } from "./adapters/providers/codex.js";
import { nativeExecutionCapabilities } from "./adapters/providers/native-turn.js";
import {
  OPENCODE_CONTROLLED_PROFILE_VERSION,
  OPENCODE_MINIMUM_VERSION,
  openCodeExecutionCapabilities,
} from "./adapters/providers/opencode.js";
import { PROVIDER_RELEASES, type ProviderRelease } from "./provider-releases.js";

/**
 * Renders the provider support matrix in docs/native-providers.md from the same
 * pure capability builders that each adapter's probe publishes. Nothing here
 * launches a provider or reads credentials.
 */

export const PROVIDER_MATRIX_START = "<!-- generated:provider-matrix:start -->";
export const PROVIDER_MATRIX_END = "<!-- generated:provider-matrix:end -->";

type ProviderCapabilitySource = {
  name: string;
  /** Versions for which a ready probe publishes these capabilities. */
  readyVersions: string;
  /** Versions for which the probe also publishes `execution_profiles`. */
  profileVersions: string;
  capabilities: HarnessExecutionCapabilities;
  /** What a ready probe publishes outside the profile versions; absent when no version gate exists. */
  otherVersionCapabilities?: HarnessExecutionCapabilities;
  /** The tested release `hcp-runner providers install` and remote setup install. */
  release: ProviderRelease;
};

const executionCapabilitiesSchema = harnessProviderSnapshotSchema.shape.execution_capabilities.unwrap();

function requireCapabilities(name: string, capabilities: HarnessExecutionCapabilities | undefined): HarnessExecutionCapabilities {
  if (!capabilities) throw new Error(`${name} publishes no execution capabilities for its declared profile version.`);
  return capabilities;
}

function providerSources(): ProviderCapabilitySource[] {
  const openCodeMinimum = `${OPENCODE_MINIMUM_VERSION.major}.${OPENCODE_MINIMUM_VERSION.minor}.${OPENCODE_MINIMUM_VERSION.patch}`;
  const codexProfileVersion = CODEX_RETAINED_PROFILE_VERSIONS.at(-1)!;
  return [
    {
      name: "Codex",
      readyVersions: "any (authenticated)",
      profileVersions: CODEX_RETAINED_PROFILE_VERSIONS.map(version => `\`codex-cli ${version}\``).join(", "),
      capabilities: codexExecutionCapabilities(`codex-cli ${codexProfileVersion}`),
      // The probe passes `undefined` when `codex --version` prints nothing, which no gate accepts.
      otherVersionCapabilities: codexExecutionCapabilities(undefined),
      release: PROVIDER_RELEASES.codex,
    },
    {
      name: "Claude",
      readyVersions: "any (authenticated)",
      profileVersions: "any",
      capabilities: nativeExecutionCapabilities("claude"),
      release: PROVIDER_RELEASES.claude,
    },
    {
      name: "OpenCode",
      readyVersions: `\`${openCodeMinimum}\`+ within major version ${OPENCODE_MINIMUM_VERSION.major}`,
      profileVersions: `\`${OPENCODE_CONTROLLED_PROFILE_VERSION}\``,
      capabilities: requireCapabilities("OpenCode", openCodeExecutionCapabilities(OPENCODE_CONTROLLED_PROFILE_VERSION)),
      otherVersionCapabilities: requireCapabilities("OpenCode", openCodeExecutionCapabilities(openCodeMinimum)),
      release: PROVIDER_RELEASES.opencode,
    },
  ];
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

function formatBytes(bytes: number): string {
  const mebibytes = bytes / (1024 * 1024);
  return Number.isInteger(mebibytes) ? `${mebibytes} MiB` : `${bytes} bytes`;
}

function formatValue(value: unknown, key = ""): string {
  if (value === undefined) return "—";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") return key.endsWith("bytes") ? formatBytes(value) : String(value);
  if (typeof value === "string") return `\`${value}\``;
  if (Array.isArray(value)) {
    if (value.length === 0) return "none";
    return value.some(item => typeof item === "object" && item !== null)
      ? value.map(item => formatValue(item)).join("<br>")
      : value.map(item => formatValue(item)).join(", ");
  }
  if (typeof value === "object" && value !== null)
    return Object.entries(value).map(([entryKey, entry]) => `${entryKey}: ${formatValue(entry, entryKey)}`).join("; ");
  throw new Error(`Unsupported capability value: ${String(value)}`);
}

/** Lists the provider-level fields that disappear or change outside the profile versions. */
function otherVersionDifference(source: ProviderCapabilitySource): string {
  const other = source.otherVersionCapabilities as Record<string, unknown> | undefined;
  if (!other) return "no version gate";
  const gated = source.capabilities as Record<string, unknown>;
  const fields = [...new Set([...Object.keys(gated), ...Object.keys(other)])];
  const removed = fields.filter(field => field in gated && !(field in other));
  const changed = fields.filter(field => !removed.includes(field) && !isDeepStrictEqual(gated[field], other[field]));
  const parts = [
    ...(removed.length ? [`without ${removed.map(field => `\`${field}\``).join(", ")}`] : []),
    ...(changed.length ? [`with different ${changed.map(field => `\`${field}\``).join(", ")}`] : []),
  ];
  return parts.length ? `same, ${parts.join("; ")}` : "same";
}

function table(header: string[], rows: string[][]): string {
  return [
    `| ${header.map(escapeCell).join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map(row => `| ${row.map(escapeCell).join(" | ")} |`),
  ].join("\n");
}

/** Rows follow the protocol schema's field order; fields no provider declares are left out. */
function capabilityRows<T extends object>(fields: string[], columns: T[]): string[][] {
  return fields
    .filter(field => columns.some(column => field in column))
    .map(field => [`\`${field}\``, ...columns.map(column => formatValue((column as Record<string, unknown>)[field], field))]);
}

export function renderProviderMatrix(): string {
  const sources = providerSources();
  for (const source of sources) {
    executionCapabilitiesSchema.parse(source.capabilities);
    if (source.otherVersionCapabilities) executionCapabilitiesSchema.parse(source.otherVersionCapabilities);
  }

  const versions = table(
    ["Provider", "Probe reports ready for", "Execution profiles published for", "Other ready versions publish", "Runner installs"],
    sources.map(source => [source.name, source.readyVersions, source.profileVersions, otherVersionDifference(source),
      `\`${source.release.npmPackage}@${source.release.version}\``]),
  );

  const providerFields = Object.keys(executionCapabilitiesSchema.shape).filter(field => field !== "execution_profiles");
  const providers = table(
    ["Capability", ...sources.map(source => source.name)],
    capabilityRows(providerFields, sources.map(source => source.capabilities)),
  );

  const profiles = sources.flatMap(source =>
    (source.capabilities.execution_profiles ?? []).map(profile => ({name: `${source.name} \`${profile.id}\``, profile})));
  const profileFields = Object.keys(harnessExecutionProfileCapabilitiesSchema.shape).filter(field => field !== "id");
  const profileTable = table(
    ["Profile capability", ...profiles.map(entry => entry.name)],
    capabilityRows(profileFields, profiles.map(entry => entry.profile)),
  );

  return [
    PROVIDER_MATRIX_START,
    "<!-- Generated from the runner's capability declarations by `npm run docs:providers`. Do not edit by hand. -->",
    "",
    "### Versions",
    "",
    versions,
    "",
    "### Provider capabilities",
    "",
    providers,
    "",
    "### Execution profiles",
    "",
    profileTable,
    PROVIDER_MATRIX_END,
  ].join("\n");
}

/** Replaces the single marked region; throws when the markers are missing, repeated or out of order. */
export function replaceProviderMatrix(document: string, matrix: string = renderProviderMatrix()): string {
  const start = document.indexOf(PROVIDER_MATRIX_START);
  const end = document.indexOf(PROVIDER_MATRIX_END);
  if (start < 0 || end < start
    || document.indexOf(PROVIDER_MATRIX_START, start + 1) >= 0 || document.indexOf(PROVIDER_MATRIX_END, end + 1) >= 0)
    throw new Error(`Expected exactly one ${PROVIDER_MATRIX_START} ... ${PROVIDER_MATRIX_END} region.`);
  return document.slice(0, start) + matrix + document.slice(end + PROVIDER_MATRIX_END.length);
}
