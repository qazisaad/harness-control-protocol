import {z} from "zod";
import {harnessPermissionRulesSchema} from "./permission-rules.js";

/** Filters which native approval flows may prompt. False rejects that flow; it never grants approval. */
export const harnessApprovalOptionsSchema = z.union([z.object({prompt_categories: z.object({
  sandbox_escalation: z.boolean(), execution_rules: z.boolean(), skill_execution: z.boolean(),
  permission_requests: z.boolean(), mcp_elicitation: z.boolean(),
}).strict()}).strict(),
  /** Native denial of unapproved root permission requests, without bypass or application review. */
  z.object({permission_prompting: z.literal("reject_unapproved")}).strict(),
  z.object({permission_rules: harnessPermissionRulesSchema}).strict(),
]);
export type HarnessApprovalOptions = z.infer<typeof harnessApprovalOptionsSchema>;
