import {z} from "zod";
import {isDeepStrictEqual} from "node:util";
import {harnessApprovalOptionsSchema, type HarnessApprovalOptions, type HarnessPermissionRules} from "@harness-control/protocol";
import {HarnessAdapterError} from "../types.js";

export type OpenCodePolicy = "ask" | "auto_edits" | "full_access";
export const openCodePermissionNames = ["*", "bash", "edit", "question", "task", "read", "glob", "grep", "list", "lsp", "todowrite", "todoread", "skill", "webfetch", "websearch", "codesearch", "external_directory", "doom_loop"] as const;

export function openCodeOrderedRules(policy: OpenCodePolicy, background: boolean, options: HarnessApprovalOptions): HarnessPermissionRules {
  const parsed = harnessApprovalOptionsSchema.parse(options);
  if (!("permission_rules" in parsed) || policy !== "ask" || parsed.permission_rules.some(rule => !openCodePermissionNames.includes(rule.permission as typeof openCodePermissionNames[number])))
    throw new HarnessAdapterError("approval_options_unsupported", "Ordered native permission rules require a controlled ask profile and declared permissions.");
  // Root-only interactive ownership must forbid native task launch under every pattern.
  // A path-specific deny or an earlier deny cannot establish that boundary.
  if (background) {
    if (parsed.permission_rules[0]?.action !== "deny")
      throw new HarnessAdapterError("native_child_policy_seed_required", "Ordered background policy requires an initial deny-all seed before effective overrides.");
    return structuredClone(parsed.permission_rules);
  }
  const lastTask = [...parsed.permission_rules].reverse().find(rule => rule.permission === "*" || rule.permission === "task");
  if (lastTask?.pattern !== "*" || lastTask.action !== "deny")
    throw new HarnessAdapterError("native_permission_task_unsupported", "Root-only ordered policy requires a final all-pattern task denial.");
  return structuredClone(parsed.permission_rules);
}
export function permissionRules(policy: OpenCodePolicy, background = false, options?: HarnessApprovalOptions) {
  if (options) return openCodeOrderedRules(policy, background, options);
  return [
    {permission: "*", pattern: "*", action: policy === "full_access" ? "allow" : "ask"},
    ...(policy === "auto_edits" ? [{permission: "edit", pattern: "*", action: "allow"}] : []),
    {permission: "question", pattern: "*", action: policy === "full_access" ? "deny" : "allow"},
    {permission: "task", pattern: "*", action: background ? "allow" : "deny"},
  ];
}

// OpenCode 1.18.34 appends permission rules and evaluates the last matching rule.
// Restrict the vocabulary so these four probes cover every possible rule domain.
// Unknown permissions or path-specific grants cannot be certified by this proof.
export function assertOpenCodeSessionPolicy(actual: unknown, policy: OpenCodePolicy, background = false, options?: HarnessApprovalOptions): void {
  if (options) {
    const expected = openCodeOrderedRules(policy, background, options);
    // Do not certify ordered path/glob policies with a finite list of sample paths.
    // Exact complete readback preserves duplicate overrides and their order.
    if (!isDeepStrictEqual(actual, expected))
      throw new HarnessAdapterError("native_policy_mismatch", "OpenCode ordered permission readback differs from the complete authorized rules.");
    return;
  }
  const parsed = z.array(z.object({permission: z.enum(["*", "edit", "question", "task"]),
    pattern: z.literal("*"), action: z.enum(["allow", "ask", "deny"])}).strict()).min(1).max(4096).safeParse(actual);
  const expected = permissionRules(policy, background);
  const effective = (rules: typeof expected, permission: string) => {
    for (let i = rules.length - 1; i >= 0; i--) {
      const rule = rules[i]!;
      if (rule.permission === "*" || rule.permission === permission) return rule.action;
    }
    return undefined;
  };
  if (!parsed.success || ["*", "edit", "question", "task"].some(name => effective(parsed.data, name) !== effective(expected, name)))
    throw new HarnessAdapterError("native_policy_mismatch", "OpenCode retained permissions differ from the complete authorized session permission policy.");
}
