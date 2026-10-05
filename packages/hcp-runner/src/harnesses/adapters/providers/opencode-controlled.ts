import {createHash} from "node:crypto";
import {access, mkdir, mkdtemp, open, realpath, rm} from "node:fs/promises";
import {homedir, tmpdir} from "node:os";
import {join} from "node:path";
import {z} from "zod";
import {HarnessAdapterError} from "../types.js";

const MAX_AUTH_BYTES = 1024 * 1024;
const apiAuthSchema = z.object({type: z.literal("api"), key: z.string().min(1).max(8192),
  metadata: z.record(z.string().max(128), z.string().max(8192)).refine(value => Object.keys(value).length <= 32).optional()}).strict();
const referenceSchema = z.object({session_id: z.string().min(1).max(512), provider_id: z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/),
  account_binding: z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const PREFIX = "hcp-opencode-controlled-v1:";
export const controlledOpenCodeInheritance = {user_settings: false, project_settings: false, hooks: false, mcp_servers: false, plugins: false} as const;

/** Opaque references retain the native account/configuration owner without exposing credentials. */
export function controlledOpenCodeReference(value: z.infer<typeof referenceSchema>): string {
  return PREFIX + Buffer.from(JSON.stringify(referenceSchema.parse(value))).toString("base64url");
}
export function readControlledOpenCodeReference(value: string): z.infer<typeof referenceSchema> | undefined {
  if (!value.startsWith(PREFIX)) return undefined;
  const encoded = value.slice(PREFIX.length);
  if (encoded.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(encoded))
    throw new HarnessAdapterError("native_continuation_binding", "The controlled native conversation reference is invalid.");
  try {
    const decoded = Buffer.from(encoded, "base64url");
    if (decoded.toString("base64url") !== encoded) throw new Error("Noncanonical reference");
    return referenceSchema.parse(JSON.parse(decoded.toString("utf8")));
  } catch {throw new HarnessAdapterError("native_continuation_binding", "The controlled native conversation reference is invalid.");}
}

async function exists(path: string): Promise<boolean> {
  try {await access(path); return true;} catch (failure) {if ((failure as NodeJS.ErrnoException).code === "ENOENT") return false; throw failure;}
}
async function assertManagedPolicyAbsent(env: NodeJS.ProcessEnv): Promise<void> {
  const directory = process.platform === "win32" ? join(env.ProgramData ?? "C:\\ProgramData", "opencode")
    : process.platform === "darwin" ? "/Library/Application Support/opencode" : "/etc/opencode";
  const paths = [join(directory, "opencode.json"), join(directory, "opencode.jsonc")];
  if (process.platform === "darwin") paths.push("/Library/Managed Preferences/ai.opencode.managed.plist");
  // macOS additionally supports per-user MDM preferences. No test-only native bypass is used.
  if (process.platform === "darwin")
    throw new HarnessAdapterError("configuration_isolation_unsupported", "Controlled OpenCode configuration on macOS requires managed-preference verification.");
  if (env.OPENCODE_TEST_MANAGED_CONFIG_DIR || env.OPENCODE_TEST_HOME)
    throw new HarnessAdapterError("configuration_isolation_unsupported", "Native test-only configuration overrides cannot establish controlled configuration ownership.");
  for (const path of paths) if (await exists(path))
    throw new HarnessAdapterError("configuration_isolation_unsupported", "Managed native policy requires explicit compatibility review before controlled configuration can launch.");
}
async function boundedAuthFile(path: string): Promise<string> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(MAX_AUTH_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const {bytesRead} = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break; offset += bytesRead;
    }
    if (offset > MAX_AUTH_BYTES) throw new HarnessAdapterError("native_auth_limit", "Native authentication exceeds its bounded input limit.");
    return buffer.subarray(0, offset).toString("utf8");
  } finally {await file.close();}
}

