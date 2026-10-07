import {z} from "zod";
import {harnessApprovalOptionsSchema, type HcpSessionStartPayload} from "@harness-control/protocol";
import {HarnessAdapterError} from "../types.js";

export const codexApprovalPolicySchema = z.union([z.enum(["untrusted", "on-request", "never"]), z.object({granular: z.object({
  sandbox_approval: z.boolean(), rules: z.boolean(), skill_approval: z.boolean().default(false),
  request_permissions: z.boolean().default(false), mcp_elicitations: z.boolean(),
}).strict()}).strict()]);
export type CodexApprovalPolicy = z.infer<typeof codexApprovalPolicySchema>;
export function codexApprovalPolicy(payload: Pick<HcpSessionStartPayload, "approval_policy" | "approval_options">): CodexApprovalPolicy {
  if (!payload.approval_options) return {ask: "untrusted", auto_edits: "on-request", full_access: "never"}[payload.approval_policy] as "untrusted" | "on-request" | "never";
  if (payload.approval_policy !== "auto_edits")
    throw new HarnessAdapterError("approval_options_invalid", "Native prompt filtering requires on-request approval authority.");
  const options = harnessApprovalOptionsSchema.parse(payload.approval_options);
  if (!("prompt_categories" in options)) throw new HarnessAdapterError("approval_options_unsupported", "This native approval option has no Codex mapping.");
  const categories = options.prompt_categories;
  return {granular: {sandbox_approval: categories.sandbox_escalation, rules: categories.execution_rules,
    skill_approval: categories.skill_execution, request_permissions: categories.permission_requests, mcp_elicitations: categories.mcp_elicitation}};
}
