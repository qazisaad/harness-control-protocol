import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtemp, rm, access, symlink, stat, writeFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {tmpdir} from "node:os";
import {join, dirname} from "node:path";
import {prepareControlledOpenCode, controlledOpenCodeReference, readControlledOpenCodeReference, assertControlledOpenCodeInventory, openCodeAgentPermission, assertOpenCodeAgentPermission, openCodeManagedConfigPaths} from "./opencode-controlled.js";

test("controlled macOS checks OS-user and machine managed preferences independently of isolated HOME", () => {
  assert.deepEqual(openCodeManagedConfigPaths("darwin", {HOME: "/isolated", USER: "untrusted"}, "actual-user"), [
    "/Library/Application Support/opencode/opencode.json", "/Library/Application Support/opencode/opencode.jsonc",
    "/Library/Managed Preferences/actual-user/ai.opencode.managed.plist", "/Library/Managed Preferences/ai.opencode.managed.plist"]);
  assert.ok(openCodeManagedConfigPaths("darwin", {}, "").includes("/Library/Managed Preferences/user/ai.opencode.managed.plist"));
});

test("owned native plugin is private, hash checked and the sole allowed external plugin", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "hcp-owned-plugin-config-"));
  let prepared: Awaited<ReturnType<typeof prepareControlledOpenCode>> | undefined;
  try {
    prepared = await prepareControlledOpenCode({cwd, providerId: "opencode", ownershipRoot: join(cwd, "owned"), mcpServers: {},
      backgroundPolicy: "ask", ownedToolPlugin: "export default async () => ({});", env: {OPENCODE_AUTH_CONTENT: "{}"}});
    assert.ok(prepared.ownedPlugin);await prepared.ownedPlugin.verify();
    const path = fileURLToPath(prepared.ownedPlugin.url), config = JSON.parse(prepared.env.OPENCODE_CONFIG_CONTENT!);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(prepared.env.OPENCODE_PURE, "false");assert.equal(prepared.env.OPENCODE_DISABLE_DEFAULT_PLUGINS, "true");
    assert.equal(prepared.env.OPENCODE_DISABLE_PROJECT_CONFIG, "true");
    assert.deepEqual(config.plugin, [prepared.ownedPlugin.url]);
    assertControlledOpenCodeInventory(config, "opencode", {}, prepared.ownedPlugin.url);
    assert.throws(() => assertControlledOpenCodeInventory({...config, plugin: [prepared!.ownedPlugin!.url, "external"]}, "opencode", {}, prepared!.ownedPlugin!.url));
    assert.throws(() => assertControlledOpenCodeInventory({...config, plugin: []}, "opencode", {}, prepared!.ownedPlugin!.url));
    await writeFile(path, "export default async () => ({ changed: true });");
    await assert.rejects(prepared.ownedPlugin.verify(), /source changed/);
    await prepared.cleanup();await assert.rejects(access(path), {code: "ENOENT"});
    await assert.rejects(prepareControlledOpenCode({cwd, providerId: "opencode", ownershipRoot: join(cwd, "owned"), mcpServers: {},
      ownedToolPlugin: "export default () => ({});", env: {OPENCODE_AUTH_CONTENT: "{}"}}), /background plugin/);
  } finally {await prepared?.cleanup();await rm(cwd, {recursive: true, force: true});}
});

test("background policies cover native agent authority rather than relying on session ask inheritance", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "hcp-agent-policy-test-"));
  let prepared: Awaited<ReturnType<typeof prepareControlledOpenCode>> | undefined;
  try {
    prepared = await prepareControlledOpenCode({cwd, providerId: "go", ownershipRoot: join(cwd, "owned"), mcpServers: {},
      backgroundPolicy: "ask", env: {OPENCODE_AUTH_CONTENT: JSON.stringify({go: {type: "api", key: "fixture"}})}});
    const config = JSON.parse(prepared.env.OPENCODE_CONFIG_CONTENT!);
    assert.deepEqual(config.permission, openCodeAgentPermission("ask")); assert.equal(config.subagent_depth, 1);
    for (const policy of ["ask", "auto_edits", "full_access"] as const) {
      const permission = Object.entries(openCodeAgentPermission(policy)).map(([permission, action]) => ({permission, pattern: "*", action}));
      const agent = {name: "general", permission: [{permission: "bash", pattern: "*", action: "allow"}, ...permission]};
      assertOpenCodeAgentPermission([agent], policy);
      assert.throws(() => assertOpenCodeAgentPermission([{...agent, permission: [...agent.permission, {permission: "bash", pattern: "*", action: "allow"}]}], policy), /background policy/);
      assert.throws(() => assertOpenCodeAgentPermission([{...agent, permission: agent.permission.slice(0, 1)}], policy), /background policy/);
    }
    assert.throws(() => assertOpenCodeAgentPermission([], "ask"), /agent permissions/);
  } finally {await prepared?.cleanup(); await rm(cwd, {recursive: true, force: true});}
});

