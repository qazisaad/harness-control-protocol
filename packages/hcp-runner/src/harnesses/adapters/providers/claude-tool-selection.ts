import {z} from "zod";
import {harnessToolSelectionSchema, type HarnessToolSelection} from "@harness-control/protocol";
import {HarnessAdapterError} from "../types.js";

// Availability is an immutable launch selection; it does not pre-approve callbacks.
// TodoWrite changes native checklist state and grants no filesystem/tool execution authority.
export const claudeSelectableBuiltins = ["Read", "Glob", "Grep", "TodoWrite"];
export function claudeToolSelectionOptions(selection: HarnessToolSelection | undefined): {tools?: string[]} {
  if (!selection) return {};
  const tools = harnessToolSelectionSchema.parse(selection).native_builtin_tools;
  if (new Set(tools).size !== tools.length || tools.some(tool => !claudeSelectableBuiltins.includes(tool)))
    throw new HarnessAdapterError("native_tool_selection_unsupported", "Claude supports only the declared unique builtin selection.");
  return {tools: [...tools]};
}
export function confirmClaudeToolSelection(selection: HarnessToolSelection | undefined, initialization: unknown): HarnessToolSelection | undefined {
  if (!selection) return undefined;
  const expected = claudeToolSelectionOptions(selection).tools!;
  const observed = z.object({tools: z.array(z.string().min(1).max(512)).max(1024)}).safeParse(initialization);
  // MCP availability is separately verified through its exact selected server inventory.
  const builtins = observed.success ? observed.data.tools.filter(tool => !tool.startsWith("mcp__")) : undefined;
  if (!builtins || new Set(builtins).size !== builtins.length || JSON.stringify([...builtins].sort()) !== JSON.stringify([...expected].sort()))
    throw new HarnessAdapterError("native_tool_selection_unconfirmed", "Claude did not confirm the exact selected native builtin availability.");
  return {native_builtin_tools: [...builtins]};
}
