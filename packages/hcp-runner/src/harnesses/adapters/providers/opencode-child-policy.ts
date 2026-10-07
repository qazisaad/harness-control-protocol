import {isDeepStrictEqual} from "node:util";
import {z} from "zod";
import {harnessPermissionRuleSchema, harnessPermissionRulesSchema, type HarnessPermissionRules} from "@harness-control/protocol";
import {HarnessAdapterError} from "../types.js";

/** Native children inherit parent deny/external-directory rules before their first prompt. */
export function openCodeOrderedChildRules(input: HarnessPermissionRules): HarnessPermissionRules {
  const rules = harnessPermissionRulesSchema.parse(input);
  if (rules[0]?.action !== "deny")
    throw new HarnessAdapterError("native_child_policy_seed_required", "Ordered child authority requires an initial deny-all parent seed before effective overrides.");
  // This profile admits one native child generation. Do not silently grant grandchildren.
  return [...structuredClone(rules), {permission: "task", pattern: "*", action: "deny"}];
}
export function assertOpenCodeInitialChildPolicy(actual: unknown, parent: HarnessPermissionRules): void {
  openCodeOrderedChildRules(parent);
  const expected = parent.filter(rule => rule.action === "deny" || rule.permission === "external_directory");
  const parsed = z.array(z.object({permission: z.string(), pattern: z.string(), action: z.enum(["allow", "ask", "deny"])}).strict()).max(130).safeParse(actual);
  if (!parsed.success || !isDeepStrictEqual(parsed.data.slice(0, expected.length), expected))
    throw new HarnessAdapterError("native_child_policy_mismatch", "Native child initial permissions did not preserve their exact parent denial seed.");
  const extra = parsed.data.slice(expected.length);
  if (extra.length > 2 || new Set(extra.map(rule => rule.permission)).size !== extra.length
    || extra.some(rule => !["task", "todowrite"].includes(rule.permission) || rule.pattern !== "*" || rule.action !== "deny"))
    throw new HarnessAdapterError("native_child_policy_mismatch", "Native child initialization added authority outside its permitted default denials.");
}

/** The pinned PATCH endpoint appends the supplied rules to the existing complete policy. */
export function openCodeInstalledChildRules(initial: unknown, parent: HarnessPermissionRules): HarnessPermissionRules {
  assertOpenCodeInitialChildPolicy(initial, parent);
  const inherited = z.array(harnessPermissionRuleSchema).max(130).parse(initial);
  const prefixLength = parent.filter(rule => rule.action === "deny" || rule.permission === "external_directory").length;
  // Native child-agent restrictions retain precedence over the parent's overrides.
  return [...inherited, ...openCodeOrderedChildRules(parent), ...inherited.slice(prefixLength)];
}

export const openCodePolicyPromptSchema = z.object({session_id: z.string().min(1).max(512),
  message_id: z.string().min(1).max(512), directory: z.string().min(1).max(4096)}).strict();
export type OpenCodePolicyPrompt = z.infer<typeof openCodePolicyPromptSchema>;

/** Pinned native chat.message is awaited before storing/dispatching the model prompt. */
export function openCodeOwnedPolicyPlugin(input: {endpoint: string; proof: string}): string {
  const endpoint = new URL(input.endpoint);
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || !endpoint.port || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || !/^[a-zA-Z0-9_-]{32,256}$/.test(input.proof))
    throw new HarnessAdapterError("native_policy_bridge_binding", "Native policy confirmation requires a private owned loopback endpoint.");
  const data = JSON.stringify(JSON.stringify({endpoint: endpoint.href, proof: input.proof}));
  return `const owned = JSON.parse(${data});
const fail = () => {throw new Error("Native prompt permission ownership could not be confirmed.");};
export default async ctx => ({
  "chat.message": async (input, output) => {
    if (!ctx || typeof ctx.directory !== "string" || !ctx.directory || !input || !output || !output.message ||
      typeof input.sessionID !== "string" || !input.sessionID || input.sessionID.length > 512 ||
      output.message.sessionID !== input.sessionID || typeof output.message.id !== "string" || !output.message.id || output.message.id.length > 512 ||
      input.messageID !== undefined && input.messageID !== output.message.id) return fail();
    const response = await fetch(owned.endpoint, {method: "POST", headers: {"content-type": "application/json", "x-hcp-native-policy-proof": owned.proof},
      body: JSON.stringify({session_id: input.sessionID, message_id: output.message.id, directory: ctx.directory}), signal: AbortSignal.timeout(10_000)});
    const result = await response.json();
    if (!response.ok || !result || result.confirmed !== true || result.native_reference !== input.sessionID || result.native_execution_reference !== output.message.id) return fail();
  }
});
`;
}
