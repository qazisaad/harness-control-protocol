import {z} from "zod";

const roots = z.array(z.object({workspace_id: z.string().min(1).max(512), path: z.string().min(1).max(4096).regex(/^[^\0]*$/)}).strict()).max(32);
/** Additional native execution authority. Each write root must name an authorized host workspace. */
export const harnessSandboxOptionsSchema = z.union([
  z.object({network_access: z.boolean(), writable_roots: roots.optional()}).strict(),
  z.object({network_access: z.boolean().optional(), writable_roots: roots}).strict(),
]);
export type HarnessSandboxOptions = z.infer<typeof harnessSandboxOptionsSchema>;
