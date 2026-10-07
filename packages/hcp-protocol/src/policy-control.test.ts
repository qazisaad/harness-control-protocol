import assert from "node:assert/strict";
import {test} from "node:test";
import {harnessNativePolicyControlAuthoritySchema, harnessNativePolicyControlOperationSchema, hcpConversationResultPayloadSchema,
  hcpSessionStartPayloadSchema} from "./index.js";

const ask = {approval_policy: "ask", approval_reviewer: "user"} as const;
const auto = {approval_policy: "auto_edits", approval_reviewer: "user"} as const;
const start = {session_id: "session", workspace_id: "workspace", provider_instance_id: "provider", driver_kind: "claude", cwd: "/workspace",
  execution_profile: "interactive", continuation_group_key: "conversation", sandbox_mode: "danger_full_access", approval_policy: "ask",
  continue_session: false, model_selection: {model: "model"}, mcp_servers: [], policy_control_authority: {allowed_selections: [ask, auto]}};

test("idle policy launch authority is explicit, unique and contains the initial selection", () => {
  assert.equal(hcpSessionStartPayloadSchema.safeParse(start).success, true);
  for (const patch of [{execution_profile: "isolated"}, {continuation_group_key: undefined},
    {policy_control_authority: {allowed_selections: [auto]}}, {policy_control_authority: {allowed_selections: [ask, ask]}}])
    assert.equal(hcpSessionStartPayloadSchema.safeParse({...start, ...patch}).success, false);
  assert.equal(harnessNativePolicyControlAuthoritySchema.safeParse({allowed_selections: [{approval_policy: "full_access", approval_reviewer: "native_auto"}]}).success, false);
});

test("idle policy commands require bounded configuration revision and exact selection", () => {
  const operation = {kind: "policy", expected_revision: 0, selection: auto};
  assert.equal(harnessNativePolicyControlOperationSchema.safeParse(operation).success, true);
  for (const expected_revision of [-1, 0.5, 1024, Number.MAX_SAFE_INTEGER])
    assert.equal(harnessNativePolicyControlOperationSchema.safeParse({...operation, expected_revision}).success, false);
  for (const selection of [{approval_policy: "ask"}, {...ask, sandbox_mode: "danger_full_access"}, {...ask, approval_reviewer: "native_auto"}])
    assert.equal(harnessNativePolicyControlOperationSchema.safeParse({...operation, selection}).success, false);
});

test("policy confirmation carries physical native proof and cannot substitute history or unrelated receipts", () => {
  const result = {command_id: "command", session_id: "session", operation: "policy", filesystem_undo: false,
    policy: {source: "native", native_reference: "native", revision: 1, mode: "execute", selection: auto,
      observed_at: "2026-01-01T00:00:00.000Z", native_source: "claude.sdk.system.status", native_permission_mode: "acceptEdits"}};
  assert.equal(hcpConversationResultPayloadSchema.safeParse(result).success, true);
  const {policy: _policy, ...missing} = result;
  assert.equal(hcpConversationResultPayloadSchema.safeParse(missing).success, false);
  assert.equal(hcpConversationResultPayloadSchema.safeParse({...result, operation: "retire"}).success, false);
  assert.equal(hcpConversationResultPayloadSchema.safeParse({...result, native_reference: "another-native"}).success, false);
  assert.equal(hcpConversationResultPayloadSchema.safeParse({...result, policy: {...result.policy, history_hash: "a".repeat(64)}}).success, false);
});