test("owned policy hook has separate private custody and an exact combined plugin inventory", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "hcp-owned-policy-config-"));
  let prepared: Awaited<ReturnType<typeof prepareControlledOpenCode>> | undefined;
  try {
    const input = {cwd, providerId: "opencode", ownershipRoot: join(cwd, "owned"), mcpServers: {},
      backgroundPolicy: "ask" as const, ownedToolPlugin: "export default async () => ({});",
      ownedPolicyPlugin: "export default async () => ({ 'chat.message': async () => {} });", env: {OPENCODE_AUTH_CONTENT: "{}"}};
    prepared = await prepareControlledOpenCode(input);
    assert.ok(prepared.ownedPlugin); assert.ok(prepared.ownedPolicyPlugin);
    await prepared.ownedPlugin.verify(); await prepared.ownedPolicyPlugin.verify();
    const path = fileURLToPath(prepared.ownedPolicyPlugin.url), config = JSON.parse(prepared.env.OPENCODE_CONFIG_CONTENT!);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.notEqual(prepared.ownedPolicyPlugin.url, prepared.ownedPlugin.url);
    assertControlledOpenCodeInventory(config, "opencode", {}, prepared.ownedPlugin.url, prepared.ownedPolicyPlugin.url);
    for (const plugin of [[prepared.ownedPolicyPlugin.url], [prepared.ownedPolicyPlugin.url, prepared.ownedPlugin.url], [...config.plugin, "external"]])
      assert.throws(() => assertControlledOpenCodeInventory({...config, plugin}, "opencode", {}, prepared!.ownedPlugin!.url, prepared!.ownedPolicyPlugin!.url));
    await writeFile(path, "export default async () => ({});");
    await assert.rejects(prepared.ownedPolicyPlugin.verify(), /source changed/);
    await prepared.ownedPlugin.verify();
    const {backgroundPolicy: _backgroundPolicy, ...withoutBackground} = input;
    await assert.rejects(prepareControlledOpenCode(withoutBackground), /background/);
  } finally {await prepared?.cleanup(); await rm(cwd, {recursive: true, force: true});}
});

test("controlled OpenCode retains only the selected API credential and stable account data, and removes temporary configuration", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "hcp-controlled-config-test-"));
  let first: Awaited<ReturnType<typeof prepareControlledOpenCode>> | undefined, second: typeof first;
  try {
    const env = {PATH: process.env.PATH, OPENCODE_AUTH_CONTENT: JSON.stringify({go: {type: "api", key: "fixture-key"}, remote: {type: "wellknown", key: "remote", token: "fixture-remote"}}),
      OPENCODE_CONFIG: "/inherited/config", OPENCODE_CONFIG_DIR: "/inherited/plugins", OPENCODE_DB: "/inherited/account.db"};
    const input = {env, cwd, providerId: "go", ownershipRoot: join(cwd, "owned"), mcpServers: {bridge: {type: "remote" as const, url: "http://127.0.0.1/owned", enabled: true as const}}};
    first = await prepareControlledOpenCode(input);
    second = await prepareControlledOpenCode({...input, expectedAccountBinding: first.accountBinding});
    assert.equal(first.env.XDG_DATA_HOME, second.env.XDG_DATA_HOME);
    assert.notEqual(first.env.XDG_CONFIG_HOME, second.env.XDG_CONFIG_HOME);
    assert.equal(first.env.OPENCODE_CONFIG, undefined); assert.equal(first.env.OPENCODE_CONFIG_DIR, undefined); assert.equal(first.env.OPENCODE_DB, undefined);
    assert.deepEqual(Object.keys(JSON.parse(first.env.OPENCODE_AUTH_CONTENT!)), ["go"]);
    const config = JSON.parse(first.env.OPENCODE_CONFIG_CONTENT!);
    assertControlledOpenCodeInventory(config, "go", input.mcpServers);
    assert.equal(first.env.OPENCODE_PURE, "true"); assert.equal(first.env.OPENCODE_DISABLE_DEFAULT_PLUGINS, "true");
    assert.equal(first.env.HOME, first.env.USERPROFILE);
    assert.equal(dirname(first.env.HOME!), dirname(first.env.XDG_CONFIG_HOME!));
    assert.notEqual(first.env.HOME, second.env.HOME);
    const temporary = dirname(first.env.XDG_CONFIG_HOME!);
    await first.cleanup(); await assert.rejects(access(temporary), {code: "ENOENT"});
    await access(first.env.XDG_DATA_HOME!);
    await assert.rejects(prepareControlledOpenCode({...input, expectedAccountBinding: first.accountBinding,
      env: {...env, OPENCODE_AUTH_CONTENT: JSON.stringify({go: {type: "api", key: "changed-account"}})}}), /account or workspace changed/);
  } finally {await first?.cleanup(); await second?.cleanup(); await rm(cwd, {recursive: true, force: true});}
});

