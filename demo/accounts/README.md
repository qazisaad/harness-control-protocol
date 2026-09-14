# Account capacity reference app

Run from the repository root with Node 22+:

```sh
npm install
npm run build
npm run demo:accounts
```

Open the private loopback URL printed by the command. It contains a per-process access token in its fragment. The app starts a real HCP runner and WebSocket consumer, reads the local Codex login without sending prompts, polls every minute, and displays each account's provider windows, reset times and observation freshness. It does not change billing, evaluate policy or run agent tasks.

```sh
npm run demo:accounts -- --experimental-claude --port 8795
npm run demo:accounts -- --config /absolute/path/runner.json
```

Without a config, Codex collection is enabled and Claude requires the explicit experimental flag. With a config, provider instances and their local `account_usage` opt-in control collection; the file is not changed. Different provider homes can represent existing separate accounts. No account is created or switched. Use an organization-approved scope id consistently across machines to deduplicate Codex identities; that scope is operator-asserted. Account keys are pseudonymous, not anonymous.

State lives in memory only. Stopping the process discards observations; the next start obtains a fresh read from the connected runner. Nothing is written to disk and no secrets, emails or raw provider responses reach the page. Stop cleanly with Ctrl-C.

This is a local reference for connecting, reading and rendering the canonical `HcpAccountUsageReducer` projection. Production hosts provide authentication, employee mapping, tenant isolation, persistence, retention, scheduling and any capacity or spending policy. Unknown or unavailable provider data is displayed explicitly and never replaced by a guessed value.
