import assert from "node:assert/strict";
import test from "node:test";
import { RunnerConfigSchema } from "@harness-control/runner/config";
import { normalizeCodexUsage, type AccountCollector } from "@harness-control/runner/accounts";
import { startAccountsDashboard } from "./server.js";

async function settled(dashboard: Awaited<ReturnType<typeof startAccountsDashboard>>): Promise<void> {
  for (let attempt = 0; !dashboard.state().connected && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  while (dashboard.state().collecting) await new Promise(resolve => setTimeout(resolve, 5));
}

test("real runner → WebSocket → SDK reducer → authenticated read-only dashboard, failure preservation and restart", async () => {
  let reads = 0;
  let failing = false;
  const collector: AccountCollector = async context => {
    reads++;
    await new Promise(resolve => setTimeout(resolve, 5));
    if (failing) throw new Error("private provider error");
    return normalizeCodexUsage(context, { account: { type: "chatgpt", email: "test@example.com", planType: "pro" } }, {
      rateLimits: { primary: { usedPercent: 96, resetsAt: Math.ceil(Date.now() / 1000) + 86400, windowDurationMins: 10080 } },
    });
  };
  const config = RunnerConfigSchema.parse({ runner_id: "test-runner", control_plane_url: "ws://localhost:1", provider_instances: [
    { id: "first", driver_kind: "account-fixture", account_usage: { scope_id: "work" } },
    { id: "second", driver_kind: "account-fixture", account_usage: { scope_id: "work" } },
  ] });
  const collectors = new Map([["account-fixture", collector]]);
  let dashboard = await startAccountsDashboard({ config, collectors });
  try {
    await settled(dashboard);
    const initialReads = reads;
    await Promise.all([dashboard.refresh(), dashboard.refresh()]);
    assert.equal(reads - initialReads, 2, "concurrent refreshes coalesce into one read of both providers");
    assert.equal(dashboard.state().accounts.length, 1, "same scoped account on two sources is one account");
    assert.equal(dashboard.state().accounts[0]?.sources.length, 2);
    assert.equal(dashboard.state().accounts[0]?.freshness, "fresh");
    assert.equal(dashboard.state().accounts[0]?.observation.limits[0]?.used_percent, 96);

    assert.equal((await fetch(`${dashboard.origin}/api/state`)).status, 403);
    const headers = { authorization: `Bearer ${dashboard.token}` };
    const state = await fetch(`${dashboard.origin}/api/state`, { headers });
    assert.equal(state.status, 200);
    const body = await state.text();
    assert.ok(!body.includes("test@example.com"), "provider email never reaches the page");
    assert.ok(!body.includes("decision") && !body.includes("settings"), "no policy or billing fields remain");
    assert.equal((await fetch(`${dashboard.origin}/api/refresh`, { method: "POST", headers: { ...headers, origin: "https://attacker.example" } })).status, 403);
    assert.equal((await fetch(`${dashboard.origin}/api/settings`, { method: "PUT", headers, body: "{}" })).status, 404);

    failing = true;
    await dashboard.refresh();
    assert.equal(dashboard.state().accounts[0]?.freshness, "unavailable");
    assert.equal(dashboard.state().accounts[0]?.observation.limits[0]?.used_percent, 96, "last successful observation is retained as history");
    assert.ok(!JSON.stringify(dashboard.state()).includes("private provider error"), "raw provider errors are not exposed");
    failing = false;
    await dashboard.close();
    dashboard = await startAccountsDashboard({ config, collectors });
    await settled(dashboard);
    assert.equal(dashboard.state().accounts.length, 1, "restart obtains a fresh read; nothing is loaded from disk");
    assert.equal(dashboard.state().accounts[0]?.freshness, "fresh");
  } finally { await dashboard.close(); }
});