test("controlled OpenCode refuses remote-config/OAuth owners and redirected account storage before native dispatch", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "hcp-controlled-owner-test-"));
  let prepared: Awaited<ReturnType<typeof prepareControlledOpenCode>> | undefined;
  try {
    const base = {cwd, providerId: "go", ownershipRoot: join(cwd, "owned"), mcpServers: {}};
    for (const type of ["wellknown", "oauth"]) await assert.rejects(prepareControlledOpenCode({...base,
      env: {OPENCODE_AUTH_CONTENT: JSON.stringify({go: {type, key: "fixture", access: "fixture"}})}}), /native API credential/);
    await assert.rejects(prepareControlledOpenCode({...base, env: {OPENCODE_TEST_MANAGED_CONFIG_DIR: cwd}}), /test-only/);
    const input = {...base, env: {OPENCODE_AUTH_CONTENT: JSON.stringify({go: {type: "api", key: "fixture"}})}};
    prepared = await prepareControlledOpenCode(input);
    const data = prepared.env.XDG_DATA_HOME!;
    await rm(data, {recursive: true}); await symlink(cwd, data, "junction");
    await assert.rejects(prepareControlledOpenCode(input), /redirected account directory/);
  } finally {await prepared?.cleanup(); await rm(cwd, {recursive: true, force: true});}
});

test("controlled native references and inventory preserve exact ownership without exposing raw native configuration", () => {
  const value = {session_id: "native-session", provider_id: "go", account_binding: "a".repeat(64)};
  assert.deepEqual(readControlledOpenCodeReference(controlledOpenCodeReference(value)), value);
  assert.equal(readControlledOpenCodeReference("legacy-native-session"), undefined);
  assert.throws(() => readControlledOpenCodeReference("hcp-opencode-controlled-v1:not-json"), /reference is invalid/);
  assert.throws(() => assertControlledOpenCodeInventory({enabled_providers: ["go"], plugin: ["external"], mcp: {}}, "go", {}), /inventory/);
  assert.throws(() => assertControlledOpenCodeInventory({enabled_providers: ["go"], mcp: {foreign: {}}}, "go", {}), /inventory/);
  assert.throws(() => assertControlledOpenCodeInventory({enabled_providers: ["go"], mcp: {bridge: {type: "remote", enabled: true, url: "http://foreign"}}}, "go",
    {bridge: {type: "remote", enabled: true, url: "http://owned"}}), /owned MCP/);
});

test("anonymous native public owners retain separate storage and cannot resume API-owned conversations", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "hcp-anonymous-config-test-"));
  const owners: Awaited<ReturnType<typeof prepareControlledOpenCode>>[] = [];
  const input = {cwd, providerId: "opencode", ownershipRoot: join(cwd, "owned"), mcpServers: {}, env: {OPENCODE_AUTH_CONTENT: "{}"}};
  try {
    const anonymous = await prepareControlledOpenCode(input); owners.push(anonymous);
    assert.equal(anonymous.anonymous, true);
    assert.deepEqual(JSON.parse(anonymous.env.OPENCODE_AUTH_CONTENT!), {});
    const retained = await prepareControlledOpenCode({...input, expectedAccountBinding: anonymous.accountBinding}); owners.push(retained);
    assert.equal(retained.env.XDG_DATA_HOME, anonymous.env.XDG_DATA_HOME);
    const api = await prepareControlledOpenCode({...input, env: {OPENCODE_AUTH_CONTENT: JSON.stringify({opencode: {type: "api", key: "fixture"}})}}); owners.push(api);
    assert.equal(api.anonymous, undefined); assert.notEqual(api.accountBinding, anonymous.accountBinding);
    await assert.rejects(prepareControlledOpenCode({...input, expectedAccountBinding: api.accountBinding}), /account or workspace changed/);
    await assert.rejects(prepareControlledOpenCode({...input, env: {OPENCODE_AUTH_CONTENT: "not-json"}}), /native API credential/);
    await assert.rejects(prepareControlledOpenCode({...input, env: {OPENCODE_AUTH_CONTENT: JSON.stringify({opencode: {type: "oauth"}})}}), /native API credential/);
    await assert.rejects(prepareControlledOpenCode({...input, env: {...input.env, OPENCODE_API_KEY: "ignored-secret"}}), /native API credential/);
    await assert.rejects(prepareControlledOpenCode({...input, providerId: "another-provider"}), /native API credential/);
  } finally {await Promise.all(owners.map(owner => owner.cleanup())); await rm(cwd, {recursive: true, force: true});}
});
