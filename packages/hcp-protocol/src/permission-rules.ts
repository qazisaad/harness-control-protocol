import {z} from "zod";

/** Ordered native tool/path rules. The last matching rule wins; this does not grant an OS sandbox. */
export const harnessPermissionRuleSchema = z.object({
  permission: z.string().regex(/^(?:\*|[a-z][a-z0-9_]{0,63})$/),
  pattern: z.string().min(1).max(1024).regex(/^[^\x00-\x1f\x7f]+$/, "Permission patterns cannot contain control characters."),
  action: z.enum(["allow", "ask", "deny"]),
}).strict();
export const harnessPermissionRulesSchema = z.array(harnessPermissionRuleSchema).min(1).max(128)
  .refine(rules => rules[0]?.permission === "*" && rules[0].pattern === "*", "Permission rules require an explicit first wildcard baseline.").meta({prefixItems: [{
    type: "object", properties: {permission: {const: "*"}, pattern: {const: "*"}}, required: ["permission", "pattern"],
  }]});
export const harnessPermissionRulesCapabilitiesSchema = z.object({
  scope: z.enum(["root", "root_and_children"]), matching: z.literal("ordered_glob"),
  permissions: z.array(harnessPermissionRuleSchema.shape.permission).min(1).max(64)
    .refine(names => new Set(names).size === names.length, "Declared permission names must be unique.").meta({uniqueItems: true}),
}).strict();
export type HarnessPermissionRule = z.infer<typeof harnessPermissionRuleSchema>;
export type HarnessPermissionRules = z.infer<typeof harnessPermissionRulesSchema>;
