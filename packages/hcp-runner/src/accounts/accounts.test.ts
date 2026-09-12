import assert from "node:assert/strict";
import test from "node:test";
import { RunnerConfigSchema, ProviderInstanceConfigSchema } from "../config/index.js";
import { AccountUsageReader, normalizeCodexUsage, normalizeClaudeUsage, type AccountReadContext, type AccountCollector } from "./index.js";

const context = (driver = "codex", host = "one", scope?: string): AccountReadContext => ({
  provider: ProviderInstanceConfigSchema.parse({ id: "work", driver_kind: driver, account_usage: { ...(scope ? { scope_id: scope } : {}) } }),
  hostId: host, signal: new AbortController().signal,
});
const account = { account: { type: "chatgpt", email: "employee@example.com", planType: "pro", secret: "must-not-leak" } };
const rawLimits = { rateLimits: { primary: { usedPercent: 99, resetsAt: 1890000000 } }, rateLimitsByLimitId: {
  codex: { primary: { usedPercent: 95, resetsAt: 1890000000, windowDurationMins: 300 }, secondary: { usedPercent: null } },
  spark: { primary: { usedPercent: 20, resetsAt: 1890000000 } },
} };

test("Codex normalizes all buckets, missing values and seconds without leaking identity or secrets", () => {
  const value = normalizeCodexUsage(context(), account, rawLimits);
  assert.equal(value.status, "available");
  if (value.status !== "available") throw new Error("Expected available");
  assert.equal(value.limits.length, 3);
  assert.equal(value.limits[0]?.used_percent, 95);
  assert.equal(value.limits[1]?.used_percent, undefined);
  assert.equal(value.limits[0]?.resets_at, new Date(1890000000 * 1000).toISOString());
  assert.ok(!JSON.stringify(value).includes("employee@example.com"));
  assert.ok(!JSON.stringify(value).includes("must-not-leak"));
  assert.notEqual(value.account.key, (normalizeCodexUsage(context("codex", "two"), account, rawLimits) as typeof value).account.key);
  const a = normalizeCodexUsage(context("codex", "one", "workspace-a"), account, rawLimits);
  const b = normalizeCodexUsage(context("codex", "two", "workspace-a"), account, rawLimits);
  assert.deepEqual(a.status === "available" && a.account, b.status === "available" && b.account);
  const changed = normalizeCodexUsage(context("codex", "one", "workspace-a"), { account: { ...account.account, email: "different@example.com" } }, rawLimits);
  assert.notEqual(a.status === "available" && a.account.key, changed.status === "available" && changed.account.key);
});

test("API-key and unauthenticated accounts never report subscription quota", () => {
  assert.equal(normalizeCodexUsage(context(), { account: null }, {}).status, "unavailable");
  assert.equal(normalizeCodexUsage(context(), { account: { type: "apiKey" } }, {}).status, "unavailable");
});

test("Claude uses organization identity, all model windows and preserves missing amounts", () => {
  const value = normalizeClaudeUsage(context("claude"), { email: "member@example.com", organization: "org-one" }, {
    subscription_type: "max", rate_limits_available: true, rate_limits: {
      five_hour: { utilization: 96, resets_at: "2027-01-01T12:00:00Z" },
      seven_day: { utilization: null, resets_at: null },
      model_scoped: [{ display_name: "Fable", utilization: 50, resets_at: null }],
      extra_usage: { is_enabled: true, utilization: 101 },
    },
  });
  assert.equal(value.status, "available");
  if (value.status !== "available") throw new Error("Expected available");
  assert.equal(value.account.scope_source, "provider");
  assert.equal(value.limits.length, 4);
  assert.equal(value.limits[1]?.used_percent, undefined);
  assert.equal(value.limits[3]?.kind, "spend");
});

test("reader is opt-in, coalesces concurrent reads, caches original timestamps and sanitizes failures", async () => {
  let calls = 0;
  const collector: AccountCollector = async ctx => { calls++; await new Promise(resolve => setTimeout(resolve, 20)); return normalizeCodexUsage(ctx, account, rawLimits); };
  const config = RunnerConfigSchema.parse({ runner_id: "host", control_plane_url: "ws://localhost:1", provider_instances: [
    { id: "work", driver_kind: "codex", account_usage: {} }, { id: "private", driver_kind: "codex" },
  ] });
  const reader = new AccountUsageReader(config, { collectors: new Map([["codex", collector]]) });
  const [first, second] = await Promise.all([reader.read("a", {}), reader.read("b", {})]);
  assert.equal(calls, 1);
  assert.deepEqual(first.providers, second.providers);
  assert.equal(first.providers[1]?.observation.status, "unavailable");
  assert.equal((await reader.read("c", {})).providers[0]?.observation.observed_at, first.providers[0]?.observation.observed_at);
  await assert.rejects(reader.read("bad", { provider_instance_ids: ["unknown"] }));
  await reader.close();
  const failing = new AccountUsageReader(config, { collectors: new Map([["codex", async () => { throw new Error("secret-token /private/path"); }]]) });
  const result = await failing.read("failure", {});
  assert.ok(!JSON.stringify(result).includes("secret-token"));
  assert.equal(result.providers[0]?.observation.status, "unavailable");
  await failing.close();
});

test("collector abort is propagated and returned as timeout", async () => {
  const config = RunnerConfigSchema.parse({ runner_id: "host", control_plane_url: "ws://localhost:1", provider_instances: [{ id: "work", driver_kind: "codex", account_usage: {} }] });
  const reader = new AccountUsageReader(config, { timeoutMs: 20, collectors: new Map([["codex", async ({ signal }) => {
    await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    throw new Error("unreachable");
  }]]) });
  const result = await reader.read("timeout", {});
  const observation = result.providers[0]?.observation;
  assert.equal(observation?.status === "unavailable" && observation.reason, "timeout");
  await reader.close();
});

test("concurrent disjoint requests share one process bound and shutdown releases queued reads", async () => {
  const providers = Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, driver_kind: "codex", account_usage: {} }));
  const config = RunnerConfigSchema.parse({ runner_id: "host", control_plane_url: "ws://localhost:1", provider_instances: providers });
  let started = 0;
  const collector: AccountCollector = async () => { started++; return new Promise(() => {}); };
  const reader = new AccountUsageReader(config, { timeoutMs: 1000, collectors: new Map([["codex", collector]]) });
  const requests = providers.map(provider => reader.read(provider.id, { provider_instance_ids: [provider.id] }));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(started, 4);
  await reader.close();
  const results = await Promise.all(requests);
  assert.equal(started, 4);
  assert.ok(results.every(result => result.providers[0]?.observation.status === "unavailable"));
  await assert.rejects(reader.read("closed", {}), /closed/);
});
