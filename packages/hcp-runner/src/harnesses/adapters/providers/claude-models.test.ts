import {test} from "node:test";
import assert from "node:assert/strict";
import {projectClaudeModels} from "./claude-models.js";

test("native model discovery advertises only explicitly supported boolean settings", () => {
  const [known, unknown] = projectClaudeModels([{value: "supported", displayName: "Supported",
    supportsAdaptiveThinking: true, supportsFastMode: true}, {value: "unknown", displayName: "Unknown"}]);
  assert.deepEqual(known?.capabilities.option_descriptors, [{id: "thinking", label: "Thinking", type: "boolean"},
    {id: "fastMode", label: "Fast mode", type: "boolean"}]);
  assert.deepEqual(unknown?.capabilities.option_descriptors, []);
});
import {ClaudeHarnessAdapter} from "./claude.js";
import {RunnerConfigSchema} from "../../../config/index.js";

test("Claude catalogs project only native advertised effort choices", () => {
  const models = projectClaudeModels([
    {value: "new-model", displayName: "New model", supportsEffort: true, supportedEffortLevels: ["medium", "high"]},
    {value: "fixed", displayName: "Fixed model", supportsEffort: false, supportedEffortLevels: ["max"]},
    {value: "unspecified", displayName: "Unspecified", supportsEffort: true},
  ]);
  assert.equal(models[0]?.id, "new-model");
  assert.deepEqual(models[0]?.capabilities.option_descriptors[0]?.values, [
    {value: "medium", label: "medium"}, {value: "high", label: "high"},
  ]);
  assert.deepEqual(models[1]?.capabilities.option_descriptors, []);
  assert.deepEqual(models[2]?.capabilities.option_descriptors, []);
  assert.equal(models[0]?.is_default, undefined);
});

test("Claude rejects ambiguous or malformed model catalogs", () => {
  assert.throws(() => projectClaudeModels([{value: "one", displayName: "One"}, {value: "one", displayName: "Other"}]));
  assert.throws(() => projectClaudeModels([{value: "one", displayName: "One", supportedEffortLevels: ["invented"]}]));
});

test("authenticated Claude reports catalog failure without claiming invented models", async () => {
  const provider = RunnerConfigSchema.parse({runner_id: "test", control_plane_url: "ws://localhost:1",
    provider_instances: [{id: "claude", driver_kind: "claude"}]}).provider_instances[0]!;
  const adapter = new ClaudeHarnessAdapter({modelCatalog: async () => {throw new Error("Unavailable");},
    processSpawner: (_executable, args) => ({result: Promise.resolve({exitCode: 0, signal: null,
      stdout: args.includes("status") ? '{"loggedIn":true}' : "test-version", stderr: "", error: undefined, timedOut: false}), kill() {}})});
  const status = await adapter.probe(provider);
  assert.equal(status.available, true);
  assert.equal(status.authStatus, "authenticated");
  assert.deepEqual(status.models, []);
  assert.match(status.message!, /catalog is unavailable/);
});

test("Claude advertises 1M context for long-context families and ultracode only when the account reports it", () => {
  const catalog = [
    {value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus", supportsEffort: true, supportedEffortLevels: ["high", "xhigh"]},
    {value: "haiku", resolvedModel: "claude-haiku-5-5", displayName: "Haiku", supportsEffort: true, supportedEffortLevels: ["high"]},
  ];
  const ids = (models: ReturnType<typeof projectClaudeModels>) => models.map(model => model.capabilities.option_descriptors.map(option => option.id));
  assert.deepEqual(ids(projectClaudeModels(catalog)), [["effort", "contextWindow"], ["effort"]]);
  assert.deepEqual(ids(projectClaudeModels({models: catalog, ultracodeAvailable: true})), [["effort", "ultracode", "contextWindow"], ["effort"]]);
  assert.deepEqual(ids(projectClaudeModels({models: catalog, ultracodeAvailable: false})), [["effort", "contextWindow"], ["effort"]]);
  assert.deepEqual(projectClaudeModels(catalog)[0]!.capabilities.option_descriptors[1], {id: "contextWindow", label: "Context window", type: "select",
    default_value: "default", values: [{value: "default", label: "Default"}, {value: "1m", label: "1M"}]});
});
