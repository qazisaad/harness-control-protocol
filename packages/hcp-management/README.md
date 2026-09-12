# @harness-control/management

Optional HCP account capacity policies and authorized Claude Enterprise spend-limit actions. Node 22+; account observations come from `@harness-control/protocol`. The root export also works in browser applications; filesystem storage is a separate `/node` export.

This package does not buy subscriptions, create accounts, rotate identities, or infer prices from tokens. Applications own employee mapping, authenticated authorization, actual billing data, scheduling, and organization-wide budget reservations.

## Capacity decisions

```ts
import { capacityPolicySchema, evaluateCapacity } from "@harness-control/management";

const policy = capacityPolicySchema.parse({ threshold_percent: 95 });
for (const view of connection.accounts.accounts(new Date(), 300_000)) {
  const decision = evaluateCapacity({ view, policy, now: new Date() });
  // Persist/display the decision. Without verified quotes and budgets it asks for review.
}
```

Provide `quotes` and `budget` to choose the lowest comparable incremental charge. Quotes name the account and exact affected limit/reset windows, currency, expiry, and all-in incremental cost in integer minor currency units. Budgets separately bound the account and organization. A recommendation is not a reservation: the host must atomically reserve funds before authorizing any effect. Stale, failed, missing or expired quota observations suppress spending recommendations. Windows resetting within the waiting period produce `wait_for_reset`.

`evaluateRenewal(contract, policy, now)` uses actual renewal/change deadlines and baseline extra-usage forecasts. It recommends the baseline only when its forecast total is cheaper. It never treats quota resets or the first of a calendar month as subscription renewal.

## Claude Enterprise administration

`ClaudeEnterpriseAdmin` implements the documented Enterprise monthly usage-credit spend-limit API. It changes a spending cap, not a subscription tier, seat count, payment, or quota allowance. An increase permits future usage charges. The SDK quota collector is independent of this organization API.

```ts
import {
  ClaudeEnterpriseAdmin, evaluateSpendIncrease, SpendLimitActionService,
  type SpendLimitAction, type SpendLimitAuthorization,
} from "@harness-control/management";
import { JsonSpendLimitActionStore } from "@harness-control/management/node";

// Values below are supplied by your authenticated backend and secret manager.
const admin = new ClaudeEnterpriseAdmin(organizationId, { apiKey, allowWrites: true });
const spend = await admin.readSpend(memberId);
const decision = evaluateSpendIncrease(spend, {
  threshold_percent: 95,
  increment_minor: configuredIncrement,
  maximum_minor: authorizedMemberCeiling,
  organization_remaining_minor: reservedOrganizationHeadroom,
});
const store = new JsonSpendLimitActionStore(actionLedgerPath);
try {
  if (decision.kind === "recommend_increase") {
    const expected = await admin.read(memberId);
    if (expected.amount_minor !== spend.amount || expected.currency !== spend.currency) {
      throw new Error("Spend policy changed during evaluation; recompute the decision.");
    }
    const action: SpendLimitAction = {
      id: persistedLogicalActionId,
      organization_id: organizationId,
      user_id: memberId,
      expected,
      desired: { kind: "set", amount_minor: decision.amount_minor },
      expires_at: authorizationExpiry,
    };
    // Persist this entire action before sending; retries reuse it unchanged.
    const grant: SpendLimitAuthorization = {
      actor_id: policyOwnerId, organization_id: organizationId, user_id: memberId,
      maximum_amount_minor: authorizedMemberCeiling,
      allow_restore_inherited: false, expires_at: authorizationExpiry,
    };
    const result = await new SpendLimitActionService(store, admin).execute(action, grant);
  }
} finally { store.close(); }
```

The example is host integration code, not a ready-to-run credential fixture. Keep one service per store. Derive grants from trusted organization policy, never from employee request bodies. Bind the organization id to its key in the secret manager. The API requires `read:spend_limits` and, for effects, `write:spend_limits`. Writes default to disabled.

Use the same action service with `desired: { kind: "set", amount_minor: baseline }` to restore a finite baseline after a verified billing-cycle transition. Alternatively, `restore_inherited` deletes a known user override and requires `allow_restore_inherited: true`; inherited policy may be unlimited, so authorize that explicitly. **Setting amount to null means unlimited, not restore** and is deliberately excluded from action inputs. Persist each cycle's logical action id; repeated scheduler deliveries must reuse its full payload. Subscription downgrades still need a provider-supported billing workflow.

## Recovery and storage

Actions move from `pending` to `applied`, `rejected`, or `unknown`. A durable claim precedes provider access. Only a confirming read produces `applied`. Repeating an id returns its stored outcome without another write; changing its payload is rejected. Pending/unknown actions lock the organization/member against subsequent actions.

A lost response after a write is `unknown`. Call `service.reconcile(id)` to read the provider without repeating the write. Pending actions cannot be reconciled before their authorization expires, and reconciliation waits for active service executions. An unresolved result retains the member lock; investigate in the organization's administration console before administrative recovery. The provider has no conditional-write contract here, so external administrator changes can race the preflight read. This is not distributed exactly-once billing.

`JsonSpendLimitActionStore` and `ExclusiveJsonFile` use a process-exclusive `.lock`, private file permissions, fsynced temporary writes, and atomic rename. An abandoned lock is not stolen: confirm its owner process has stopped, inspect/reconcile pending actions, then remove that specific lock. These are single-process reference stores. Multi-instance applications implement `SpendLimitActionStore` with transactional action-id uniqueness, member locking, and budget reservations in their database. Retention and backups belong to the host.

## Verification and scope

Tests cover quota/budget/renewal decisions, exact decimal spend arithmetic, authorization and preflight rejection, provider GET/POST/DELETE payloads, durable duplicate suppression, and reconciliation after a lost response. Provider HTTP tests use an injected fetch implementation. Enterprise live writes remain unverified without a designated test organization and admin key.

See [the account contract](../../docs/account-capacity.md) and [standalone dashboard](../../demo/accounts/README.md).
