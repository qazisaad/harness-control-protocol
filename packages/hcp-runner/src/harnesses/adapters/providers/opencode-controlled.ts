import {createHash} from "node:crypto";
import {access, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile} from "node:fs/promises";
import {pathToFileURL} from "node:url";
import {homedir, tmpdir, userInfo} from "node:os";
import {join} from "node:path";
import {z} from "zod";
import {HarnessAdapterError} from "../types.js";

const MAX_AUTH_BYTES = 1024 * 1024;
const apiAuthSchema = z.object({type: z.literal("api"), key: z.string().min(1).max(8192),
  metadata: z.record(z.string().max(128), z.string().max(8192)).refine(value => Object.keys(value).length <= 32).optional()}).strict();
const referenceSchema = z.object({session_id: z.string().min(1).max(512), provider_id: z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/),
  account_binding: z.string().regex(/^[a-f0-9]{64}$/), native_work: z.literal(true).optional()}).strict();
const PREFIX = "hcp-opencode-controlled-v1:";
export const controlledOpenCodeInheritance = {user_settings: false, project_settings: false, hooks: false, mcp_servers: false, plugins: false} as const;

/** Session ask rules are not inherited by native subagents. Install the same
 * authority at agent configuration scope before any background task can run. */
export function openCodeAgentPermission(policy: "ask" | "auto_edits" | "full_access") {
  return {"*": policy === "full_access" ? "allow" : "ask",
    ...(policy === "auto_edits" ? {edit: "allow"} : {}),
    question: policy === "full_access" ? "deny" : "allow", task: "allow"};
}
export function assertOpenCodeAgentPermission(value: unknown, policy: "ask" | "auto_edits" | "full_access"): void {
  const agents = z.array(z.object({name: z.string(), permission: z.array(z.object({permission: z.string(), pattern: z.string(), action: z.enum(["allow", "ask", "deny"])}))})).parse(value);
  if (!agents.length) throw new HarnessAdapterError("native_policy_mismatch", "OpenCode did not confirm native agent permissions.");
  for (const agent of agents) {
    let wildcard = -1;
    agent.permission.forEach((rule, index) => {if (rule.permission === "*" && rule.pattern === "*") wildcard = index;});
    const expected = Object.entries(openCodeAgentPermission(policy)).map(([permission, action]) => ({permission, pattern: "*", action}));
    const actual = agent.permission.slice(wildcard, wildcard + expected.length);
    if (wildcard < 0 || JSON.stringify(actual) !== JSON.stringify(expected) ||
        agent.permission.slice(wildcard + expected.length).some(rule => rule.permission !== "external_directory"))
      throw new HarnessAdapterError("native_policy_mismatch", "OpenCode native agents did not preserve the authorized background policy.");
  }
}

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
/** Match the pinned native 1.18.34 config/managed.ts, including OS-user MDM policy independent of HOME. */
export function openCodeManagedConfigPaths(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, username: string): string[] {
  const directory = platform === "win32" ? join(env.ProgramData ?? "C:\\ProgramData", "opencode")
    : platform === "darwin" ? "/Library/Application Support/opencode" : "/etc/opencode";
  const paths = [join(directory, "opencode.json"), join(directory, "opencode.jsonc")];
  if (platform === "darwin") paths.push(join("/Library/Managed Preferences", username || "user", "ai.opencode.managed.plist"),
    "/Library/Managed Preferences/ai.opencode.managed.plist");
  return paths;
}
async function assertManagedPolicyAbsent(env: NodeJS.ProcessEnv): Promise<void> {
  let username = "user";
  if (process.platform === "darwin") {
    try {username = userInfo().username || "user";} catch { /* Native uses the same fallback. */ }
  }
  const paths = openCodeManagedConfigPaths(process.platform, env, username);
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
  backgroundPolicy?: "ask" | "auto_edits" | "full_access";
  /** Generated runner-owned source, never a consumer-supplied plugin or path. */
  ownedToolPlugin?: string;
  ownedPolicyPlugin?: string;
}): Promise<{env: NodeJS.ProcessEnv; accountBinding: string; anonymous?: true; ownedPlugin?: {url: string; verify(): Promise<void>}; ownedPolicyPlugin?: {url: string; verify(): Promise<void>}; cleanup(): Promise<void>}> {
  await assertManagedPolicyAbsent(input.env);
  let auth: z.infer<typeof apiAuthSchema> | undefined;
  try {
    const source = input.env.OPENCODE_AUTH_CONTENT ?? await boundedAuthFile(join(input.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "opencode", "auth.json"))
      .catch(failure => {if ((failure as NodeJS.ErrnoException).code === "ENOENT") return "{}"; throw failure;});
    if (Buffer.byteLength(source) > MAX_AUTH_BYTES) throw new Error("Authentication input limit");
    const entries = z.record(z.string(), z.unknown()).parse(JSON.parse(source));
    if (Object.hasOwn(entries, input.providerId)) auth = apiAuthSchema.parse(entries[input.providerId]);
    else if (input.providerId !== "opencode" || input.env.OPENCODE_API_KEY)
      throw new Error("Selected authentication unavailable");
  } catch {
    throw new HarnessAdapterError("configuration_isolation_auth_unsupported", "Controlled OpenCode requires a bounded native API credential for the selected provider; remote-config and OAuth authentication are not enabled by this profile.");
  }
  const cwd = await realpath(input.cwd);
  const accountBinding = createHash("sha256").update(JSON.stringify({contract: "opencode-1.18.34-controlled-v1", provider: input.providerId, cwd,
    auth: auth ? {type: auth.type, key: auth.key, ...(auth.metadata ? {metadata: Object.fromEntries(Object.entries(auth.metadata).sort(([a], [b]) => a.localeCompare(b)))} : {})}
      : {type: "anonymous", native_default_public: true}})).digest("hex");
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
  const configRoot = await realpath(await mkdtemp(join(tmpdir(), "hcp-opencode-config-")));
  try {await mkdir(join(configRoot, "home"), {mode: 0o700});}
  catch (failure) {await rm(configRoot, {recursive: true, force: true}); throw failure;}
  let ownedPlugin: {url: string; verify(): Promise<void>} | undefined;
  if (input.ownedToolPlugin !== undefined) {
    try {
      if (!input.backgroundPolicy || !input.ownedToolPlugin || Buffer.byteLength(input.ownedToolPlugin) > 8 * 1024 * 1024)
        throw new HarnessAdapterError("native_tool_plugin_binding", "Owned tools require bounded generated background plugin source.");
      const path = join(configRoot, "owned-tools.js"), digest = createHash("sha256").update(input.ownedToolPlugin).digest("hex");
      await writeFile(path, input.ownedToolPlugin, {mode: 0o600, flag: "wx"});
      ownedPlugin = {url: pathToFileURL(path).href, async verify() {
        if (await realpath(path) !== path || createHash("sha256").update(await readFile(path)).digest("hex") !== digest)
          throw new HarnessAdapterError("native_tool_plugin_binding", "The owned native tool source changed.");
      }};
    } catch (failure) {await rm(configRoot, {recursive: true, force: true});throw failure;}
  }
  let ownedPolicyPlugin: {url: string; verify(): Promise<void>} | undefined;
  if (input.ownedPolicyPlugin !== undefined) {
    try {
      if (!input.backgroundPolicy || !input.ownedPolicyPlugin || Buffer.byteLength(input.ownedPolicyPlugin) > 64 * 1024)
        throw new HarnessAdapterError("native_policy_plugin_binding", "Owned policy requires bounded generated background prompt-hook source.");
      const path = join(configRoot, "owned-policy.js"), digest = createHash("sha256").update(input.ownedPolicyPlugin).digest("hex");
      await writeFile(path, input.ownedPolicyPlugin, {mode: 0o600, flag: "wx"});
      ownedPolicyPlugin = {url: pathToFileURL(path).href, async verify() {
        if (await realpath(path) !== path || createHash("sha256").update(await readFile(path)).digest("hex") !== digest)
          throw new HarnessAdapterError("native_policy_plugin_binding", "The owned native prompt policy source changed.");
      }};
    } catch (failure) {await rm(configRoot, {recursive: true, force: true});throw failure;}
  }
  const env: NodeJS.ProcessEnv = {...input.env};
  for (const key of Object.keys(env)) if (key.startsWith("OPENCODE_")) delete env[key];
  Object.assign(env, {
    // Native Config.directories still includes ~/.opencode with project settings disabled.
    // Use the real OS home mechanism, never its test-only override.
    HOME: join(configRoot, "home"), USERPROFILE: join(configRoot, "home"),
    XDG_CONFIG_HOME: join(configRoot, "config"), XDG_DATA_HOME: join(stable, "data"), XDG_STATE_HOME: join(stable, "state"), XDG_CACHE_HOME: join(stable, "cache"),
    // Pinned native OpenCode selects its own public/free catalog without a credential.
    // Keep that mode distinct from every API owner; never manufacture an API key.
    OPENCODE_AUTH_CONTENT: JSON.stringify(auth ? {[input.providerId]: auth} : {}),
    OPENCODE_CONFIG_CONTENT: JSON.stringify({enabled_providers: [input.providerId], plugin: [...(ownedPlugin ? [ownedPlugin.url] : []), ...(ownedPolicyPlugin ? [ownedPolicyPlugin.url] : [])], mcp: input.mcpServers, instructions: [], autoupdate: false, share: "disabled",
      ...(input.backgroundPolicy ? {permission: openCodeAgentPermission(input.backgroundPolicy), subagent_depth: 1} : {})}),
    // Native pure mode disables even explicitly selected local plugins. All discovery roots
    // remain isolated and the exact owned plugin inventory is checked before dispatch.
    OPENCODE_DISABLE_PROJECT_CONFIG: "true", OPENCODE_PURE: ownedPlugin || ownedPolicyPlugin ? "false" : "true", OPENCODE_DISABLE_DEFAULT_PLUGINS: "true", OPENCODE_DISABLE_CLAUDE_CODE: "true",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "true", OPENCODE_DISABLE_AUTOUPDATE: "true",
  });
  // Credential/account data is deliberately retained for conversation resume. Only the owned,
  // freshly allocated configuration root is temporary and removed after its process closes.
  return {env, accountBinding, ...(!auth ? {anonymous: true as const} : {}), ...(ownedPlugin ? {ownedPlugin} : {}), ...(ownedPolicyPlugin ? {ownedPolicyPlugin} : {}), cleanup: () => rm(configRoot, {recursive: true, force: true})};
}

