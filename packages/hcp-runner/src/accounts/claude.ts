import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { accountUsageObservationSchema, type AccountLimit, type AccountUsageObservation } from "@harness-control/protocol";
import { accountIdentity, unavailable, type AccountReadContext } from "./shared.js";

const windowSchema = z.object({
  utilization: z.number().finite().nonnegative().nullable(),
  resets_at: z.iso.datetime({ offset: true }).nullable(),
});
const accountSchema = z.object({
  email: z.string().optional(), organization: z.string().optional(), subscriptionType: z.string().optional(),
});
const usageSchema = z.object({
  subscription_type: z.string().nullable(), rate_limits_available: z.boolean(),
  rate_limits: z.object({
    five_hour: windowSchema.nullable().optional(), seven_day: windowSchema.nullable().optional(),
    seven_day_oauth_apps: windowSchema.nullable().optional(), seven_day_opus: windowSchema.nullable().optional(),
    seven_day_sonnet: windowSchema.nullable().optional(),
    model_scoped: z.array(windowSchema.extend({ display_name: z.string() })).optional(),
    extra_usage: z.object({ is_enabled: z.boolean(), utilization: z.number().finite().nonnegative().nullable() }).nullable().optional(),
  }).nullable(),
});

export function normalizeClaudeUsage(context: AccountReadContext, accountInput: unknown, usageInput: unknown): AccountUsageObservation {
  const account = accountSchema.parse(accountInput);
  const usage = usageSchema.parse(usageInput);
  if (!usage.rate_limits_available || !usage.rate_limits) return unavailable("not_applicable", "Claude did not expose subscription rate limits for this account.");
  const limits: AccountLimit[] = [];
  const addWindow = (id: string, label: string, window: z.infer<typeof windowSchema>, minutes: number): void => {
    limits.push({ id, label, kind: "quota", window_minutes: minutes,
      ...(window.utilization !== null ? { used_percent: window.utilization } : {}),
      ...(window.resets_at !== null ? { resets_at: window.resets_at } : {}),
    });
  };
  for (const key of ["five_hour", "seven_day", "seven_day_oauth_apps", "seven_day_opus", "seven_day_sonnet"] as const) {
    const window = usage.rate_limits[key];
    if (window) addWindow(key, key.replaceAll("_", " "), window, key === "five_hour" ? 300 : 10080);
  }
  for (const window of usage.rate_limits.model_scoped ?? []) addWindow(`model:${window.display_name}`, window.display_name, window, 10080);
  const extra = usage.rate_limits.extra_usage;
  if (extra?.is_enabled) limits.push({ id: "extra_usage", label: "Extra usage budget", kind: "spend",
    ...(extra.utilization !== null ? { used_percent: extra.utilization } : {}),
  });
  return accountUsageObservationSchema.parse({
    status: "available", observed_at: new Date().toISOString(), source: "claude_sdk_experimental",
    account: accountIdentity(context, account.email, account.organization),
    ...(usage.subscription_type ? { plan: usage.subscription_type } : {}), limits,
  });
}

export async function readClaudeAccount(context: AccountReadContext): Promise<AccountUsageObservation> {
  if (!context.provider.account_usage?.allow_experimental_claude) {
    return unavailable("unsupported", "Claude account reads require explicit opt-in to the pinned experimental SDK usage API.");
  }
  context.signal.throwIfAborted();
  let finishInput!: () => void;
  const inputFinished = new Promise<void>(resolve => { finishInput = resolve; });
  async function* noPrompts(): AsyncGenerator<SDKUserMessage> { await inputFinished; }
  const controller = new AbortController();
  const abort = (): void => { controller.abort(); finishInput(); };
  context.signal.addEventListener("abort", abort, { once: true });
  try {
  const session = query({ prompt: noPrompts(), options: {
    abortController: controller, persistSession: false, settingSources: [], settings: { disableAllHooks: true }, tools: [],
    mcpServers: {}, strictMcpConfig: true, permissionMode: "dontAsk",
    ...(context.provider.executable_path ? { pathToClaudeCodeExecutable: context.provider.executable_path } : {}),
    env: { ...process.env, ...context.provider.env,
      ...(context.provider.home ? { CLAUDE_CONFIG_DIR: context.provider.home } : {}),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    },
    extraArgs: { "no-session-persistence": null, "disable-slash-commands": null },
    stderr: () => {},
  } });
  try {
    const account = await session.accountInfo();
    const usage = await session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
    return normalizeClaudeUsage(context, account, usage);
  } finally {
    finishInput();
    session.close();
  }
  } finally {
    context.signal.removeEventListener("abort", abort);
  }
}
