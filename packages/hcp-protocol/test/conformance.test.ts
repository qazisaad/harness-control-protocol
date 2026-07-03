import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

import {
  collectConformanceCases,
  runConformanceCli,
  validateConformanceTargets,
  type ConformanceCase,
  type ConformanceRunResult,
} from "../src/conformance.js";
import { createHcpMessageJsonSchema, type JsonSchema, type JsonSchemaValue } from "../src/json-schema.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const fixtureRoot = join(packageRoot, "fixtures", "conformance");
const validFixtureDir = join(fixtureRoot, "valid");
const invalidFixtureDir = join(fixtureRoot, "invalid");
const schemaPath = join(packageRoot, "schemas", "hcp-message.schema.json");

function asRecord(value: unknown, context: string): Record<string, unknown> {
  assert.equal(typeof value, "object", `${context} must be an object`);
  assert.notEqual(value, null, `${context} must be non-null`);
  assert.equal(Array.isArray(value), false, `${context} must not be an array`);
  return value as Record<string, unknown>;
}

function schemaProperties(schema: Record<string, unknown>, context: string): Record<string, unknown> {
  return asRecord(schema.properties, `${context}.properties`);
}

function schemaOneOf(schema: Record<string, unknown>, context: string): Record<string, unknown>[] {
  assert.ok(Array.isArray(schema.oneOf), `${context}.oneOf must be an array`);
  return schema.oneOf.map((entry: unknown): Record<string, unknown> => asRecord(entry, `${context}.oneOf entry`));
}

function messageSchemaByType(schema: JsonSchema, type: string): Record<string, unknown> {
  const messageSchemas: Record<string, unknown>[] = schemaOneOf(schema, "HCP message schema");
  const found: Record<string, unknown> | undefined = messageSchemas.find((messageSchema: Record<string, unknown>) => {
    const properties: Record<string, unknown> = schemaProperties(messageSchema, "message schema");
    const typeSchema: Record<string, unknown> = asRecord(properties.type, "message type schema");
    return typeSchema.const === type;
  });
  assert.ok(found, `message schema for ${type} must exist`);
  return found;
}

function harnessEventPayloadSchemas(schema: JsonSchema): Record<string, unknown>[] {
  const messageSchemas: Record<string, unknown>[] = schemaOneOf(schema, "HCP message schema");
  return messageSchemas
    .filter((messageSchema: Record<string, unknown>): boolean => {
      const properties: Record<string, unknown> = schemaProperties(messageSchema, "message schema");
      const typeSchema: Record<string, unknown> = asRecord(properties.type, "message type schema");
      return typeSchema.const === "harness.event";
    })
    .map((messageSchema: Record<string, unknown>): Record<string, unknown> => {
      const properties: Record<string, unknown> = schemaProperties(messageSchema, "harness.event message schema");
      return asRecord(properties.payload, "harness.event payload schema");
    });
}

function payloadSchemaForEventType(schema: JsonSchema, eventType: string): Record<string, unknown> {
  const found: Record<string, unknown> | undefined = harnessEventPayloadSchemas(schema).find(
    (payloadSchema: Record<string, unknown>): boolean => {
      const properties: Record<string, unknown> = schemaProperties(payloadSchema, "harness.event payload schema");
      const eventTypeSchema: Record<string, unknown> = asRecord(properties.event_type, "event_type schema");
      return eventTypeSchema.const === eventType;
    },
  );
  assert.ok(found, `payload schema for ${eventType} must exist`);
  return found;
}

function assertEventTypePattern(schema: JsonSchema, pattern: string): void {
  const found: boolean = harnessEventPayloadSchemas(schema).some((payloadSchema: Record<string, unknown>): boolean => {
    const properties: Record<string, unknown> = schemaProperties(payloadSchema, "harness.event payload schema");
    const eventTypeSchema: Record<string, unknown> = asRecord(properties.event_type, "event_type schema");
    return eventTypeSchema.pattern === pattern;
  });
  assert.equal(found, true, `event type pattern ${pattern} must exist`);
}

test("conformance fixture corpus validates expected valid and invalid messages", async () => {
  const result: ConformanceRunResult = await validateConformanceTargets({
    targets: [{ path: fixtureRoot }],
  });

  assert.equal(result.ok, true);
  assert.equal(result.validCount, 17);
  assert.equal(result.invalidCount, 9);
});