export async function prepareControlledOpenCode(input: {
  env: NodeJS.ProcessEnv; cwd: string; providerId: string; expectedAccountBinding?: string;
  mcpServers: Record<string, {type: "remote"; url: string; enabled: true}>;
  /** Internal ownership root, injectable for host-level tests; never a client-supplied path. */
  ownershipRoot?: string;
}): Promise<{env: NodeJS.ProcessEnv; accountBinding: string; cleanup(): Promise<void>}> {
  await assertManagedPolicyAbsent(input.env);
  let auth: z.infer<typeof apiAuthSchema>;
  try {
    const source = input.env.OPENCODE_AUTH_CONTENT ?? await boundedAuthFile(join(input.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "opencode", "auth.json"));
    if (Buffer.byteLength(source) > MAX_AUTH_BYTES) throw new Error("Authentication input limit");
    const entries = z.record(z.string(), z.unknown()).parse(JSON.parse(source));
    if (!Object.hasOwn(entries, input.providerId)) throw new Error("Selected authentication unavailable");
    auth = apiAuthSchema.parse(entries[input.providerId]);
  } catch {
    throw new HarnessAdapterError("configuration_isolation_auth_unsupported", "Controlled OpenCode requires a bounded native API credential for the selected provider; remote-config and OAuth authentication are not enabled by this profile.");
  }
  const cwd = await realpath(input.cwd);
  const accountBinding = createHash("sha256").update(JSON.stringify({contract: "opencode-1.18.34-controlled-v1", provider: input.providerId, cwd,
    auth: {type: auth.type, key: auth.key, ...(auth.metadata ? {metadata: Object.fromEntries(Object.entries(auth.metadata).sort(([a], [b]) => a.localeCompare(b)))} : {})}})).digest("hex");
  if (input.expectedAccountBinding && input.expectedAccountBinding !== accountBinding)
    throw new HarnessAdapterError("native_continuation_binding", "The native API account or workspace changed; this retained conversation belongs to its original controlled owner.");
  const base = input.ownershipRoot ?? join(homedir(), ".cache", "harness-control", "opencode-controlled");
  await mkdir(base, {recursive: true, mode: 0o700});
  const stable = join(await realpath(base), accountBinding);
  await mkdir(stable, {recursive: true, mode: 0o700});
  if (await realpath(stable) !== stable)
    throw new HarnessAdapterError("native_storage_binding", "Controlled native storage was redirected outside its owned account path.");
  for (const name of ["data", "state", "cache"]) {
    const directory = join(stable, name);
    await mkdir(directory, {recursive: true, mode: 0o700});
    if (await realpath(directory) !== directory)
      throw new HarnessAdapterError("native_storage_binding", "Controlled native storage contains a redirected account directory.");
  }
  const configRoot = await mkdtemp(join(tmpdir(), "hcp-opencode-config-"));
  try {await mkdir(join(configRoot, "home"), {mode: 0o700});}
  catch (failure) {await rm(configRoot, {recursive: true, force: true}); throw failure;}
  const env: NodeJS.ProcessEnv = {...input.env};
  for (const key of Object.keys(env)) if (key.startsWith("OPENCODE_")) delete env[key];
  Object.assign(env, {
    // Native Config.directories still includes ~/.opencode with project settings disabled.
    // Use the real OS home mechanism, never its test-only override.
    HOME: join(configRoot, "home"), USERPROFILE: join(configRoot, "home"),
    XDG_CONFIG_HOME: join(configRoot, "config"), XDG_DATA_HOME: join(stable, "data"), XDG_STATE_HOME: join(stable, "state"), XDG_CACHE_HOME: join(stable, "cache"),
    OPENCODE_AUTH_CONTENT: JSON.stringify({[input.providerId]: auth}),
    OPENCODE_CONFIG_CONTENT: JSON.stringify({enabled_providers: [input.providerId], plugin: [], mcp: input.mcpServers, instructions: [], autoupdate: false, share: "disabled"}),
    OPENCODE_DISABLE_PROJECT_CONFIG: "true", OPENCODE_PURE: "true", OPENCODE_DISABLE_DEFAULT_PLUGINS: "true", OPENCODE_DISABLE_CLAUDE_CODE: "true",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "true", OPENCODE_DISABLE_AUTOUPDATE: "true",
  });
  // Credential/account data is deliberately retained for conversation resume. Only the owned,
  // freshly allocated configuration root is temporary and removed after its process closes.
  return {env, accountBinding, cleanup: () => rm(configRoot, {recursive: true, force: true})};
}

/** Validate native inventory without returning raw configuration, credentials or bridge URLs. */
export function assertControlledOpenCodeInventory(value: unknown, providerId: string,
  mcpServers: Record<string, {type: "remote"; url: string; enabled: true}>): void {
  const parsed = z.object({enabled_providers: z.array(z.string()), plugin: z.array(z.unknown()).optional(),
    instructions: z.array(z.string()).optional(), mcp: z.record(z.string(), z.unknown()).optional()}).safeParse(value);
  if (!parsed.success || parsed.data.enabled_providers.length !== 1 || parsed.data.enabled_providers[0] !== providerId ||
      parsed.data.plugin?.length || parsed.data.instructions?.length ||
      JSON.stringify(Object.keys(parsed.data.mcp ?? {}).sort()) !== JSON.stringify(Object.keys(mcpServers).sort()))
    throw new HarnessAdapterError("native_configuration_mismatch", "OpenCode did not confirm the controlled provider/configuration inventory.");
  for (const [name, requested] of Object.entries(mcpServers)) {
    const actual = z.object({type: z.literal("remote"), url: z.string(), enabled: z.literal(true)}).safeParse(parsed.data.mcp?.[name]);
    if (!actual.success || actual.data.url !== requested.url)
      throw new HarnessAdapterError("mcp_scope_mismatch", "OpenCode did not confirm an owned MCP attachment.");
  }
}
