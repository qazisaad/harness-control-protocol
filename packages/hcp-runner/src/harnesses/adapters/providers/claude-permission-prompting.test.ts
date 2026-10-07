import {test} from "node:test";
import assert from "node:assert/strict";
import {claudePermissionMode, claudeRejectsUnapprovedPermissions} from "./claude-permission-prompting.js";

test("Claude native permission rejection is distinct from approval bypass and existing named policies", () => {
  const policy = {approval_policy: "ask" as const, approval_options: {permission_prompting: "reject_unapproved" as const}};
  assert.equal(claudeRejectsUnapprovedPermissions(policy), true);assert.equal(claudePermissionMode(policy, "execute"), "dontAsk");
  assert.equal(claudePermissionMode({approval_policy: "ask"}, "execute"), "default");
  assert.equal(claudePermissionMode({approval_policy: "full_access"}, "execute"), "bypassPermissions");
  assert.equal(claudePermissionMode({approval_policy: "auto_edits", approval_reviewer: "native_auto"}, "execute"), "auto");
});
test("native permission rejection refuses conflicting approval authority, automatic review and plan replacement", () => {
  const approval_options = {permission_prompting: "reject_unapproved" as const};
  for (const approval_policy of ["auto_edits", "full_access"] as const)
    assert.throws(() => claudePermissionMode({approval_policy, approval_options}, "execute"), /without automatic review/);
  assert.throws(() => claudePermissionMode({approval_policy: "ask", approval_reviewer: "native_auto", approval_options}, "execute"), /without automatic review/);
  assert.throws(() => claudePermissionMode({approval_policy: "ask", approval_options}, "plan"), /Plan mode/);
});
