import assert from "node:assert/strict";
import {test} from "node:test";
import {openCodeEffectiveOptions, assertOpenCodeModelOptions, assertAnonymousOpenCodeModel} from "./opencode-options.js";

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


test("anonymous dispatch requires the exact connected public model and native zero-cost evidence", () => {
  const model = {id: "free", providerID: "opencode", cost: {input: 0, output: 0, cache: {read: 0, write: 0}}};
  const catalog = {connected: ["opencode"], all: [{id: "opencode", models: {free: model}}]};
  assertAnonymousOpenCodeModel(catalog, {model: "opencode/free"});
  for (const cost of [undefined, {...model.cost, input: 1}, {...model.cost, output: 1}, {...model.cost, cache: {read: 1, write: 0}}]) {
    assert.throws(() => assertAnonymousOpenCodeModel({...catalog, all: [{id: "opencode", models: {free: {...model, cost}}}]}, {model: "opencode/free"}), /zero-cost/);
  }
  assert.throws(() => assertAnonymousOpenCodeModel({...catalog, connected: []}, {model: "opencode/free"}), /zero-cost/);
  assert.throws(() => assertAnonymousOpenCodeModel(catalog, {model: "opencode/paid"}), /zero-cost/);
  assert.throws(() => assertAnonymousOpenCodeModel(catalog, {model: "another/free"}), /zero-cost/);
});
