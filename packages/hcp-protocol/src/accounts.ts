import { z } from "zod";

const id = z.string().min(1).max(256);
const timestamp = z.iso.datetime({ offset: true });

export const accountIdentitySchema = z.object({
  key: id,
  provider: id,
  scope_source: z.enum(["provider", "operator", "local"]),
  label: z.string().min(1).max(256),
}).strict();
export type AccountIdentity = z.infer<typeof accountIdentitySchema>;

export const accountLimitSchema = z.object({
  id,
  label: z.string().min(1).max(256),
  kind: z.enum(["quota", "spend"]),
  used_percent: z.number().finite().nonnegative().optional(),
  resets_at: timestamp.optional(),
  window_minutes: z.number().int().positive().optional(),
}).strict();
export type AccountLimit = z.infer<typeof accountLimitSchema>;

export const accountUsageAvailableSchema = z.object({
  status: z.literal("available"),
  observed_at: timestamp,
  account: accountIdentitySchema,
  source: z.enum(["codex_app_server", "claude_sdk_experimental"]),
  plan: id.optional(),
  limits: z.array(accountLimitSchema).max(64),
}).strict().superRefine((value, context) => {
  if (new Set(value.limits.map(limit => limit.id)).size !== value.limits.length) {
    context.addIssue({ code: "custom", path: ["limits"], message: "Limit ids must be unique." });
  }
});
export type AccountUsageAvailable = z.infer<typeof accountUsageAvailableSchema>;

export const accountUsageUnavailableSchema = z.object({
  status: z.literal("unavailable"),
  observed_at: timestamp,
  reason: z.enum(["disabled", "unsupported", "unauthenticated", "not_applicable", "timeout", "provider_error", "invalid_response"]),
  message: z.string().min(1).max(512),
}).strict();
export const accountUsageObservationSchema = z.discriminatedUnion("status", [
  accountUsageAvailableSchema, accountUsageUnavailableSchema,
]);
export type AccountUsageObservation = z.infer<typeof accountUsageObservationSchema>;

export const hcpAccountsReadPayloadSchema = z.object({
  provider_instance_ids: z.array(id).min(1).max(32).optional(),
}).strict().superRefine((value, context) => {
  if (value.provider_instance_ids && new Set(value.provider_instance_ids).size !== value.provider_instance_ids.length) {
    context.addIssue({ code: "custom", path: ["provider_instance_ids"], message: "Provider ids must be unique." });
  }
});
export type HcpAccountsReadPayload = z.infer<typeof hcpAccountsReadPayloadSchema>;

export const accountProviderReadingSchema = z.object({
  provider_instance_id: id,
  observation: accountUsageObservationSchema,
}).strict();
export type AccountProviderReading = z.infer<typeof accountProviderReadingSchema>;

export const hcpAccountsSnapshotPayloadSchema = z.object({
  request_id: id,
  host_id: id,
  providers: z.array(accountProviderReadingSchema).max(32),
}).strict().superRefine((value, context) => {
  if (new Set(value.providers.map(provider => provider.provider_instance_id)).size !== value.providers.length) {
    context.addIssue({ code: "custom", path: ["providers"], message: "Provider ids must be unique." });
  }
});
export type HcpAccountsSnapshotPayload = z.infer<typeof hcpAccountsSnapshotPayloadSchema>;

export const accountSourceStateSchema = z.object({
  host_id: id,
  provider_instance_id: id,
  latest: accountUsageObservationSchema,
  last_success: accountUsageAvailableSchema.optional(),
}).strict().superRefine((state, context) => {
  if (state.latest.status === "available" && JSON.stringify(state.latest) !== JSON.stringify(state.last_success)) {
    context.addIssue({ code: "custom", message: "An available source must retain the same successful observation." });
  }
  if (state.last_success && Date.parse(state.last_success.observed_at) > Date.parse(state.latest.observed_at)) {
    context.addIssue({ code: "custom", message: "Successful observation cannot be newer than the latest observation." });
  }
});
export type AccountSourceState = z.infer<typeof accountSourceStateSchema>;
export type AccountUsageView = {
  account: AccountIdentity;
  observation: AccountUsageAvailable;
  freshness: "fresh" | "stale" | "unavailable";
  sources: Array<{ host_id: string; provider_instance_id: string }>;
};

/** Store this projection in application storage; quota snapshots are never added together. */
export class HcpAccountUsageReducer {
  readonly #sources = new Map<string, AccountSourceState>();

  constructor(state: readonly AccountSourceState[] = []) {
    for (const input of state) {
      const source: AccountSourceState = accountSourceStateSchema.parse(input);
      const key = sourceKey(source.host_id, source.provider_instance_id);
      if (this.#sources.has(key)) throw new Error("Duplicate account source.");
      this.#sources.set(key, source);
    }
  }

  apply(input: HcpAccountsSnapshotPayload): void {
    const snapshot: HcpAccountsSnapshotPayload = hcpAccountsSnapshotPayloadSchema.parse(input);
    for (const reading of snapshot.providers) {
      const key: string = sourceKey(snapshot.host_id, reading.provider_instance_id);
      const existing: AccountSourceState | undefined = this.#sources.get(key);
      if (existing && Date.parse(existing.latest.observed_at) >= Date.parse(reading.observation.observed_at)) continue;
      const success: AccountUsageAvailable | undefined = reading.observation.status === "available"
        ? reading.observation : existing?.last_success;
      this.#sources.set(key, {
        host_id: snapshot.host_id, provider_instance_id: reading.provider_instance_id,
        latest: structuredClone(reading.observation), ...(success ? { last_success: structuredClone(success) } : {}),
      });
    }
  }

  removeSource(hostId: string, providerInstanceId: string): void {
    this.#sources.delete(sourceKey(hostId, providerInstanceId));
  }

  snapshot(): AccountSourceState[] {
    return structuredClone([...this.#sources.values()]);
  }

  accounts(now: Date, maxAgeMs: number): AccountUsageView[] {
    if (!Number.isFinite(now.getTime()) || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0) throw new Error("Invalid freshness bounds.");
    const grouped = new Map<string, AccountSourceState[]>();
    for (const source of this.#sources.values()) {
      if (!source.last_success) continue;
      const key: string = source.last_success.account.key;
      const sources: AccountSourceState[] = grouped.get(key) ?? [];
      sources.push(source);
      grouped.set(key, sources);
    }
    return [...grouped.values()].map(sources => {
      const selected = sources.reduce((a, b) => Date.parse(a.last_success!.observed_at) >= Date.parse(b.last_success!.observed_at) ? a : b);
      const observation: AccountUsageAvailable = structuredClone(selected.last_success!);
      const age: number = now.getTime() - Date.parse(observation.observed_at);
      const freshness = selected.latest.status !== "available" ? "unavailable" : age < 0 || age > maxAgeMs ? "stale" : "fresh";
      return {
        account: observation.account, observation, freshness,
        sources: sources.map(source => ({ host_id: source.host_id, provider_instance_id: source.provider_instance_id })),
      };
    });
  }
}

function sourceKey(hostId: string, providerId: string): string {
  return JSON.stringify([hostId, providerId]);
}
