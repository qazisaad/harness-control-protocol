import {test} from "node:test";
import assert from "node:assert/strict";
import {projectOpenCodeCatalog} from "./opencode-models.js";

const model = (providerID: string) => ({id: "one", providerID, name: "One", capabilities: {input: {image: false}},
  variants: {high: {private_setting: "never expose"}}, limit: {context: 128000}});

test("OpenCode catalog exposes connected models and native variants without credentials or guessed modalities", () => {
  const result = projectOpenCodeCatalog({connected: ["local"], all: [
    {id: "local", key: "credential-never-expose", options: {secret: "never expose"}, models: {one: model("local")}},
    {id: "offline", models: {one: model("offline")}},
  ]});
  assert.equal(result.models.length, 1);
  assert.equal(result.models[0]?.id, "local/one");
  assert.equal(result.models[0]?.capabilities.image_input, false);
  assert.deepEqual(result.models[0]?.capabilities.option_descriptors[0]?.values, [{value: "high", label: "high"}]);
  assert.equal(result.capacities.get("local/one"), 128000);
  assert.doesNotMatch(JSON.stringify(result.models), /credential|secret|private_setting/);
  assert.equal(result.models[0]?.is_default, undefined);
});

test("OpenCode rejects cross-provider and mismatched catalog identities", () => {
  assert.throws(() => projectOpenCodeCatalog({connected: ["local"], all: [{id: "local", models: {one: model("other")}}]}));
  assert.throws(() => projectOpenCodeCatalog({connected: ["local"], all: [{id: "local", models: {other: model("local")}}]}));
});
