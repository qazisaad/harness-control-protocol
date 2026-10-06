import {z} from "zod";
import {HarnessAdapterError} from "../types.js";

export type OpenCodePolicy = "ask" | "auto_edits" | "full_access";
export function permissionRules(policy: OpenCodePolicy, background = false) {
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
export function assertOpenCodeSessionPolicy(actual: unknown, policy: OpenCodePolicy, background = false): void {
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
