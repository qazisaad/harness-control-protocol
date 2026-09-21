import { createHash } from "node:crypto";
import { z } from "zod";
import { HarnessAdapterError, type HarnessMcpToolset, type HarnessMcpReviewer } from "../types.js";
import type { McpToolCallResult, McpReviewPolicy, McpReviewGrant } from "../../../mcp/McpAttachmentClient.js";

const callSchema = z.object({
  threadId: z.string().min(1), turnId: z.string().min(1), callId: z.string().min(1),
  namespace: z.string().nullable().optional(), tool: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()),
});
export type NativeMcpCall = z.infer<typeof callSchema>;
type Content = {type: "inputText"; text: string} | {type: "inputImage"; imageUrl: string} | {type: "inputAudio"; audioUrl: string};
export type NativeMcpResult = {contentItems: Content[]; success: boolean};

export function nativeMcpNamespace(attachmentName: string): string {
  return `mcp_${createHash("sha256").update(attachmentName).digest("hex").slice(0, 24)}`;
}

const contentSchema = z.discriminatedUnion("type", [
  z.object({type: z.literal("text"), text: z.string()}),
  z.object({type: z.literal("image"), mimeType: z.string(), data: z.string()}),
  z.object({type: z.literal("audio"), mimeType: z.string(), data: z.string()}),
]);

export function nativeMcpResult(result: McpToolCallResult): NativeMcpResult {
  const contentItems: Content[] = [];
  if (result.structured_content !== undefined) {
    contentItems.push({type: "inputText", text: JSON.stringify(result.structured_content)});
  }
  for (const block of result.content ?? []) {
    const content = contentSchema.safeParse(block);
    if (!content.success) {
      contentItems.push({type: "inputText", text: JSON.stringify(block)});
    } else if (content.data.type === "text") {
      contentItems.push({type: "inputText", text: content.data.text});
    } else if (content.data.type === "image") {
      contentItems.push({type: "inputImage", imageUrl: `data:${content.data.mimeType};base64,${content.data.data}`});
    } else {
      contentItems.push({type: "inputAudio", audioUrl: `data:${content.data.mimeType};base64,${content.data.data}`});
    }
  }
  return {contentItems, success: !result.is_error};
}

/** Routes native requests through the runner's already authorized MCP clients. */
export class NativeMcpBridge {
  readonly #toolsets = new Map<string, {name: string; names: ReadonlySet<string>; policies: ReadonlyMap<string, McpReviewPolicy>; callTool: HarnessMcpToolset["callTool"]}>();
  readonly #calls = new Set<string>();
  #tail: Promise<void> = Promise.resolve();
  readonly definitions: ReadonlyArray<{
    type: "namespace"; name: string; description: string;
    tools: Array<{type: "function"; name: string; description: string; inputSchema: Record<string, unknown>}>;
  }>;

  constructor(toolsets: readonly HarnessMcpToolset[], private readonly reviewer?: HarnessMcpReviewer) {
    this.definitions = toolsets.map(toolset => {
      const name = nativeMcpNamespace(toolset.name);
      if (this.#toolsets.has(name) || new Set(toolset.tools.map(tool => tool.name)).size !== toolset.tools.length) {
        throw new HarnessAdapterError("mcp_catalog_conflict", "MCP tool bindings must be unique within an attachment.");
      }
      this.#toolsets.set(name, {name: toolset.name, names: new Set(toolset.tools.map(tool => tool.name)),
        policies: new Map(toolset.tools.flatMap(tool => tool.review_policy ? [[tool.name, structuredClone(tool.review_policy)] as const] : [])),
        callTool: toolset.callTool.bind(toolset)});
      return {
        type: "namespace", name, description: `Tools from ${toolset.name}`,
        tools: toolset.tools.map(tool => ({type: "function", name: tool.name,
          description: tool.description ?? "", inputSchema: structuredClone(tool.input_schema)})),
      };
    });
  }

  async call(params: unknown, binding: {threadId: string; turnId: string}, signal: AbortSignal): Promise<NativeMcpResult> {
    signal.throwIfAborted();
    const call = callSchema.parse(params);
    const toolset = call.namespace ? this.#toolsets.get(call.namespace) : undefined;
    if (call.threadId !== binding.threadId || call.turnId !== binding.turnId ||
        !toolset || !toolset.names.has(call.tool)) {
      throw new HarnessAdapterError("mcp_call_scope_mismatch", "Native MCP call is outside the selected turn and tool scope.");
    }
    if (this.#calls.has(call.callId) || this.#calls.size >= 2048) {
      throw new HarnessAdapterError("mcp_call_identity_invalid", "Native MCP call identity was repeated or the turn limit was exceeded.");
    }
    this.#calls.add(call.callId);
    const operation = this.#tail.then(async () => {
      signal.throwIfAborted();
      const policy = toolset.policies.get(call.tool);
      const value = policy?.kind === "argument" ? call.arguments[policy.argument] : undefined;
      const requiresReview = policy?.kind === "always" || (policy?.kind === "argument" && typeof value === "string" && policy.values.includes(value));
      let grant: McpReviewGrant | undefined;
      if (requiresReview) {
        if (!this.reviewer) throw new HarnessAdapterError("mcp_review_unavailable", "This tool requires platform review before execution.");
        const decision = await this.reviewer.request({attachment_name: toolset.name, tool_name: call.tool, arguments: structuredClone(call.arguments),
          native_thread_id: call.threadId, native_turn_id: call.turnId, native_call_id: call.callId}, signal);
        signal.throwIfAborted();
        if (decision === null) return {success: false, contentItems: [{type: "inputText" as const, text: "The user declined this tool call."}]};
        grant = decision;
      }
      const request = {attachment_name: toolset.name, tool_name: call.tool, arguments: structuredClone(call.arguments),
        native_thread_id: call.threadId, native_turn_id: call.turnId, native_call_id: call.callId};
      const result = this.reviewer?.invoke
        ? await this.reviewer.invoke(request, toolset.callTool, signal, grant)
        : await toolset.callTool(call.tool, call.arguments, grant);
      if (grant && !this.reviewer?.invoke) await this.reviewer!.complete(grant, result);
      signal.throwIfAborted();
      return nativeMcpResult(result);
    });
    this.#tail = operation.then(() => undefined, () => undefined);
    return operation;
  }
}