/** Validate native inventory without returning raw configuration, credentials or bridge URLs. */
export function assertControlledOpenCodeInventory(value: unknown, providerId: string,
  mcpServers: Record<string, {type: "remote"; url: string; enabled: true}>, ownedPlugin?: string, ownedPolicyPlugin?: string): void {
  const parsed = z.object({enabled_providers: z.array(z.string()), plugin: z.array(z.unknown()).optional(),
    instructions: z.array(z.string()).optional(), mcp: z.record(z.string(), z.unknown()).optional()}).safeParse(value);
  if (!parsed.success || parsed.data.enabled_providers.length !== 1 || parsed.data.enabled_providers[0] !== providerId ||
      JSON.stringify(parsed.data.plugin ?? []) !== JSON.stringify([...(ownedPlugin ? [ownedPlugin] : []), ...(ownedPolicyPlugin ? [ownedPolicyPlugin] : [])]) || parsed.data.instructions?.length ||
      JSON.stringify(Object.keys(parsed.data.mcp ?? {}).sort()) !== JSON.stringify(Object.keys(mcpServers).sort()))
    throw new HarnessAdapterError("native_configuration_mismatch", "OpenCode did not confirm the controlled provider/configuration inventory.");
  for (const [name, requested] of Object.entries(mcpServers)) {
    const actual = z.object({type: z.literal("remote"), url: z.string(), enabled: z.literal(true)}).safeParse(parsed.data.mcp?.[name]);
    if (!actual.success || actual.data.url !== requested.url)
      throw new HarnessAdapterError("mcp_scope_mismatch", "OpenCode did not confirm an owned MCP attachment.");
  }
}
