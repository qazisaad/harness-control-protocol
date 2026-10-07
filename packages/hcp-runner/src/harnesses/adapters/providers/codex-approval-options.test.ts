import assert from "node:assert/strict";
import {test} from "node:test";
import {codexApprovalPolicy, codexApprovalPolicySchema} from "./codex-approval-options.js";
import {harnessApprovalOptionsSchema} from "@harness-control/protocol";

const categories = {sandbox_escalation: false, execution_rules: true, skill_execution: false, permission_requests: true, mcp_elicitation: false};
test("Codex prompt categories translate explicitly without enabling omitted native defaults", () => {
  const value = codexApprovalPolicy({approval_policy: "auto_edits", approval_options: {prompt_categories: categories}});
  assert.deepEqual(value, {granular: {sandbox_approval: false, rules: true, skill_approval: false, request_permissions: true, mcp_elicitations: false}});
  assert.deepEqual(codexApprovalPolicySchema.parse({granular: {sandbox_approval: false, rules: false, mcp_elicitations: false}}),
    {granular: {sandbox_approval: false, rules: false, skill_approval: false, request_permissions: false, mcp_elicitations: false}});
});
test("Codex prompt filtering never silently overrides a different named approval policy", () => {
  for (const approval_policy of ["ask", "full_access"] as const)
    assert.throws(() => codexApprovalPolicy({approval_policy, approval_options: {prompt_categories: categories}}), /on-request/);
  assert.equal(codexApprovalPolicy({approval_policy: "ask"}), "untrusted");
  assert.equal(codexApprovalPolicy({approval_policy: "auto_edits"}), "on-request");
  assert.equal(codexApprovalPolicy({approval_policy: "full_access"}), "never");
});
test("prompt filter schema refuses unknown or incomplete categories rather than relying on implicit permissions", () => {
  assert.equal(harnessApprovalOptionsSchema.safeParse({prompt_categories: {...categories, arbitrary: true}}).success, false);
  assert.equal(harnessApprovalOptionsSchema.safeParse({prompt_categories: {sandbox_escalation: true}}).success, false);
  assert.equal(harnessApprovalOptionsSchema.safeParse({prompt_categories: categories, arbitrary: true}).success, false);
});
