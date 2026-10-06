import assert from "node:assert/strict";
import {test} from "node:test";
import {assertOpenCodeSessionPolicy, permissionRules} from "./opencode-policy.js";

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
