import assert from "node:assert/strict";
import test from "node:test";
import { HcpAccountUsageReducer, hcpAccountsSnapshotPayloadSchema, type AccountUsageAvailable } from "./accounts.js";
import { createHcpEnvelope, parseHcpMessage } from "./index.js";

const at = (minute: number): string => `2026-09-12T10:${String(minute).padStart(2, "0")}:00Z`;
const available = (minute: number, key = "account-a", used = 95): AccountUsageAvailable => ({
  status: "available", observed_at: at(minute), account: { key, provider: "codex", scope_source: "operator", label: "Work" },
  source: "codex_app_server", limits: [{ id: "weekly", label: "Weekly", kind: "quota", used_percent: used, resets_at: "2026-09-19T00:00:00Z" }],
});
const reading = (host: string, observation: AccountUsageAvailable) => ({ request_id: "read", host_id: host, providers: [{ provider_instance_id: "provider", observation }] });

test("account reads require no task and reject secrets, duplicate identities and malformed limits", () => {
  assert.equal(parseHcpMessage(createHcpEnvelope("host.accounts.read", {})).type, "host.accounts.read");
  const snapshot = reading("one", available(1));
  assert.equal(parseHcpMessage(createHcpEnvelope("host.accounts.snapshot", snapshot)).type, "host.accounts.snapshot");
  assert.throws(() => hcpAccountsSnapshotPayloadSchema.parse({ ...snapshot, providers: [...snapshot.providers, ...snapshot.providers] }));
  assert.throws(() => hcpAccountsSnapshotPayloadSchema.parse(reading("one", { ...available(1), limits: [...available(1).limits, ...available(1).limits] })));
  assert.throws(() => parseHcpMessage(createHcpEnvelope("host.accounts.snapshot", { ...snapshot, token: "secret" })));
  assert.throws(() => hcpAccountsSnapshotPayloadSchema.parse(reading("one", { ...available(1), limits: [{ id: "w", label: "W", kind: "quota", used_percent: -1 }] })));
});

test("multiple machines share one account; snapshots are replaced, never summed", () => {
  const reducer = new HcpAccountUsageReducer();
  reducer.apply(reading("one", available(1, "a", 50)));
  reducer.apply(reading("two", available(2, "a", 60)));
  const accounts = reducer.accounts(new Date(at(3)), 300000);
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0]?.observation.limits[0]?.used_percent, 60);
  assert.equal(accounts[0]?.sources.length, 2);
  reducer.apply(reading("one", available(0, "a", 99)));
  assert.equal(reducer.accounts(new Date(at(3)), 300000)[0]?.observation.limits[0]?.used_percent, 60);
  assert.deepEqual(new HcpAccountUsageReducer(reducer.snapshot()).snapshot(), reducer.snapshot());
});

test("failed reads preserve history but suppress action; omission cannot delete; account switches change identity", () => {
  const reducer = new HcpAccountUsageReducer();
  reducer.apply(reading("one", available(1)));
  reducer.apply({ request_id: "failed", host_id: "one", providers: [{ provider_instance_id: "provider", observation: {
    status: "unavailable", observed_at: at(2), reason: "provider_error", message: "Unavailable",
  } }] });
  reducer.apply({ request_id: "empty", host_id: "one", providers: [] });
  assert.equal(reducer.accounts(new Date(at(3)), 300000)[0]?.freshness, "unavailable");
  assert.equal(reducer.snapshot()[0]?.last_success?.limits[0]?.used_percent, 95);
  reducer.apply(reading("one", available(3, "new-account")));
  assert.equal(reducer.accounts(new Date(at(4)), 300000)[0]?.account.key, "new-account");
  assert.equal(reducer.accounts(new Date(at(20)), 300000)[0]?.freshness, "stale");
  reducer.removeSource("one", "provider");
  assert.equal(reducer.snapshot().length, 0);
});

test("successful empty limits replace prior windows and future observations are not fresh", () => {
  const reducer = new HcpAccountUsageReducer();
  reducer.apply(reading("one", available(1)));
  reducer.apply(reading("one", { ...available(2), limits: [] }));
  assert.deepEqual(reducer.accounts(new Date(at(3)), 300000)[0]?.observation.limits, []);
  assert.equal(reducer.accounts(new Date(at(1)), 300000)[0]?.freshness, "stale");
});
