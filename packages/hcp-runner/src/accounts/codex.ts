import { z } from "zod";
import { accountUsageObservationSchema, type AccountLimit, type AccountUsageObservation } from "@harness-control/protocol";
import { CodexRpc } from "../harnesses/adapters/providers/codex-rpc.js";
import { accountIdentity, unavailable, type AccountReadContext } from "./shared.js";

const accountSchema = z.object({ account: z.object({
  type: z.string(), email: z.string().nullable().optional(), planType: z.string().nullable().optional(),
}).nullable() });
const windowSchema = z.object({
  usedPercent: z.number().finite().nonnegative().nullable().optional(),
  windowDurationMins: z.number().int().positive().nullable().optional(),
  resetsAt: z.number().int().nonnegative().nullable().optional(),
});
const bucketSchema = z.object({
  limitId: z.string().nullable().optional(), limitName: z.string().nullable().optional(),
  primary: windowSchema.nullable().optional(), secondary: windowSchema.nullable().optional(),
});
const limitsSchema = z.object({
  rateLimits: bucketSchema.nullable().optional(),
  rateLimitsByLimitId: z.record(z.string(), bucketSchema).nullable().optional(),
});

export function normalizeCodexUsage(context: AccountReadContext, accountInput: unknown, limitsInput: unknown): AccountUsageObservation {
  const { account } = accountSchema.parse(accountInput);
  if (!account) return unavailable("unauthenticated", "Sign in with Codex before reading account usage.");
  if (account.type !== "chatgpt") return unavailable("not_applicable", "Subscription quota is unavailable for this authentication mode.");
  const response = limitsSchema.parse(limitsInput);
  const buckets = response.rateLimitsByLimitId ?? (response.rateLimits ? { [response.rateLimits.limitId ?? "codex"]: response.rateLimits } : {});
  const limits: AccountLimit[] = [];
  for (const [bucketId, bucket] of Object.entries(buckets)) {
    for (const [name, window] of [["primary", bucket.primary], ["secondary", bucket.secondary]] as const) {
      if (!window) continue;
      limits.push({
        id: `${bucketId}:${name}`, label: `${bucket.limitName ?? bucketId} · ${name}`, kind: "quota",
        ...(window.usedPercent != null ? { used_percent: window.usedPercent } : {}),
        ...(window.resetsAt != null ? { resets_at: new Date(window.resetsAt * 1000).toISOString() } : {}),
        ...(window.windowDurationMins != null ? { window_minutes: window.windowDurationMins } : {}),
      });
    }
  }
  return accountUsageObservationSchema.parse({
    status: "available", observed_at: new Date().toISOString(), source: "codex_app_server",
    account: accountIdentity(context, account.email ?? undefined),
    ...(account.planType ? { plan: account.planType } : {}), limits,
  });
}

export async function readCodexAccount(context: AccountReadContext): Promise<AccountUsageObservation> {
  context.signal.throwIfAborted();
  const rpc = new CodexRpc(context.provider.executable_path ?? "codex", process.cwd(), {
    ...process.env, ...context.provider.env,
    ...(context.provider.home ? { CODEX_HOME: context.provider.home } : {}),
  });
  const abort = (): void => { void rpc.process.stop(); };
  context.signal.addEventListener("abort", abort, { once: true });
  try {
    await rpc.request("initialize", { clientInfo: { name: "hcp-account-usage", version: "1" }, capabilities: {} });
    rpc.notify("initialized");
    const account = accountSchema.parse(await rpc.request("account/read", { refreshToken: false }));
    if (!account.account || account.account.type !== "chatgpt") return normalizeCodexUsage(context, account, {});
    const limits: unknown = await rpc.request("account/rateLimits/read", {});
    const after = accountSchema.parse(await rpc.request("account/read", { refreshToken: false }));
    if (JSON.stringify(account) !== JSON.stringify(after)) return unavailable("provider_error", "Account changed during collection; read again.");
    return normalizeCodexUsage(context, account, limits);
  } finally {
    context.signal.removeEventListener("abort", abort);
    await rpc.process.stop();
  }
}
