import {z} from "zod";

const identity = z.string().min(1).max(512);
/** Private admission evidence authorizes transcript inspection, never physical execution recovery. */
export const nativeWorkCustodySchema = z.object({
  source: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/),
  work_id: identity,
  native_reference: identity,
  origin_turn_id: identity,
  parent_work_id: identity.optional(),
  root_native_reference: identity,
  parent_native_reference: identity,
  launch_native_reference: identity,
  native_execution_reference: identity.optional(),
}).strict();
export type NativeWorkCustody = z.infer<typeof nativeWorkCustodySchema>;
