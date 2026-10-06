import assert from "node:assert/strict";
import test from "node:test";
import {detachClaudeMcp, initializeClaudeMcp} from "./claude-mcp-controls.js";

const configurations = {first: {type: "http" as const, url: "http://localhost/first"}, second: {type: "http" as const, url: "http://localhost/second"}};
for (const mode of ["confirmed", "missing-receipt", "missing-inventory"] as const) test(`Claude dynamic MCP registration (${mode}) requires both native receipt and exact inventory`, async () => {
  let applied = false;
  const native = {
    async mcpServerStatus() {return applied && mode !== "missing-inventory" ? Object.entries(configurations).map(([name, config]) => ({name, config, status: "connected" as const})) : [];},
    async setMcpServers(value: unknown) {assert.deepEqual(value, configurations); applied = true;
      return {added: mode === "missing-receipt" ? [] : ["first", "second"], removed: [], errors: {}};},
  };
  if (mode === "confirmed") await initializeClaudeMcp(native, configurations);
  else await assert.rejects(initializeClaudeMcp(native, configurations), {code: "native_mcp_registration_unknown"});
});
function fixture(options: {foreign?: boolean; failed?: boolean; stale?: boolean; partial?: boolean; rebound?: boolean} = {}) {
  let applied = false, calls = 0, requested: unknown;
  return {get calls() {return calls;}, get requested() {return requested;},
    async mcpServerStatus() {return (options.foreign ? ["first", "second", "foreign"] : applied && !options.stale ? ["second"] : ["first", "second"])
      .map(name => ({name, status: "connected" as const, config: {type: "http" as const, url: options.rebound ? "http://localhost/foreign" : `http://localhost/${name}`}}));},
    async setMcpServers(value: unknown) {calls++; requested = value; applied = true;
      return {added: [], removed: options.partial ? [] : ["first"], errors: options.failed ? {first: "private upstream diagnostic"} : {}};}};
}
test("Claude MCP detach preserves the remaining native configuration and requires removal readback", async () => {
  const native = fixture();
  assert.deepEqual(await detachClaudeMcp(native, configurations, ["first"]), {second: configurations.second});
  assert.deepEqual(native.requested, {second: configurations.second}); assert.equal(native.calls, 1);
});
test("foreign native MCP inventories and unknown removal names refuse before mutation", async () => {
  const native = fixture({foreign: true});
  await assert.rejects(detachClaudeMcp(native, configurations, ["first"]), {code: "native_mcp_detach_unknown"});
  await assert.rejects(detachClaudeMcp(native, configurations, ["foreign"]), {code: "native_mcp_detach_binding"});
  await assert.rejects(detachClaudeMcp(native, configurations, ["first", "first"]), {code: "native_mcp_detach_binding"});
  assert.equal(native.calls, 0);
});
test("a same-named foreign MCP endpoint refuses before mutation", async () => {
  const native = fixture({rebound: true});
  await assert.rejects(detachClaudeMcp(native, configurations, ["first"]), {code: "native_mcp_detach_unknown"});
  assert.equal(native.calls, 0);
});
for (const mode of ["failed", "stale", "partial"] as const) test(`Claude MCP ${mode} removal cannot claim native detach`, async () => {
  const native = fixture({[mode]: true});
  await assert.rejects(detachClaudeMcp(native, configurations, ["first"]), {code: "native_mcp_detach_unknown"});
  assert.equal(native.calls, 1);
});
