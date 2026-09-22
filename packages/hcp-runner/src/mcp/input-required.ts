import {
  Client, isJSONRPCResultResponse, isSpecType, type InputRequest, type InputRequiredResult, type InputResponses,

} from "@modelcontextprotocol/client";
import { z } from "zod";
import { AsyncLocalStorage } from "node:async_hooks";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";

export type McpInputReply = {pending: InputRequiredResult; responses: InputResponses};

/** An optional server deadline can shorten the caller's existing deadline. */
export function mcpInputExpiresAt(pending: InputRequiredResult, callerExpiry: string): string {
  let expiry = Date.parse(z.iso.datetime({offset: true}).parse(callerExpiry));
  const hint = pending._meta?.["com.prompt2agent/input-deadline"];
  if (hint !== undefined) expiry = Math.min(expiry, Date.parse(z.iso.datetime({offset: true}).parse(hint)));
  return new Date(expiry).toISOString();
}

export const mcpPendingInputSchema = z.object({
  resultType: z.literal("input_required"),
  inputRequests: z.record(z.string(), z.unknown()).optional(),
  requestState: z.string().optional(),
  _meta: z.record(z.string(), z.json()).optional(),
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
  _meta?: unknown;
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
    ...(value._meta === undefined ? {} : {_meta: z.record(z.string(), z.json()).parse(value._meta)}),
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
      if (request.params.mode === "url" && response.content !== undefined) {
        throw new Error("URL elicitation cannot include form values.");
      }
    }
  }
  return {inputResponses: structuredClone(reply.responses),
    ...(pending.requestState === undefined ? {} : {requestState: pending.requestState})};
}

/** Retains nonterminal input while the SDK keeps validating terminal tool output. */
export class ManagedMcpSdkClient extends Client {
  readonly #responseMeta = new AsyncLocalStorage<unknown>();

  override async connect(...args: Parameters<Client["connect"]>): Promise<void> {
    await super.connect(...args);
    const transport = args[0];
    const receive = transport.onmessage;
    if (!receive) throw new Error("The MCP client did not install its transport receiver.");
    // SDK 2.0.0 discards input-required result metadata during decoding.
    // Bind it to this received message, including asynchronous dispatch, without rewriting the wire payload.
    transport.onmessage = (message, extra) => {
      const meta = isJSONRPCResultResponse(message) ? message.result._meta : undefined;
      this.#responseMeta.run(meta, () => receive(message, extra));
    };
  }

  protected override async _resolveNonCompleteResult(decoded: {
    kind: "input_required"; inputRequests: Record<string, unknown>; requestState?: string;
  }): Promise<unknown> {
    throw new McpInputRequiredError(parseMcpPendingInput({...decoded, _meta: this.#responseMeta.getStore()}));
  }
}
