import assert from "node:assert/strict";
import {test} from "node:test";
import {McpProxyInputs} from "./proxy-inputs.js";
import {parseMcpPendingInput} from "./input-required.js";

const pending = () => parseMcpPendingInput({requestState: "upstream-private-state", inputRequests: {question: {
  method: "elicitation/create", params: {message: "Continue?", requestedSchema: {type: "object", properties: {
    answer: {type: "string"}}, required: ["answer"]}}}}});
const answers = {question: {action: "accept", content: {answer: "yes"}}};
test("proxy input continuation binds caller and exact action, validates answers and dispatches once", () => {
  const store = new McpProxyInputs(); const key = store.retain("caller", "tool", {path: "owned"}, pending());
  assert.notEqual(key, "upstream-private-state");
  for (const [scope, tool, args] of [["other", "tool", {path: "owned"}], ["caller", "other", {path: "owned"}], ["caller", "tool", {path: "foreign"}]] as const)
    assert.throws(() => store.consume(scope, tool, args, key, answers), /another caller\/action/);
  assert.throws(() => store.consume("caller", "tool", {path: "owned"}, key, {question: {action: "accept", content: {}}}));
  const reply = store.consume("caller", "tool", {path: "owned"}, key, answers);
  assert.equal(reply?.pending.requestState, "upstream-private-state");
  assert.deepEqual(reply?.responses, answers);
  assert.throws(() => store.consume("caller", "tool", {path: "owned"}, key, answers), /consumed/);
  assert.throws(() => store.consume("caller", "tool", {}, undefined, answers), /no verified/);
});
test("proxy expiry and physical caller loss discard ownership without inventing cancellation", () => {
  let now = Date.now(); const store = new McpProxyInputs(() => now);
  const expiring = store.retain("caller", "tool", {}, pending()); now += 5 * 60_000;
  assert.throws(() => store.consume("caller", "tool", {}, expiring, answers), /expired/);
  const lost = store.retain("caller", "tool", {}, pending()); store.closeScope("caller");
  assert.throws(() => store.consume("caller", "tool", {}, lost, answers), /expired/);
  const closing = store.retain("caller", "tool", {}, pending()); store.close();
  assert.throws(() => store.consume("caller", "tool", {}, closing, answers), /expired/);
});
test("proxy continuation ownership is bounded even when clients disappear without a reply", () => {
  const store = new McpProxyInputs();
  for (let i = 0; i < 128; i++) store.retain("caller", "tool", {i}, pending());
  assert.throws(() => store.retain("caller", "tool", {}, pending()), /bounded capacity/);
  store.closeScope("caller"); store.retain("replacement", "tool", {}, pending());
});
