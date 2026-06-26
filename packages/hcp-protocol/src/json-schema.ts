import { z } from "zod";

import {
  HCP_VERSION,
  KNOWN_HCP_EVENT_TYPES,
  hcpExtensionEventDataSchema,
  hcpMessageSchema,
  knownHcpEventDataSchemas,
  type KnownHcpEventType,
} from "./index.js";

export type JsonSchemaValue = boolean | JsonSchema;

export type JsonSchema = Record<string, unknown> & {
  $id?: string;
  $schema?: string;
  additionalProperties?: JsonSchemaValue;
  const?: string | number | boolean | null;
  description?: string;
  items?: JsonSchemaValue | JsonSchemaValue[];
  oneOf?: JsonSchema[];
  pattern?: string;
  properties?: Record<string, JsonSchemaValue>;
  required?: string[];
  title?: string;
  type?: string;
};

export const HCP_MESSAGE_JSON_SCHEMA_ID = `https://schemas.hcp-runner.local/${HCP_VERSION}/message.schema.json`;

function isJsonSchema(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asJsonSchema(value: unknown, context: string): JsonSchema {
  if (!isJsonSchema(value)) {
    throw new TypeError(`${context} must be a JSON Schema object.`);
  }
  return value;
}

function getProperties(schema: JsonSchema, context: string): Record<string, JsonSchemaValue> {
  if (schema.properties === undefined) {
    throw new TypeError(`${context} must define properties.`);
  }
  return schema.properties;
}

function getObjectProperty(schema: JsonSchema, propertyName: string, context: string): JsonSchema {
  const properties: Record<string, JsonSchemaValue> = getProperties(schema, context);
  return asJsonSchema(properties[propertyName], `${context}.${propertyName}`);
}

function cloneJsonSchema(schema: JsonSchema): JsonSchema {
  return asJsonSchema(structuredClone(schema), "cloned JSON Schema");
}

function toRootJsonSchema(schema: z.ZodType<unknown>): JsonSchema {
  return asJsonSchema(z.toJSONSchema(schema), "generated JSON Schema");
}

function toEmbeddedJsonSchema(schema: z.ZodType<unknown>): JsonSchema {
  const jsonSchema: JsonSchema = cloneJsonSchema(toRootJsonSchema(schema));
  delete jsonSchema.$schema;
  delete jsonSchema.$id;
  return jsonSchema;
}

function hasMessageTypeConst(schema: JsonSchema, messageType: string): boolean {
  const typeSchema: JsonSchema = getObjectProperty(schema, "type", "message schema");
  return typeSchema.const === messageType;
}

function createEventTypeSchema(eventType: KnownHcpEventType): JsonSchema {
  return {
    type: "string",
    const: eventType,
  };
}

function createExtensionEventTypeSchema(prefix: "provider" | "extension"): JsonSchema {
  return {
    type: "string",
    pattern: `^${prefix}\\..+$`,
  };
}

function withRequiredProperty(schema: JsonSchema, propertyName: string): JsonSchema {
  const required: string[] = schema.required ?? [];
  if (required.includes(propertyName)) {
    return schema;
  }
  return {
    ...schema,
    required: [...required, propertyName],
  };
}

function createHarnessEventPayloadSchema(
  basePayloadSchema: JsonSchema,
  eventTypeSchema: JsonSchema,
  dataSchema: JsonSchema,
  turnIdRequired: boolean,
): JsonSchema {
  const payloadSchema: JsonSchema = cloneJsonSchema(basePayloadSchema);
  const properties: Record<string, JsonSchemaValue> = getProperties(payloadSchema, "harness.event payload schema");
  properties.event_type = eventTypeSchema;
  properties.data = dataSchema;
  return turnIdRequired ? withRequiredProperty(payloadSchema, "turn_id") : payloadSchema;
}

function createHarnessEventMessageSchema(
  baseMessageSchema: JsonSchema,
  payloadSchema: JsonSchema,
): JsonSchema {
  const messageSchema: JsonSchema = cloneJsonSchema(baseMessageSchema);
  const properties: Record<string, JsonSchemaValue> = getProperties(messageSchema, "harness.event message schema");
  properties.payload = payloadSchema;
  return messageSchema;
}

function createHarnessEventMessageSchemas(baseMessageSchema: JsonSchema): JsonSchema[] {
  const basePayloadSchema: JsonSchema = getObjectProperty(baseMessageSchema, "payload", "harness.event message schema");
  const knownEventSchemas: JsonSchema[] = KNOWN_HCP_EVENT_TYPES.map((eventType: KnownHcpEventType): JsonSchema => {
    const dataSchema: JsonSchema = toEmbeddedJsonSchema(knownHcpEventDataSchemas[eventType]);
    const payloadSchema: JsonSchema = createHarnessEventPayloadSchema(
      basePayloadSchema,
      createEventTypeSchema(eventType),
      dataSchema,
      eventType.startsWith("local_capability.action."),
    );
    return createHarnessEventMessageSchema(baseMessageSchema, payloadSchema);
  });

  const extensionEventDataSchema: JsonSchema = toEmbeddedJsonSchema(hcpExtensionEventDataSchema);
  const extensionEventSchemas: JsonSchema[] = (["provider", "extension"] as const).map(
    (prefix: "provider" | "extension"): JsonSchema => {
      const payloadSchema: JsonSchema = createHarnessEventPayloadSchema(
        basePayloadSchema,
        createExtensionEventTypeSchema(prefix),
        extensionEventDataSchema,
        false,
      );
      return createHarnessEventMessageSchema(baseMessageSchema, payloadSchema);
    },
  );

  return [...knownEventSchemas, ...extensionEventSchemas];
}

function patchStreamableHttpMcpUrlSchema(schema: JsonSchema): void {
  const messageSchemas: JsonSchema[] = schema.oneOf ?? [];
  const sessionStartSchema: JsonSchema | undefined = messageSchemas.find((messageSchema: JsonSchema): boolean =>
    hasMessageTypeConst(messageSchema, "harness.session.start"),
  );
  if (sessionStartSchema === undefined) {
    throw new TypeError("HCP message JSON Schema must contain harness.session.start.");
  }

  const payloadSchema: JsonSchema = getObjectProperty(sessionStartSchema, "payload", "harness.session.start schema");
  const mcpServersSchema: JsonSchema = getObjectProperty(payloadSchema, "mcp_servers", "session start payload schema");
  const itemSchema: JsonSchema = asJsonSchema(mcpServersSchema.items, "mcp_servers items schema");
  const urlSchema: JsonSchema = getObjectProperty(itemSchema, "url", "MCP server attachment schema");
  urlSchema.pattern = "^https?://";
}

export function createHcpMessageJsonSchema(): JsonSchema {
  const schema: JsonSchema = cloneJsonSchema(toRootJsonSchema(hcpMessageSchema));
  const messageSchemas: JsonSchema[] = schema.oneOf ?? [];
  if (messageSchemas.length === 0) {
    throw new TypeError("HCP message JSON Schema must contain message variants.");
  }

  const expandedMessageSchemas: JsonSchema[] = messageSchemas.flatMap((messageSchema: JsonSchema): JsonSchema[] => {
    if (hasMessageTypeConst(messageSchema, "harness.event")) {
      return createHarnessEventMessageSchemas(messageSchema);
    }
    return [messageSchema];
  });

  schema.$id = HCP_MESSAGE_JSON_SCHEMA_ID;
  schema.title = "HCP protocol message";
  schema.description = "JSON Schema for known hcp.v0 protocol messages.";
  schema.oneOf = expandedMessageSchemas;

  patchStreamableHttpMcpUrlSchema(schema);

  return schema;
}

export const hcpMessageJsonSchema: JsonSchema = createHcpMessageJsonSchema();
