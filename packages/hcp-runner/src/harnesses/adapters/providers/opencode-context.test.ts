import {test} from "node:test";
import assert from "node:assert/strict";
import {openCodeContext} from "./opencode-context.js";

test("OpenCode context capacity requires both matching root selection and native catalog identity", () => {
  const info = {sessionID: "session", parentID: "prompt", role: "assistant", providerID: "provider", modelID: "model",
    tokens: {input: 20, output: 5, cache: {read: 10, write: 0}}};
  const catalog = new Map([["provider/model", 128000], ["other/model", 1000000]]);
  const measured = openCodeContext(info, "session", "prompt", {model: "provider/model"}, catalog);
  assert.equal(measured.status, "measured");
  if (measured.status !== "measured") throw new Error("Expected a measured context");
  assert.equal(measured.capacity_tokens, 128000);
  assert.equal(measured.used_tokens, 35);
  assert.equal(openCodeContext(info, "session", "other-prompt", {model: "provider/model"}, catalog).status, "unavailable");
  const absent = openCodeContext(info, "session", "prompt", {model: "provider/model"}, new Map([["other/model", 1000000]]));
  assert.equal(absent.status, "measured");
  assert.equal("capacity_tokens" in absent, false);
});
