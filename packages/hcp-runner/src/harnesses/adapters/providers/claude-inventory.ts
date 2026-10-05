import {z} from "zod";

const builtin = z.object({name: z.string().min(1), path: z.literal("builtin"), source: z.string()});
/** CLI-bundled components are intrinsic runtime features, not inherited user/project plugins. */
export function hasInheritedClaudePlugins(plugins: unknown[]): boolean {
  return plugins.some(plugin => {
    const parsed = builtin.safeParse(plugin);
    return !parsed.success || parsed.data.source !== `${parsed.data.name}@builtin`;
  });
}
