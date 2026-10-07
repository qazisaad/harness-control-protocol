import assert from "node:assert/strict";
import {test} from "node:test";
import {assertOpenCodeSessionPolicy, permissionRules, openCodeOrderedRules} from "./opencode-policy.js";

test("OpenCode appended policies restore restrictions over earlier broad and edit grants", () => {
  for (const background of [false, true]) for (const source of ["ask", "auto_edits", "full_access"] as const)
    for (const target of ["ask", "auto_edits", "full_access"] as const) {
      assertOpenCodeSessionPolicy([...permissionRules(source, background), ...permissionRules(target, background)], target, background);
    }
});
test("OpenCode native policy proof refuses retained grants outside its complete rule vocabulary", () => {
  const policy = permissionRules("ask");
  for (const extra of [
    {permission: "bash", pattern: "*", action: "allow"},
    {permission: "edit", pattern: "/secret/*", action: "allow"},
    {permission: "edit", pattern: "*", action: "allow"},
    {permission: "task", pattern: "*", action: "allow"},
    {permission: "question", pattern: "*", action: "deny"},
  ]) assert.throws(() => assertOpenCodeSessionPolicy([...policy, extra], "ask"), /complete authorized/);
  assert.throws(() => assertOpenCodeSessionPolicy(Array(4097).fill(policy[0]), "ask"), /complete authorized/);
});

const ordered = {permission_rules: [
  {permission: "*", pattern: "*", action: "deny" as const},
  {permission: "read", pattern: "*", action: "allow" as const},
  {permission: "read", pattern: "*.env", action: "ask" as const},
  {permission: "read", pattern: "*.env.example", action: "allow" as const},
  {permission: "task", pattern: "*", action: "deny" as const},
]};
test("ordered permissions preserve duplicate overrides and require complete exact readback", () => {
  const rules = openCodeOrderedRules("ask", false, ordered);
  assert.deepEqual(rules, ordered.permission_rules);assert.notEqual(rules, ordered.permission_rules);
  assertOpenCodeSessionPolicy(rules, "ask", false, ordered);
  for (const altered of [[...rules].reverse(), rules.slice(0, -1), [...rules, {permission: "read", pattern: "*.env", action: "allow"}],
    rules.map((rule, index) => index === 2 ? {...rule, pattern: "*.env.*"} : rule)])
    assert.throws(() => assertOpenCodeSessionPolicy(altered, "ask", false, ordered), /complete authorized/);
});
test("ordered root rules refuse uncertain task ownership, undeclared names and incompatible authority", () => {
  for (const approval of ["auto_edits", "full_access"] as const) assert.throws(() => openCodeOrderedRules(approval, false, ordered), {code: "approval_options_unsupported"});
  assert.deepEqual(openCodeOrderedRules("ask", true, ordered), ordered.permission_rules);
  assert.throws(() => openCodeOrderedRules("ask", true, {permission_rules: ordered.permission_rules.map((rule, index) => index === 0 ? {...rule, action: "ask"} : rule)}), /deny-all seed/);
  assert.throws(() => openCodeOrderedRules("ask", false, {permission_rules: [...ordered.permission_rules,
    {permission: "future_tool", pattern: "*", action: "allow"}]}), /declared permissions/);
  for (const rules of [[{permission: "*", pattern: "*", action: "ask" as const}], [...ordered.permission_rules, {permission: "*", pattern: "*", action: "allow" as const}],
    [...ordered.permission_rules, {permission: "task", pattern: "/one/*", action: "deny" as const}]])
    assert.throws(() => openCodeOrderedRules("ask", false, {permission_rules: rules}), /task denial/);
});
