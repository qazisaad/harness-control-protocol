import { z } from "zod";

const amount = z.string().regex(/^(0|[1-9][0-9]*)$/).max(18);
export const spendLimitStateSchema = z.object({
  amount_minor: amount.nullable(), currency: z.string().regex(/^[A-Z]{3}$/),
  source: z.enum(["user", "inherited"]), override_id: z.string().min(1).nullable(),
}).strict().refine(state => (state.source === "user") === (state.override_id !== null), "Only user overrides have an override id.");
export type SpendLimitState = z.infer<typeof spendLimitStateSchema>;

export const spendLimitActionSchema = z.object({
  id: z.string().min(1).max(256), organization_id: z.string().min(1).max(256),
  user_id: z.string().regex(/^user_[A-Za-z0-9]+$/),
  expected: spendLimitStateSchema,
  desired: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("set"), amount_minor: amount }).strict(),
    z.object({ kind: z.literal("restore_inherited") }).strict(),
  ]),
  expires_at: z.iso.datetime({ offset: true }),
}).strict();
export type SpendLimitAction = z.infer<typeof spendLimitActionSchema>;

export const spendLimitActionRecordSchema = z.object({
  action: spendLimitActionSchema,
  authorized_by: z.string().min(1),
  status: z.enum(["pending", "applied", "rejected", "unknown"]),
  updated_at: z.iso.datetime({ offset: true }),
  message: z.string().min(1).max(512),
}).strict();
export type SpendLimitActionRecord = z.infer<typeof spendLimitActionRecordSchema>;

/** Implement claim atomically, enforcing both action-id uniqueness and a lock per organization/member. */
export interface SpendLimitActionStore {
  claim(record: SpendLimitActionRecord): Promise<{ claimed: boolean; record: SpendLimitActionRecord }>;
  get(id: string): Promise<SpendLimitActionRecord>;
  settle(record: SpendLimitActionRecord): Promise<void>;
}

export interface SpendLimitAdmin {
  readonly organizationId: string;
  read(userId: string): Promise<SpendLimitState>;
  apply(action: SpendLimitAction): Promise<void>;
}

export type SpendLimitAuthorization = {
  actor_id: string; organization_id: string; user_id: string;
  expires_at: string; maximum_amount_minor: string;
  allow_restore_inherited: boolean;
};
const authorizationSchema = z.object({
  actor_id: z.string().min(1), organization_id: z.string().min(1), user_id: z.string().min(1),
  expires_at: z.iso.datetime({ offset: true }), maximum_amount_minor: amount,
  allow_restore_inherited: z.boolean(),
}).strict();

/** Runs only in the organization's trusted backend. Never expose this function directly as an unauthenticated route. */
export class SpendLimitActionService {
  #executing = 0;
  constructor(private readonly store: SpendLimitActionStore, private readonly admin: SpendLimitAdmin) {}

