import assert from "node:assert/strict";
import {test} from "node:test";
import {hcpSessionStartPayloadSchema} from "./index.js";
const base = {session_id: "resumed", workspace_id: "workspace", provider_instance_id: "provider", driver_kind: "claude", cwd: "/fixture", execution_profile: "interactive",
  continuation_group_key: "conversation", expected_native_reference: "native-conversation", sandbox_mode: "danger_full_access", approval_policy: "ask", continue_session: true, model_selection: {model: "model"}, mcp_servers: []};
test("expected native continuation identity is bounded and separate from native acquisition authority", () => {
  assert.equal(hcpSessionStartPayloadSchema.safeParse(base).success, true);
  for (const expected_native_reference of ["", "a".repeat(513), {}, 1]) assert.equal(hcpSessionStartPayloadSchema.safeParse({...base, expected_native_reference}).success, false);
});
test("expected identity cannot create a fresh native conversation, omit its retained group or combine a model turn", () => {
  for (const patch of [{continue_session: false}, {continuation_group_key: undefined}, {first_turn: {turn_id: "root", input: "fixture", not_after: "2026-10-07T00:00:00Z"}}])
    assert.equal(hcpSessionStartPayloadSchema.safeParse({...base, ...patch}).success, false);
});