test("JSON Schema validates the conformance fixture corpus", async () => {
  const schema: JsonSchema = createHcpMessageJsonSchema();
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  const validate = ajv.compile(schema);
  const cases: ConformanceCase[] = await collectConformanceCases({
    targets: [{ path: fixtureRoot }],
  });

  for (const testCase of cases) {
    const content: string = await readFile(testCase.filePath, "utf8");
    const parsed: unknown = JSON.parse(content) as unknown;
    const valid: boolean = validate(parsed);
    assert.equal(valid, testCase.expectation === "valid", `${testCase.filePath}: ${ajv.errorsText(validate.errors)}`);
  }
});

test("conformance runner validates arbitrary JSON files as valid by default", async () => {
  const validResult: ConformanceRunResult = await validateConformanceTargets({
    targets: [{ path: join(validFixtureDir, "host-hello.json") }],
  });
  const invalidResult: ConformanceRunResult = await validateConformanceTargets({
    targets: [{ path: join(invalidFixtureDir, "unknown-top-level-field.json") }],
  });

  assert.equal(validResult.ok, true);
  assert.equal(validResult.caseCount, 1);
  assert.equal(invalidResult.ok, false);
  assert.equal(invalidResult.failures[0]?.expectation, "valid");
});

test("conformance CLI validates fixture roots and direct files", async () => {
  const fixtureResult = await runConformanceCli(["--fixtures", fixtureRoot]);
  const invalidFileResult = await runConformanceCli([join(invalidFixtureDir, "unknown-payload-field.json")]);

  assert.equal(fixtureResult.exitCode, 0);
  assert.match(fixtureResult.output, /26 cases checked/);
  assert.equal(invalidFileResult.exitCode, 1);
  assert.match(invalidFileResult.output, /unknown-payload-field\.json/);
});

test("conformance bin wrapper executes successfully", () => {
  const scriptPath = join(packageRoot, "src", "bin", "conformance.ts");
  const result: SpawnSyncReturns<string> = spawnSync(
    process.execPath,
    ["--import", "tsx", scriptPath, "--valid-dir", validFixtureDir, "--invalid-dir", invalidFixtureDir],
    {
      cwd: packageRoot,
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /26 cases checked/);
});

test("committed JSON Schema is generated from the protocol source", async () => {
  const generatedSchema: JsonSchema = createHcpMessageJsonSchema();
  const schemaFile: JsonSchema = JSON.parse(await readFile(schemaPath, "utf8")) as JsonSchema;

  assert.deepEqual(schemaFile, generatedSchema);
});

test("JSON Schema export keeps extension events open and strict branches represented", () => {
  const schema: JsonSchema = createHcpMessageJsonSchema();

  assert.equal(schema.$id, "https://schemas.harness-control.local/hcp.v0/message.schema.json");
  assertEventTypePattern(schema, "^provider\\..+$");
  assertEventTypePattern(schema, "^extension\\..+$");

  const turnCompletedPayloadSchema: Record<string, unknown> = payloadSchemaForEventType(schema, "turn.completed");
  const turnCompletedDataSchema: Record<string, unknown> = asRecord(
    schemaProperties(turnCompletedPayloadSchema, "turn.completed payload schema").data,
    "turn.completed data schema",
  );
  assert.deepEqual(turnCompletedDataSchema.required, ["final_output"]);

  const localActionPayloadSchema: Record<string, unknown> = payloadSchemaForEventType(
    schema,
    "local_capability.action.started",
  );
  assert.ok((localActionPayloadSchema.required as string[] | undefined)?.includes("turn_id"));

  const sessionStartSchema: Record<string, unknown> = messageSchemaByType(schema, "harness.session.start");
  const sessionStartPayload: Record<string, unknown> = asRecord(
    schemaProperties(sessionStartSchema, "session start schema").payload,
    "session start payload schema",
  );
  const mcpServersSchema: Record<string, unknown> = asRecord(
    schemaProperties(sessionStartPayload, "session start payload schema").mcp_servers,
    "mcp_servers schema",
  );
  const mcpServerSchema: Record<string, unknown> = asRecord(
    mcpServersSchema.items as JsonSchemaValue,
    "mcp_servers item schema",
  );
  const urlSchema: Record<string, unknown> = asRecord(
    schemaProperties(mcpServerSchema, "mcp server schema").url,
    "MCP URL schema",
  );
  assert.equal(urlSchema.pattern, "^https?://");
});
