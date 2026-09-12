# Account capacity reference app

Run from the repository root with Node 22+:

```sh
npm install
npm run build
npm run demo:accounts
```

Open the private loopback URL printed by the command. It contains a per-process access token in its fragment. The app starts a real HCP runner and WebSocket consumer, reads the local Codex login without sending prompts, polls every minute, and displays provider windows, freshness, decisions and renewals. It does not change billing or run agent tasks.

```sh
npm run demo:accounts -- --experimental-claude --port 8795 --state /absolute/path/accounts.json
npm run demo:accounts -- --config /absolute/path/runner.json
```

Without a config, Codex collection is enabled and Claude requires the explicit experimental flag. With a config, provider instances and their local `account_usage` opt-in control collection; the file is not changed. Different provider homes can represent existing separate accounts. No account is created or switched. Use an organization-approved scope id consistently across machines to deduplicate Codex identities; that scope is operator-asserted. The app retains hashed account keys, labels, limits, policy and up to 168 hourly observations in `~/.hcp-runner/account-dashboard.json` by default. Account keys are pseudonymous, not anonymous.

The state file is process-exclusive and durably replaced. Stop cleanly with Ctrl-C. If a process crashes, inspect the PID in its `.lock` and confirm it has stopped before removing the lock. Use different state files for independent instances. This is a local reference app; production hosts provide authentication, employee mapping, tenant isolation, retention, budgets and scheduling.

## Policy and billing inputs

The policy form changes threshold/reset waiting time and persists it. Export current settings as the starting point for imports. The authoritative JSON schemas are exported by `@harness-control/management` and `dashboardSettingsSchema` in `src/server.ts`.

A settings file has this shape:

```json
{
  "policy": {
    "threshold_percent": 95,
    "reset_grace_minutes": 30,
    "max_observation_age_seconds": 300,
    "renewal_notice_days": 7
  },
  "billing": [],
  "renewals": []
}
```

Each `billing` entry supplies:

- `account_key`: the key shown on the account card.
- `budget`: `currency`, `account_remaining_minor`, `organization_remaining_minor`.
- `quotes`: entries with `id`, `account_key`, `kind` (`upgrade` or `extra_usage`), `currency`, `incremental_cost_minor`, `valid_until`, `description`, and `coverage` containing `{limit_id, resets_at}` for all affected windows.

Each `renewals` entry supplies `account_key`, `current_plan`, `baseline_plan`, `currency`, `current_next_period_cost_minor`, `baseline_next_period_cost_minor`, optional `baseline_expected_extra_usage_minor`, `renewal_at`, and `change_deadline_at`. Money is integer minor currency units. Dates are ISO timestamps with offsets. Obtain prices, forecasts and billing dates from your actual contracts. Missing inputs cause review instead of fabricated savings.

The dashboard never executes administration. Authorized backends can use the separate [management action service](../../packages/hcp-management/README.md). Unknown or unavailable provider data is displayed explicitly and cannot trigger spending decisions.
