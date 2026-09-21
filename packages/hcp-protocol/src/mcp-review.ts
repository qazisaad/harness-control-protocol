import { z } from "zod";

/** HCP extension v1; unrelated to the upstream MCP protocol version. */
export const MCP_REVIEW_META_KEY = "io.harness-control/review-v1";
export const MCP_REVIEW_MAX_ACTION_BYTES = 64 * 1024;
export const MCP_REVIEW_MAX_REQUEST_ID_LENGTH = 256;

export const mcpReviewActionSchema = z.object({
  kind: z.literal("mcp_tool"), attachment_name: z.string().min(1),
  tool_name: z.string().min(1), arguments: z.record(z.string(), z.json()),
}).strict();
export type McpReviewAction = z.infer<typeof mcpReviewActionSchema>;

export function mcpReviewActionBytes(json: string): Uint8Array {
  const bytes = new TextEncoder().encode(json);
  if (bytes.length === 0 || bytes.length > MCP_REVIEW_MAX_ACTION_BYTES) throw new Error("MCP review action exceeds its UTF-8 byte limit.");
  mcpReviewActionSchema.parse(JSON.parse(json));
  return bytes;
}

export async function hashMcpReviewAction(json: string): Promise<string> {
  const bytes = mcpReviewActionBytes(json);
  const hash = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}

export const mcpReviewGrantSchema = z.object({
  request_id: z.string().min(1).max(MCP_REVIEW_MAX_REQUEST_ID_LENGTH),
  action_json: z.string().min(1).max(MCP_REVIEW_MAX_ACTION_BYTES),
}).strict().superRefine((value, context) => {
  try {mcpReviewActionBytes(value.action_json);} catch {
    context.addIssue({code: "custom", path: ["action_json"], message: "Invalid or oversized MCP review action."});
  }
});
export type McpReviewGrant = z.infer<typeof mcpReviewGrantSchema>;

export const mcpReviewPolicySchema = z.discriminatedUnion("kind", [
  z.object({kind: z.literal("always")}).strict(),
  z.object({kind: z.literal("argument"), argument: z.string().min(1), values: z.array(z.string().min(1)).min(1)}).strict(),
]);
export type McpReviewPolicy = z.infer<typeof mcpReviewPolicySchema>;

/** JSON Schema consumers must also enforce the embedded action and UTF-8 limit. */
export function createMcpReviewContract() {
  return {version: 1, metadata_key: MCP_REVIEW_META_KEY, max_action_bytes: MCP_REVIEW_MAX_ACTION_BYTES,
    hashing: "sha256-exact-utf8-lowercase-hex", schemas: {
      action: z.toJSONSchema(mcpReviewActionSchema), grant: z.toJSONSchema(mcpReviewGrantSchema), policy: z.toJSONSchema(mcpReviewPolicySchema),
    }};
}
