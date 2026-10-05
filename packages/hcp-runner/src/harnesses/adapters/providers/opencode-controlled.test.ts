import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtemp, rm, access, symlink} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, dirname} from "node:path";
import {prepareControlledOpenCode, controlledOpenCodeReference, readControlledOpenCodeReference, assertControlledOpenCodeInventory} from "./opencode-controlled.js";

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
