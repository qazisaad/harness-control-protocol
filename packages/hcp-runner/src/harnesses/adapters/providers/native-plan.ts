import {harnessNativePlanStepsSchema, harnessNativePlanObservationSchema, harnessNativePlanProposalInputSchema, type HarnessNativePlanProposalInput, type HarnessNativePlanObservation, type HarnessNativePlanStep} from "@harness-control/protocol";
import {z} from "zod";
import {retainedContent, type ContentPublisher} from "./content-projection.js";

type Binding = {observation: "snapshot" | "tool_input"; native_reference: string; native_item_reference?: string; native_execution_reference?: string; explanation?: string};
const statuses: Readonly<Record<string, HarnessNativePlanStep["status"]>> = {
  pending: "pending", inProgress: "running", in_progress: "running", completed: "completed", cancelled: "cancelled",
};
const rows = z.array(z.object({status: z.string().min(1).max(128), step: z.string().optional(), content: z.string().optional(),
  activeForm: z.string().optional(), priority: z.string().min(1).max(128).optional()}).passthrough()).max(4096);
/** Only a complete, interpretable native array becomes structured evidence. Raw native content remains available separately. */
export function nativePlanObservation(kind: "execution_plan" | "todo_list", value: unknown, binding: Binding,
  publish?: ContentPublisher): HarnessNativePlanObservation | undefined {
  const parsed = rows.safeParse(value);
  if (!parsed.success) return;
  const steps = parsed.data.map((row, index) => ({index, text: kind === "execution_plan" ? row.step : row.content,
    status: statuses[row.status] ?? "unknown",
    native_status: row.status, ...(row.activeForm === undefined ? {} : {active_form: row.activeForm}),
    ...(row.priority === undefined ? {} : {priority: row.priority})}));
  const normalized = harnessNativePlanStepsSchema.safeParse(steps);
  if (!normalized.success) return;
  const {explanation, ...identity} = binding;
  const observation = harnessNativePlanObservationSchema.safeParse({source: "native", kind, ...identity,
    ...(explanation === undefined ? {} : {explanation: retainedContent(explanation, publish)}),
    steps: retainedContent(normalized.data, publish)});
  return observation.success ? observation.data : undefined;
}


/** Read only a body actually supplied by the native tool. Never infer it from a file or a preview. */
export function nativePlanProposalInput(value: unknown, identity: {native_reference: string; native_item_reference: string; request_reference?: string},
  publish?: ContentPublisher): HarnessNativePlanProposalInput | undefined {
  if (typeof value !== "string") return;
  const parsed = harnessNativePlanProposalInputSchema.safeParse({source: "native", observation: "tool_input", ...identity,
    plan: retainedContent(value, publish)});
  return parsed.success ? parsed.data : undefined;
}
