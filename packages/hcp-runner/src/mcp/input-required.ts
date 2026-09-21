import {
  Client, isSpecType, type InputRequest, type InputRequiredResult, type InputResponses,

} from "@modelcontextprotocol/client";
import { z } from "zod";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";

export type McpInputReply = {pending: InputRequiredResult; responses: InputResponses};

/** An optional server deadline can shorten the caller's existing deadline. */
export function mcpInputExpiresAt(pending: InputRequiredResult, callerExpiry: string): string {
  let expiry = Date.parse(z.iso.datetime({offset: true}).parse(callerExpiry));
  for (const request of Object.values(pending.inputRequests ?? {})) {
    const hint = request.params?._meta?.["com.prompt2agent/input-deadline"];
    if (hint !== undefined) expiry = Math.min(expiry, Date.parse(z.iso.datetime({offset: true}).parse(hint)));
  }
  return new Date(expiry).toISOString();
}

export const mcpPendingInputSchema = z.object({
  resultType: z.literal("input_required"),
  inputRequests: z.record(z.string(), z.unknown()).optional(),
  requestState: z.string().optional(),
}).strict().transform(value => parseMcpPendingInput(value));

export const mcpInputReplySchema = z.object({
  pending: mcpPendingInputSchema,
  responses: z.record(z.string(), z.json()),
}).strict().transform(value => {
  const responses = value.responses as InputResponses;
  mcpInputResponseParams({pending: value.pending, responses});
  return {pending: value.pending, responses};
});

export class McpInputRequiredError extends Error {
  constructor(readonly pending: InputRequiredResult) {
    super("The MCP tool requires input before it can complete.");
    this.name = "McpInputRequiredError";
  }
}

export function parseMcpPendingInput(value: {
  inputRequests?: Record<string, unknown> | undefined; requestState?: string | undefined;
}): InputRequiredResult {
  const requests: Array<[string, InputRequest]> = [];
  for (const [key, request] of Object.entries(value.inputRequests ?? {})) {
    if (!isSpecType.ElicitRequest(request) && !isSpecType.CreateMessageRequest(request) && !isSpecType.ListRootsRequest(request)) {
      throw new Error("MCP requested an unsupported or invalid input.");
    }
    requests.push([key, structuredClone(request)]);
  }
  const inputRequests = Object.fromEntries(requests);
  if (Object.keys(inputRequests).length === 0 && value.requestState === undefined) {
    throw new Error("MCP input requirement has no requests or continuation state.");
  }
  const pending: InputRequiredResult = {resultType: "input_required", inputRequests,
    ...(value.requestState === undefined ? {} : {requestState: value.requestState})};
  if (Buffer.byteLength(JSON.stringify(pending), "utf8") > 1024 * 1024) {
    throw new Error("MCP pending input exceeds the persistence limit.");
  }
  return pending;
}

export function mcpInputResponseParams(reply: McpInputReply): {
  inputResponses: InputResponses; requestState?: string;
} {
  if (Buffer.byteLength(JSON.stringify(reply.responses), "utf8") > 1024 * 1024) {
    throw new Error("MCP input responses exceed the persistence limit.");
  }
  const pending = parseMcpPendingInput(reply.pending);
  const requested = Object.keys(pending.inputRequests ?? {}).sort();
  const answered = Object.keys(reply.responses).sort();
  if (requested.length !== answered.length || requested.some((key, index) => key !== answered[index])) {
    throw new Error("MCP responses must match the pending input request IDs.");
  }
  for (const [key, request] of Object.entries(pending.inputRequests ?? {})) {
    const response = reply.responses[key];
    const valid = request.method === "elicitation/create" ? isSpecType.ElicitResult(response)
      : request.method === "roots/list" ? isSpecType.ListRootsResult(response)
      : isSpecType.CreateMessageResult(response) || isSpecType.CreateMessageResultWithTools(response);
    if (!valid) throw new Error("MCP response does not match its input request type.");
    if (request.method === "elicitation/create" && isSpecType.ElicitResult(response)) {
      if (response.action !== "accept" && response.content !== undefined &&
          (response.content === null || typeof response.content !== "object" || Array.isArray(response.content) || Object.keys(response.content).length > 0)) {
        throw new Error("Declined or cancelled MCP input cannot include form values.");
      }
      if (response.action === "accept" && "requestedSchema" in request.params) {
        const schema = request.params.requestedSchema as Parameters<AjvJsonSchemaValidator["getValidator"]>[0];
        const validate = new AjvJsonSchemaValidator().getValidator(schema);
        if (!validate(response.content ?? {}).valid) throw new Error("MCP input does not satisfy the requested form schema.");
      }
    }
  }
  return {inputResponses: structuredClone(reply.responses),
    ...(pending.requestState === undefined ? {} : {requestState: pending.requestState})};
}

/** Retains nonterminal input while the SDK keeps validating terminal tool output. */
export class ManagedMcpSdkClient extends Client {
  protected override async _resolveNonCompleteResult(decoded: {
    kind: "input_required"; inputRequests: Record<string, unknown>; requestState?: string;
  }): Promise<unknown> {
    throw new McpInputRequiredError(parseMcpPendingInput(decoded));
  }
}
