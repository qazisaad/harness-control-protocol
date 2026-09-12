import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpendLimitActionService, type SpendLimitAction, type SpendLimitState, type SpendLimitAdmin } from "./actions.js";
import { JsonSpendLimitActionStore } from "./node.js";
import { ClaudeEnterpriseAdmin } from "./claude-admin.js";

const expected: SpendLimitState = { amount_minor: "1000", currency: "USD", source: "inherited", override_id: null };
const action: SpendLimitAction = { id: "increase-user-period-1", organization_id: "org", user_id: "user_Test", expected,
  desired: { kind: "set", amount_minor: "2000" }, expires_at: "2999-01-01T00:00:00Z" };
const authorization = { actor_id: "admin", organization_id: "org", user_id: "user_Test", maximum_amount_minor: "2000", allow_restore_inherited: false, expires_at: "2999-01-01T00:00:00Z" };

test("durable action claims prevent duplicate writes after restart and reconcile a lost response", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hcp-capacity-"));
  const path = join(dir, "actions.json");
  let writes = 0;
  let state: SpendLimitState = { ...expected };
  const admin: SpendLimitAdmin = { organizationId: "org", read: async () => state, apply: async () => {
    writes++; state = { amount_minor: "2000", currency: "USD", source: "user", override_id: "spl_Test" };
    throw new Error("Response lost after applied write.");
  } };
  let store = new JsonSpendLimitActionStore(path);
  try {
    const service = new SpendLimitActionService(store, admin);
    assert.equal((await service.execute(action, authorization)).status, "unknown");
    assert.equal((await service.execute(action, authorization)).status, "unknown");
    assert.equal(writes, 1);
    await assert.rejects(service.execute({ ...action, id: "another" }, authorization), /unresolved/);
    await assert.rejects(service.execute({ ...action, desired: { kind: "set", amount_minor: "1900" } }, authorization), /different payload/);
    assert.throws(() => new JsonSpendLimitActionStore(path), /EEXIST/);
    store.close(); store = new JsonSpendLimitActionStore(path);
    const recovered = new SpendLimitActionService(store, admin);
    assert.equal((await recovered.reconcile(action.id)).status, "applied");
    assert.equal((await recovered.execute(action, authorization)).status, "applied");
    assert.equal(writes, 1);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("preflight changes, authority, budget and expiry prevent writes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hcp-capacity-"));
  const store = new JsonSpendLimitActionStore(join(dir, "actions.json"));
  let writes = 0;
  const admin: SpendLimitAdmin = { organizationId: "org", read: async () => ({ ...expected, amount_minor: "1500" }), apply: async () => { writes++; } };
  try {
    const service = new SpendLimitActionService(store, admin);
    await assert.rejects(service.execute(action, { ...authorization, organization_id: "another" }), /not authorized/);
    await assert.rejects(service.execute(action, { ...authorization, maximum_amount_minor: "100" }), /exceeds/);
    await assert.rejects(service.execute({ ...action, expires_at: "2020-01-01T00:00:00Z" }, authorization), /not authorized/);
    assert.equal((await service.execute(action, authorization)).status, "rejected");
    assert.equal(writes, 0);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("Claude admin wire contract defaults to read-only, validates identities, and clears an override instead of setting unlimited", async () => {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  let amount = "1000";
  let isOverride = false;
  const mockFetch: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    assert.equal(new Headers(init?.headers).get("x-api-key"), "test-key");
    assert.equal(init?.redirect, "error");
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { amount: string };
      amount = body.amount; isOverride = true;
      return Response.json({ type: "spend_limit", id: "spl_Test", scope: { type: "user", user_id: "user_Test" }, amount, currency: "USD", period: "monthly" });
    }
    if (init?.method === "DELETE") { isOverride = false; amount = "1000"; return Response.json({ type: "spend_limit_deleted", id: "spl_Test" }); }
    return Response.json({ data: [{ scope: { type: "user", user_id: "user_Test" }, amount, currency: "USD", period: "monthly", source: { type: isOverride ? "user" : "organization" }, spend_limit_id: "spl_Test", period_to_date_spend: "950.125" }], next_page: null });
  };
  const readOnly = new ClaudeEnterpriseAdmin("org", { apiKey: "test-key", fetch: mockFetch });
  assert.deepEqual(await readOnly.read("user_Test"), expected);
  await assert.rejects(readOnly.apply(action), /disabled/);
  const dir = await mkdtemp(join(tmpdir(), "hcp-capacity-"));
  const store = new JsonSpendLimitActionStore(join(dir, "actions.json"));
  try {
    const admin = new ClaudeEnterpriseAdmin("org", { apiKey: "test-key", fetch: mockFetch, allowWrites: true });
    const service = new SpendLimitActionService(store, admin);
    assert.equal((await service.execute(action, authorization)).status, "applied");
    const restore: SpendLimitAction = { ...action, id: "restore-next-period", expected: await admin.read("user_Test"), desired: { kind: "restore_inherited" } };
    assert.equal((await service.execute(restore, { ...authorization, allow_restore_inherited: true })).status, "applied");
    assert.equal(calls.filter(call => call.method === "POST").length, 1);
    assert.equal(calls.filter(call => call.method === "DELETE").length, 1);
    assert.deepEqual(await admin.read("user_Test"), expected);
    assert.ok(calls.every(call => call.url.startsWith("https://api.anthropic.com/v1/organizations/spend_limits")));
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
