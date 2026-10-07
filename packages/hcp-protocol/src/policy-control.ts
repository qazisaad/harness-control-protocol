import {z} from "zod";

/** Approval options, sandbox, tools and inheritance stay in the immutable session launch binding. */
export const harnessNativePolicySelectionSchema = z.discriminatedUnion("approval_policy", [
  z.object({approval_policy: z.literal("ask"), approval_reviewer: z.literal("user")}).strict(),
  z.object({approval_policy: z.literal("auto_edits"), approval_reviewer: z.enum(["user", "native_auto"])}).strict(),
  z.object({approval_policy: z.literal("full_access"), approval_reviewer: z.literal("user")}).strict(),
]);
export type HarnessNativePolicySelection = z.infer<typeof harnessNativePolicySelectionSchema>;
export const nativePolicySelectionKey = (value: HarnessNativePolicySelection): string => `${value.approval_policy}:${value.approval_reviewer}`;

/** Explicit launch authority for future idle controls. Omission authorizes no in-place replacement. */
export const harnessNativePolicyControlAuthoritySchema = z.object({allowed_selections: z.array(harnessNativePolicySelectionSchema)
  .min(1).max(4).refine(values => new Set(values.map(nativePolicySelectionKey)).size === values.length,
    "Native policy control authority requires unique selections.")}).strict();
export type HarnessNativePolicyControlAuthority = z.infer<typeof harnessNativePolicyControlAuthoritySchema>;

/** Revision describes HCP configuration, never a new native execution or physical owner. */
export const harnessNativePolicyControlOperationSchema = z.object({kind: z.literal("policy"),
  expected_revision: z.number().int().min(0).max(1023), selection: harnessNativePolicySelectionSchema}).strict();
export const harnessNativePolicyControlResultSchema = z.object({source: z.literal("native"),
  native_reference: z.string().min(1).max(512), revision: z.number().int().min(1).max(1024), mode: z.literal("execute"),
  selection: harnessNativePolicySelectionSchema, observed_at: z.string().datetime({offset: true}),
  native_source: z.string().regex(/^[a-z][a-z0-9_.]{0,127}$/), native_permission_mode: z.string().min(1).max(128)}).strict();
export type HarnessNativePolicyControlOperation = z.infer<typeof harnessNativePolicyControlOperationSchema>;
export type HarnessNativePolicyControlResult = z.infer<typeof harnessNativePolicyControlResultSchema>;
