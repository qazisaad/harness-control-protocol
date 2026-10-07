import {createHash} from "node:crypto";
import {realpath} from "node:fs/promises";
import {z} from "zod";
import {HarnessAdapterError} from "../types.js";

const id = z.string().min(1).max(512);
const definition = z.object({alias: z.string().regex(/^hcp_[a-f0-9]{48}$/), description: z.string().max(64 * 1024),
  schema: z.record(z.string(), z.json())}).strict();
const context = z.object({session_id: id, message_id: id, call_id: id, directory: z.string().min(1).max(4096)}).strict();
export const openCodeOwnedToolInvocationSchema = z.object({native_context: context, alias: definition.shape.alias,
  arguments: z.record(z.string(), z.json())}).strict();
export type OpenCodeOwnedToolDefinition = z.infer<typeof definition>;
export type OpenCodeOwnedToolInvocation = z.infer<typeof openCodeOwnedToolInvocationSchema>;

export function openCodeOwnedToolAlias(attachment: string, tool: string): string {
  return `hcp_${createHash("sha256").update(JSON.stringify([attachment, tool])).digest("hex").slice(0, 48)}`;
}

/** Private executable source only: the proof and native context never enter model-visible arguments. */
export function openCodeOwnedToolPlugin(input: {endpoint: string; proof: string; tools: readonly OpenCodeOwnedToolDefinition[]}): string {
  const endpoint = new URL(input.endpoint);
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || !endpoint.port || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
    throw new HarnessAdapterError("native_tool_bridge_binding", "Native tools require an owned loopback endpoint.");
  if (!/^[a-zA-Z0-9_-]{32,256}$/.test(input.proof))
    throw new HarnessAdapterError("native_tool_bridge_binding", "Native tools require a private invocation proof.");
  const tools = z.array(definition).min(1).max(2048).parse(input.tools);
  if (new Set(tools.map(tool => tool.alias)).size !== tools.length)
    throw new HarnessAdapterError("native_tool_catalog_conflict", "Native tool aliases must be unique.");
  const data = JSON.stringify(JSON.stringify({endpoint: endpoint.href, proof: input.proof, tools}));
  const source = `const owned = JSON.parse(${data});
const fail = code => {throw new Error("The owned native tool could not confirm its invocation." +
  (typeof code === "string" && /^[a-z0-9_]{1,128}$/.test(code) ? " (" + code + ")" : ""));};
export default async () => ({
  tool: Object.fromEntries(owned.tools.map(def => [def.alias, {
    description: def.description,
    args: def.schema.properties && typeof def.schema.properties === "object" && !Array.isArray(def.schema.properties) ? def.schema.properties : {},
    async execute(args, ctx) {
      if (!ctx || ![ctx.sessionID, ctx.messageID, ctx.callID].every(id => typeof id === "string" && id.length > 0 && id.length <= 512) ||
          typeof ctx.directory !== "string" || !ctx.directory || !ctx.abort || ctx.abort.aborted) return fail();
      const response = await fetch(owned.endpoint, {method: "POST", headers: {"content-type": "application/json", "x-hcp-native-tool-proof": owned.proof},
        body: JSON.stringify({alias: def.alias, arguments: args, native_context: {session_id: ctx.sessionID, message_id: ctx.messageID,
          call_id: ctx.callID, directory: ctx.directory}}), signal: ctx.abort});
      const result = await response.json();
      if (!response.ok || ctx.abort.aborted) return fail(result?.code);
      if (!result || typeof result.output !== "string" || ctx.abort.aborted) return fail();
      return result;
    }
  }])),
  "tool.definition": async ({toolID}, output) => {
    const def = owned.tools.find(tool => tool.alias === toolID);
    // Pinned 1.18.34 parameters are an Effect decoder. Preserve it; replace only the JSON Schema.
    if (def) output.jsonSchema = structuredClone(def.schema);
  }
});
`;
  if (Buffer.byteLength(source) > 8 * 1024 * 1024)
    throw new HarnessAdapterError("native_tool_catalog_limit", "The owned native tool catalog exceeds its source limit.");
  return source;
}

type JsonValue = z.infer<ReturnType<typeof z.json>>;
function canonical(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
  return value;
}

/** Readback proves a live exact call and its arguments; the work owner must still prove root/child custody. */
export async function verifyOpenCodeOwnedToolInvocation(input: unknown, expectedDirectory: string, transport: {
  session(id: string): Promise<unknown>; message(session: string, id: string): Promise<unknown>;
}) {
  const invocation = openCodeOwnedToolInvocationSchema.parse(input), native = invocation.native_context;
  const session = z.object({id, directory: z.string().min(1).max(4096), parentID: id.optional()}).parse(await transport.session(native.session_id));
  if (session.id !== native.session_id || await realpath(session.directory) !== await realpath(expectedDirectory) ||
      await realpath(native.directory) !== await realpath(expectedDirectory))
    throw new HarnessAdapterError("native_tool_call_unconfirmed", "Native tool workspace ownership could not be confirmed.");
  const message = z.object({info: z.object({id, sessionID: id, role: z.literal("assistant"), parentID: id}),
    parts: z.array(z.record(z.string(), z.unknown())).max(1024)}).parse(await transport.message(native.session_id, native.message_id));
  const parts = message.parts.filter(part => part.callID === native.call_id);
  const part = z.object({id, sessionID: id, messageID: id, type: z.literal("tool"), callID: id, tool: definition.shape.alias,
    state: z.object({status: z.enum(["pending", "running"]), input: z.record(z.string(), z.json())})}).safeParse(parts[0]);
  if (message.info.id !== native.message_id || message.info.sessionID !== native.session_id || parts.length !== 1 || !part.success ||
      part.data.sessionID !== native.session_id || part.data.messageID !== native.message_id || part.data.tool !== invocation.alias ||
      JSON.stringify(canonical(part.data.state.input)) !== JSON.stringify(canonical(invocation.arguments)))
    throw new HarnessAdapterError("native_tool_call_unconfirmed", "Native tool identity, liveness or arguments could not be confirmed.");
  return {invocation, native_prompt_id: message.info.parentID, native_part_id: part.data.id,
    ...(session.parentID ? {native_parent_session_id: session.parentID} : {})};
}
