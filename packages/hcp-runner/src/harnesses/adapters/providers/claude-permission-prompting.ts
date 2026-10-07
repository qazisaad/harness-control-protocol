import {harnessApprovalOptionsSchema, type HcpSessionStartPayload} from "@harness-control/protocol";
import type {Options} from "@anthropic-ai/claude-agent-sdk";
import {HarnessAdapterError} from "../types.js";

type Policy = Pick<HcpSessionStartPayload, "approval_policy" | "approval_reviewer" | "approval_options">;
export function claudeRejectsUnapprovedPermissions(policy: Policy): boolean {
  if (!policy.approval_options) return false;
  const options = harnessApprovalOptionsSchema.parse(policy.approval_options);
  if (!("permission_prompting" in options) || policy.approval_policy !== "ask" || (policy.approval_reviewer ?? "user") !== "user")
    throw new HarnessAdapterError("approval_options_unsupported", "Native permission rejection requires Claude interactive ask authority without automatic review.");
  return true;
}
export function claudePermissionMode(policy: Policy, mode: "execute" | "plan"): NonNullable<Options["permissionMode"]> {
  const reject = claudeRejectsUnapprovedPermissions(policy);
  if (mode === "plan" && reject)
    throw new HarnessAdapterError("native_permission_prompting_plan_unsupported", "Plan mode cannot replace the selected native permission rejection policy.");
  return mode === "plan" ? "plan" : reject ? "dontAsk" : policy.approval_reviewer === "native_auto" ? "auto"
    : ({ask: "default", auto_edits: "acceptEdits", full_access: "bypassPermissions"} as const)[policy.approval_policy];
}
