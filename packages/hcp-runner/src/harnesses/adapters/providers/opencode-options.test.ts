import assert from "node:assert/strict";
import {test} from "node:test";
import {openCodeEffectiveOptions, assertOpenCodeModelOptions} from "./opencode-options.js";

const expected = {sessionId: "session", messageId: "prompt", model: {providerID: "provider", modelID: "model"}};
const admitted = {info: {id: "prompt", sessionID: "session", role: "user", model: expected.model}};
const response = {id: "answer", sessionID: "session", parentID: "prompt", role: "assistant", providerID: "provider", modelID: "model"};
const catalog = {all: [{id: "provider", models: {model: {id: "model", providerID: "provider", name: "Fixture",
  capabilities: {input: {image: true}}, variants: {high: {}}}}}], connected: ["provider"]};

test("OpenCode validates current connected models, variants and image capability before native execution", () => {
  assert.equal(assertOpenCodeModelOptions(catalog, {model: "provider/model", options: [{id: "variant", value: "high"}]}, true).id, "provider/model");
  assert.throws(() => assertOpenCodeModelOptions(catalog, {model: "provider/foreign"}), /absent/);
  assert.throws(() => assertOpenCodeModelOptions({...catalog, connected: []}, {model: "provider/model"}), /connected/);
  assert.throws(() => assertOpenCodeModelOptions(catalog, {model: "provider/model", options: [{id: "variant", value: "unknown"}]}), /variant/);
  const textOnly = structuredClone(catalog); textOnly.all[0]!.models.model.capabilities.input.image = false;
  assert.throws(() => assertOpenCodeModelOptions(textOnly, {model: "provider/model"}, true), /image/);
});

test("OpenCode root options readback reports native default or explicit variants", () => {
  assert.deepEqual(openCodeEffectiveOptions(admitted, response, expected), {model: "provider/model", options: []});
  const withDefault = {info: {...admitted.info, variant: "default-native-option"}};
  assert.deepEqual(openCodeEffectiveOptions(withDefault, response, expected),
    {model: "provider/model", options: [{id: "variant", value: "default-native-option"}]});
  assert.deepEqual(openCodeEffectiveOptions(withDefault, response, {...expected, variant: "default-native-option"}),
    {model: "provider/model", options: [{id: "variant", value: "default-native-option"}]});
});

for (const drift of ["session", "parent", "response-model", "request-model", "variant", "missing-response"] as const)
test(`OpenCode root options reject unconfirmed ${drift}`, () => {
  const request = structuredClone(admitted), result = structuredClone(response);
  if (drift === "session") request.info.sessionID = "foreign";
  if (drift === "parent") result.parentID = "foreign";
  if (drift === "response-model") result.modelID = "foreign";
  if (drift === "request-model") request.info.model.modelID = "foreign";
  assert.throws(() => openCodeEffectiveOptions(request, drift === "missing-response" ? undefined : result,
    {...expected, ...(drift === "variant" ? {variant: "high"} : {})}), /did not confirm/);
});
