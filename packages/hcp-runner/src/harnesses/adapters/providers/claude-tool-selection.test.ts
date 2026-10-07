import assert from "node:assert/strict";
import {test} from "node:test";
import {claudeToolSelectionOptions, confirmClaudeToolSelection} from "./claude-tool-selection.js";

test("Claude selection changes builtin availability rather than merely pre-approving tools", () => {
  assert.deepEqual(claudeToolSelectionOptions({native_builtin_tools: ["Read", "Glob", "Grep"]}), {tools: ["Read", "Glob", "Grep"]});
  assert.deepEqual(claudeToolSelectionOptions({native_builtin_tools: []}), {tools: []});
  assert.deepEqual(claudeToolSelectionOptions(undefined), {});
  for (const native_builtin_tools of [["Bash"], ["Read", "Read"], ["mcp__server__write"]])
    assert.throws(() => claudeToolSelectionOptions({native_builtin_tools}), /unique builtin|pattern/);
});
test("Claude tool readback compares exact builtin sets while preserving separate MCP authority", () => {
  const selected = {native_builtin_tools: ["Read", "Glob", "Grep"]};
  assert.deepEqual(confirmClaudeToolSelection(selected, {tools: ["Grep", "Read", "mcp__selected__lookup", "Glob"]}),
    {native_builtin_tools: ["Grep", "Read", "Glob"]});
  assert.deepEqual(confirmClaudeToolSelection({native_builtin_tools: []}, {tools: []}), {native_builtin_tools: []});
  assert.equal(confirmClaudeToolSelection(undefined, {}), undefined);
});
test("missing, broader, incomplete and duplicate native builtin inventories cannot certify selection", () => {
  for (const tools of [undefined, ["Read", "Bash"], [], ["Read", "Read"]])
    assert.throws(() => confirmClaudeToolSelection({native_builtin_tools: ["Read"]}, {tools}), /exact selected/);
});

test("explicit native checklist availability neither admits execution tools nor accepts a substituted inventory", () => {
  const selected = {native_builtin_tools: ["TodoWrite"]};
  assert.deepEqual(claudeToolSelectionOptions(selected), {tools: ["TodoWrite"]});
  assert.deepEqual(confirmClaudeToolSelection(selected, {tools: ["TodoWrite"]}), selected);
  assert.throws(() => confirmClaudeToolSelection(selected, {tools: ["TodoWrite", "Bash"]}), /exact selected/);
  assert.throws(() => confirmClaudeToolSelection(selected, {tools: []}), /exact selected/);
});
