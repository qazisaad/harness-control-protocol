import assert from "node:assert/strict";
import { it } from "node:test";
import { mcpInputExpiresAt, mcpInputResponseParams, parseMcpPendingInput } from "./input-required.js";

const question = {method: "elicitation/create", params: {
  message: "Choose a name", requestedSchema: {type: "object", properties: {name: {type: "string"}}},
}};

it("input deadlines survive persistence and can only shorten caller authority", () => {
  const expiry = "2026-09-21T15:00:00.000Z";
  const pending = (hint: unknown) => parseMcpPendingInput({ inputRequests: { question: {
    ...question, params: {...question.params, _meta: {"com.prompt2agent/input-deadline": hint}},
  }} });
  const earlier = "2026-09-21T14:00:00.000Z";
  assert.equal(mcpInputExpiresAt(JSON.parse(JSON.stringify(pending(earlier))), expiry), earlier);
  assert.equal(mcpInputExpiresAt(pending("2026-09-21T16:00:00+00:00"), expiry), expiry);
  assert.equal(mcpInputExpiresAt(parseMcpPendingInput({inputRequests: {question}}), expiry), expiry);
  assert.throws(() => mcpInputExpiresAt(pending("tomorrow"), expiry));
});

it("retains opaque state and validates exact input IDs and response categories", () => {
  const pending = parseMcpPendingInput({requestState: "opaque", inputRequests: {question}});
  for (const action of ["accept", "decline", "cancel"] as const) {
    const responses = {question: {action, ...(action === "accept" ? {content: {name: "Ada"}} : {})}};
    assert.deepEqual(mcpInputResponseParams({pending, responses}), {requestState: "opaque", inputResponses: responses});
  }
  assert.throws(() => mcpInputResponseParams({pending, responses: {}}), /request IDs/);
  assert.throws(() => mcpInputResponseParams({pending, responses: {other: {action: "cancel"}}}), /request IDs/);
  assert.throws(() => mcpInputResponseParams({pending, responses: {question: {roots: []}}}), /request type/);
});

it("uses SDK request guards and bounds retained state", () => {
  assert.throws(() => parseMcpPendingInput({}), /no requests/);
  assert.throws(() => parseMcpPendingInput({inputRequests: {q: {method: "tools/call"}}}), /unsupported or invalid/);
  assert.throws(() => parseMcpPendingInput({inputRequests: {q: {method: "elicitation/create", params: {}}}}), /unsupported or invalid/);
  assert.throws(() => parseMcpPendingInput({requestState: "x".repeat(1024 * 1024)}), /persistence limit/);
  assert.deepEqual(mcpInputResponseParams({pending: parseMcpPendingInput({requestState: "opaque"}), responses: {}}),
    {requestState: "opaque", inputResponses: {}});
});

it("keeps arbitrary request IDs as own properties without mutable aliases", () => {
  const source = JSON.parse(JSON.stringify({inputRequests: {constructor: question}}));
  Object.defineProperty(source.inputRequests, "__proto__", {value: question, enumerable: true});
  const pending = parseMcpPendingInput(source);
  source.inputRequests.constructor.params.message = "changed";
  assert.deepEqual(Object.keys(pending.inputRequests!).sort(), ["__proto__", "constructor"]);
  assert.deepEqual(pending.inputRequests!.constructor, {...question, params: {...question.params, message: "Choose a name"}});
  const responses = Object.fromEntries(["__proto__", "constructor"].map(key => [key, {action: "cancel" as const}]));
  const params = mcpInputResponseParams({pending, responses});
  responses["__proto__"] = {action: "cancel"};
  assert.deepEqual(Object.keys(params.inputResponses).sort(), ["__proto__", "constructor"]);
});
