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

export const HCP_MESSAGE_JSON_SCHEMA_ID = `https://schemas.harness-control.local/${HCP_VERSION}/message.schema.json`;

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

function toEmbeddedJsonSchema(schema: z.ZodType<unknown>, name: string): JsonSchema {
  const jsonSchema: JsonSchema = cloneJsonSchema(toRootJsonSchema(schema));
  delete jsonSchema.$schema;
  jsonSchema.$id = `https://schemas.harness-control.local/${HCP_VERSION}/events/${name}.schema.json`;
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
    const dataSchema: JsonSchema = toEmbeddedJsonSchema(knownHcpEventDataSchemas[eventType], eventType);
    const payloadSchema: JsonSchema = createHarnessEventPayloadSchema(
      basePayloadSchema,
      createEventTypeSchema(eventType),
      dataSchema,
      eventType.startsWith("local_capability.action.") || ["settings.effective", "settings.options.effective", "context.input.prepared"].includes(eventType),
    );
    if (["input.requested", "input.resolved", "user_input.requested", "user_input.resolved", "native.request.lost"].includes(eventType))
      payloadSchema.allOf = [{if: {properties: {data: {properties: {request_scope: {const: "session"}}, required: ["request_scope"]}}, required: ["data"]},
        then: {not: {required: ["turn_id"]}}}];
    return createHarnessEventMessageSchema(baseMessageSchema, payloadSchema);
  });

  const extensionEventSchemas: JsonSchema[] = (["provider", "extension"] as const).map(
    (prefix: "provider" | "extension"): JsonSchema => {
      const payloadSchema: JsonSchema = createHarnessEventPayloadSchema(
        basePayloadSchema,
        createExtensionEventTypeSchema(prefix),
        toEmbeddedJsonSchema(hcpExtensionEventDataSchema, prefix),
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
  const attachmentSchemas: JsonSchema[] = itemSchema.oneOf ?? [];
  const streamableSchema: JsonSchema | undefined = attachmentSchemas.find((candidate: JsonSchema): boolean => {
    const transportValue: JsonSchemaValue | undefined = candidate.properties?.transport;
    const transportSchema: JsonSchema | undefined =
      typeof transportValue === "object" && transportValue !== null ? transportValue : undefined;
    return transportSchema?.const === "streamable_http";
  });
  const urlOwner: JsonSchema = streamableSchema ?? itemSchema;
  const urlSchema: JsonSchema = getObjectProperty(urlOwner, "url", "streamable HTTP MCP server attachment schema");
  urlSchema.pattern = "^https?://";
}

export function createHcpMessageJsonSchema(): JsonSchema {
  const schema: JsonSchema = cloneJsonSchema(toRootJsonSchema(hcpMessageSchema));
  const messageSchemas: JsonSchema[] = schema.oneOf ?? [];
  if (messageSchemas.length === 0) {
    throw new TypeError("HCP message JSON Schema must contain message variants.");
  }

  const expandedMessageSchemas: JsonSchema[] = messageSchemas.flatMap((messageSchema: JsonSchema): JsonSchema[] => {
    if (hasMessageTypeConst(messageSchema, "harness.session.start")) {
      const payload = getObjectProperty(messageSchema, "payload", "session start");
      payload.allOf = [{if: {required: ["conversation_transition"]}, then: {
        required: ["continuation_group_key"], properties: {continue_session: {const: true}}, not: {required: ["first_turn"]}}}];
    }
    if (hasMessageTypeConst(messageSchema, "harness.event")) {
      return createHarnessEventMessageSchemas(messageSchema);
    }
    if (hasMessageTypeConst(messageSchema, "harness.conversation.result")) {
      const payload = getObjectProperty(messageSchema, "payload", "conversation result");
      payload.allOf = [...[["read", "history"], ["rollback", "history"], ["fork", "fork"], ["steer", "turn_id"], ["content", "content"], ["work", "work"], ["inject", "injection"], ["input_file", "input_file"], ["feedback", "feedback"]]
        .map(([operation, field]) => ({if: {properties: {operation: {const: operation}}, required: ["operation"]}, then: {required: [field]}})),
        {if: {required: ["native_fresh"]}, then: {properties: {operation: {enum: ["fork", "rollback"]}}}},
        {if: {required: ["injection"]}, then: {properties: {operation: {const: "inject"}}}},
        {if: {required: ["input_file"]}, then: {properties: {operation: {const: "input_file"}}}},
        {if: {required: ["feedback"]}, then: {properties: {operation: {const: "feedback"}}}}];
      const file = getObjectProperty(payload, "input_file", "input file result");
      file.allOf = [{if: {properties: {action: {const: "release"}}, required: ["action"]}, then: {properties: {state: {const: "released"}}}},
        {if: {properties: {state: {const: "released"}}, required: ["state"]}, then: {properties: {action: {const: "release"}}}},
        {if: {properties: {action: {const: "seal"}}, required: ["action"]}, then: {properties: {state: {enum: ["sealed", "retained"]}}}}];
    }
    if (hasMessageTypeConst(messageSchema, "harness.turn.send")) {
      const payload = getObjectProperty(messageSchema, "payload", "turn send");
      payload.allOf = [{if: {properties: {action: {const: "compact"}}, required: ["action"]},
        then: {not: {required: ["context"]}, properties: {input: {const: ""}, mode: {const: "execute"}, images: {maxItems: 0}, files: {maxItems: 0}}}}];
    }
    return [messageSchema];
  });

  schema.$id = HCP_MESSAGE_JSON_SCHEMA_ID;
  schema.title = "HCP protocol message";
  schema.description =
    "Structural JSON Schema for known hcp.v0 protocol messages. Runtime parsers enforce additional cross-field invariants such as lease-to-attribution equality.";
  schema.oneOf = expandedMessageSchemas;

  patchStreamableHttpMcpUrlSchema(schema);

  return schema;
}

export const hcpMessageJsonSchema: JsonSchema = createHcpMessageJsonSchema();
