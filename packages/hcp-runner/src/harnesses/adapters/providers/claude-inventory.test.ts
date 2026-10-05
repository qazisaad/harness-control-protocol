import assert from "node:assert/strict";
import {test} from "node:test";
import {hasInheritedClaudePlugins} from "./claude-inventory.js";

test("bundled Claude plugins cannot disguise an inherited plugin inventory", () => {
  assert.equal(hasInheritedClaudePlugins([]), false);
  assert.equal(hasInheritedClaudePlugins([{name: "native", path: "builtin", source: "native@builtin"}]), false);
  for (const plugin of [{name: "native", path: "/plugins/native", source: "native@builtin"},
    {name: "native", path: "builtin", source: "native@marketplace"}, {name: "native", path: "builtin"}, "native"]) {
    assert.equal(hasInheritedClaudePlugins([plugin]), true);
  }
});
