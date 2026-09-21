import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { hashMcpReviewAction, mcpReviewActionBytes, mcpReviewGrantSchema, mcpReviewPolicySchema, MCP_REVIEW_MAX_ACTION_BYTES } from "./index.js";

test("public MCP review contracts bind exact UTF-8 bytes and reject invalid embedded actions", async () => {
  const action = JSON.stringify({kind: "mcp_tool", attachment_name: "server", tool_name: "write", arguments: {text: "é🙂"}});
  assert.equal(await hashMcpReviewAction(action), createHash("sha256").update(action, "utf8").digest("hex"));
  assert.notEqual(await hashMcpReviewAction(action), await hashMcpReviewAction(` ${action}`));
  assert.deepEqual(mcpReviewGrantSchema.parse({request_id: "id", action_json: action}), {request_id: "id", action_json: action});
  for (const invalid of ['{}', action.replace('"write"', '""'), action.replace('"server"', '""')]) {
    assert.throws(() => mcpReviewGrantSchema.parse({request_id: "id", action_json: invalid}));
  }
  const oversized = JSON.stringify({kind: "mcp_tool", attachment_name: "s", tool_name: "t", arguments: {text: "é".repeat(33000)}});
  assert.ok(oversized.length < MCP_REVIEW_MAX_ACTION_BYTES);
  assert.throws(() => mcpReviewActionBytes(oversized), /UTF-8/);
  assert.throws(() => mcpReviewGrantSchema.parse({request_id: "id", action_json: oversized}));
  assert.throws(() => mcpReviewPolicySchema.parse({kind: "always", approved: true}));
});

test("published review conformance fixtures", async () => {
  const {readFile} = await import("node:fs/promises");
  const fixtures: Array<{action_json: string; valid: boolean; sha256?: string}> = JSON.parse(await readFile(new URL("../fixtures/mcp-review.json", import.meta.url), "utf8"));
  for (const fixture of fixtures) {
    const result = mcpReviewGrantSchema.safeParse({request_id: "fixture", action_json: fixture.action_json});
    assert.equal(result.success, fixture.valid);
    if (fixture.valid) assert.equal(await hashMcpReviewAction(fixture.action_json), fixture.sha256);
  }
});