  async execute(input: SpendLimitAction, authorization: SpendLimitAuthorization): Promise<SpendLimitActionRecord> {
    this.#executing++;
    try { return await this.#execute(input, authorization); }
    finally { this.#executing--; }
  }

  async #execute(input: SpendLimitAction, authorization: SpendLimitAuthorization): Promise<SpendLimitActionRecord> {
    const action: SpendLimitAction = spendLimitActionSchema.parse(input);
    const grant = authorizationSchema.parse(authorization);
    if (action.organization_id !== this.admin.organizationId || grant.organization_id !== action.organization_id
      || grant.user_id !== action.user_id || Date.parse(grant.expires_at) <= Date.now() || Date.parse(action.expires_at) <= Date.now()) {
      throw new Error("Spend-limit action is not authorized for this member, organization and time.");
    }
    if (action.desired.kind === "set" ? BigInt(action.desired.amount_minor) > BigInt(grant.maximum_amount_minor) : !grant.allow_restore_inherited) {
      throw new Error("Spend-limit action exceeds the authorized policy.");
    }
    const proposed: SpendLimitActionRecord = {
      action, authorized_by: grant.actor_id, status: "pending", updated_at: new Date().toISOString(), message: "Claimed before provider access.",
    };
    const claim = await this.store.claim(proposed);
    if (!claim.claimed) return claim.record;
    let writeAttempted = false;
    let record: SpendLimitActionRecord;
    try {
      const current: SpendLimitState = spendLimitStateSchema.parse(await this.admin.read(action.user_id));
      if (!sameSpendLimit(current, action.expected)) {
        record = { ...proposed, status: "rejected", message: "Provider state changed; obtain a new decision before writing." };
      } else if (Date.parse(action.expires_at) <= Date.now() || Date.parse(grant.expires_at) <= Date.now()) {
        record = { ...proposed, status: "rejected", message: "Authorization expired before the provider write." };
      } else {
        writeAttempted = true;
        await this.admin.apply(action);
        const observed: SpendLimitState = spendLimitStateSchema.parse(await this.admin.read(action.user_id));
        record = matchesDesired(action, observed)
          ? { ...proposed, status: "applied", message: "Desired spend-limit state confirmed by a provider read." }
          : { ...proposed, status: "unknown", message: "Provider did not confirm the desired state; reconcile without repeating the write." };
      }
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      record = { ...proposed, status: writeAttempted ? "unknown" : "rejected",
        message: writeAttempted ? "Provider write outcome is unknown; reconcile before further changes." : "Provider preflight failed; no write was attempted.",
      };
    }
    record.updated_at = new Date().toISOString();
    await this.store.settle(record);
    return record;
  }

  async reconcile(id: string): Promise<SpendLimitActionRecord> {
    if (this.#executing) throw new Error("Wait for active executions before reconciliation.");
    const record: SpendLimitActionRecord = await this.store.get(id);
    if (record.status === "pending" && Date.parse(record.action.expires_at) > Date.now()) throw new Error("Pending action has not expired; its executor may still be running.");
    if (record.action.organization_id !== this.admin.organizationId) throw new Error("Administration organization mismatch.");
    if (record.status === "applied" || record.status === "rejected") return record;
    const current: SpendLimitState = spendLimitStateSchema.parse(await this.admin.read(record.action.user_id));
    const next: SpendLimitActionRecord = { ...record, updated_at: new Date().toISOString(),
      status: matchesDesired(record.action, current) ? "applied" : "unknown",
      message: matchesDesired(record.action, current) ? "Reconciled desired provider state without another write." : "Desired state not confirmed; retain the member lock for operator reconciliation.",
    };
    await this.store.settle(next);
    return next;
  }
}

export function sameSpendLimit(a: SpendLimitState, b: SpendLimitState): boolean {
  return a.currency === b.currency && a.source === b.source && a.override_id === b.override_id && a.amount_minor === b.amount_minor;
}
function matchesDesired(action: SpendLimitAction, state: SpendLimitState): boolean {
  return state.currency === action.expected.currency && (action.desired.kind === "set"
    ? state.source === "user" && state.amount_minor === action.desired.amount_minor : state.source === "inherited");
}

export function claimSpendLimitAction(records: readonly SpendLimitActionRecord[], proposed: SpendLimitActionRecord): { claimed: boolean; record: SpendLimitActionRecord } {
  const existing = records.find(record => record.action.id === proposed.action.id);
  if (existing) {
    if (JSON.stringify(existing.action) !== JSON.stringify(proposed.action)) throw new Error("Action id already belongs to a different payload.");
    return { claimed: false, record: structuredClone(existing) };
  }
  if (records.some(record => record.action.organization_id === proposed.action.organization_id && record.action.user_id === proposed.action.user_id
    && (record.status === "pending" || record.status === "unknown"))) throw new Error("An unresolved action already owns this member's spend limit.");
  return { claimed: true, record: structuredClone(proposed) };
}
