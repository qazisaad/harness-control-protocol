import {z} from "zod";
import {harnessNativePolicySelectionSchema, hcpConversationResultPayloadSchema, nativePolicySelectionKey} from "@harness-control/protocol";

/** This receipt authorizes an in-place scope change, never equality of native transcript revisions. */
export const nativePolicyControlReceiptSchema = z.object({command_id: z.string().min(1).max(512),
  source_session_id: z.string().min(1).max(512), native_reference: z.string().min(1).max(512),
  request_hash: z.string().regex(/^[a-f0-9]{64}$/), source_binding_hash: z.string().regex(/^[a-f0-9]{64}$/),
  target_binding_hash: z.string().regex(/^[a-f0-9]{64}$/), source_revision: z.number().int().min(0).max(1023),
  execution_inventory_hash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  selection: harnessNativePolicySelectionSchema, phase: z.enum(["pending", "completed"]),
  result: hcpConversationResultPayloadSchema.optional()}).strict().refine(value => value.source_binding_hash !== value.target_binding_hash,
    "A policy control must change its execution binding.").refine(value => value.phase === "pending" ? !value.result
    : !!value.execution_inventory_hash && value.result?.command_id === value.command_id && value.result.session_id === value.source_session_id
      && value.result.operation === "policy" && value.result.policy?.native_reference === value.native_reference
      && value.result.policy.revision === value.source_revision + 1
      && nativePolicySelectionKey(value.result.policy.selection) === nativePolicySelectionKey(value.selection),
    "Native policy confirmation must match its retained dispatch.");
export const nativePolicyControlReceiptsSchema = z.array(nativePolicyControlReceiptSchema).max(1024).superRefine((values, context) => {
  const commands = new Set<string>();
  const owners = new Map<string, NativePolicyControlReceipt>();
  values.forEach((receipt, index) => {
    const previous = owners.get(receipt.source_session_id);
    if (commands.has(receipt.command_id) || receipt.source_revision !== (previous ? previous.source_revision + 1 : 0)
      || previous && (previous.native_reference !== receipt.native_reference || previous.target_binding_hash !== receipt.source_binding_hash)
      || index > 0 && values[index - 1]?.phase !== "completed")
      context.addIssue({code: "custom", path: [index], message: "Policy control revisions must form a unique ordered confirmed chain."});
    commands.add(receipt.command_id);
    owners.set(receipt.source_session_id, receipt);
  });
});
export type NativePolicyControlReceipt = z.infer<typeof nativePolicyControlReceiptSchema>;
