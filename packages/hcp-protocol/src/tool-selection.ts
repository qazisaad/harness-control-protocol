import {z} from "zod";

export const nativeBuiltinToolNameSchema = z.string().min(1).max(128).regex(/^(?!mcp__)[A-Za-z][A-Za-z0-9_]*$/);
/** Availability of native root built-ins. Selected MCP tools retain separate attachment/review authority. */
export const harnessToolSelectionSchema = z.object({native_builtin_tools: z.array(nativeBuiltinToolNameSchema).max(128)}).strict();
export const harnessNativeToolSelectionCapabilitiesSchema = z.object({scope: z.literal("root_builtins"),
  tools: z.array(nativeBuiltinToolNameSchema).max(128)}).strict();
export const harnessEffectiveToolSelectionSchema = z.object({scope: z.literal("root"), source: z.literal("native"),
  native_reference: z.string().min(1).max(512), tool_selection: harnessToolSelectionSchema}).strict();
export type HarnessToolSelection = z.infer<typeof harnessToolSelectionSchema>;
