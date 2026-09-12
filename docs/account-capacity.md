# Account usage and capacity management

## Contract

HCP collects account-level capacity independently of harness sessions. The local
runner owns provider access; the authenticated consuming app owns employee
mapping, retention, scheduling, policy, and billing authorization. P2A is not a
dependency. This feature does not create accounts, switch logins, purchase plans,
or infer invoice charges from token usage.

The first complete flow is local opt-in → accepted HCP connection →
`host.accounts.read` → provider account API → `host.accounts.snapshot` → canonical
usage reducer → threshold/renewal recommendation → standalone reference UI.

### Identity and observations

Each configured provider can opt into `account_usage`. Provider homes and secrets
remain local. Account keys hash provider, subject and billing scope. Provider
organization identity is preferred; a locally configured scope is an operator
assertion, not provider verification. If scope or subject cannot be established,
the identity is local to the host/provider and must not be merged across hosts.
No raw provider response, credential, transcript, or email is sent to the app.
Changing the observed login changes the key, even with the same provider instance.

A snapshot is a response to a read request, containing a complete observation for
each requested provider. Omitted providers are untouched; they are not deleted.
A successful observation replaces that source's previous limit list, including
an explicitly empty list. A failed read preserves its last successful observation
as historical data but prevents policy actions using that source. The reducer
rejects older observations and deduplicates accounts across sources without
summing account quota percentages. Consumers explicitly remove retired sources.
Reconnect uses a fresh read, not session replay. The app fences replaced sockets.

Quota percentages, reset timestamps, window durations, and optional plan labels
are provider observations. Missing values are unavailable, never zero. A passed
reset time expires a window; it does not prove a fresh zero reading. Retrieval
time, failure state and data expiry are retained. A threshold is a recommendation
trigger, not automatic permission to spend.

### Provider support

Codex uses `account/read` and `account/rateLimits/read` in a bounded app-server
process, without submitting a prompt. Claude uses the pinned Agent SDK's
experimental structured usage control method, without a prompt, transcript scan,
MCP servers, tools, or session persistence. It requires explicit local opt-in and
reports unavailability if unsupported. An API-key account is not represented as
having a subscription allowance.

### Optional management package

The package owns validated policy evaluation, deterministic recommendation IDs,
renewal review, and an action ledger contract. Host applications supply actual
billing quotes and renewal dates; prices and projected savings are not invented.
Quotes must refer to the same account, currency, current period, and comparable
capacity requirement. Without these inputs the result requests review.

Any administrative effect needs explicit organization authorization and a
durable claim before execution. A repeated logical action cannot repeat its
effect; interrupted/uncertain actions require reconciliation. Provider-specific
write adapters are enabled only where their API and credentials are established.
The public protocol never transports admin credentials or billing commands to
employee machines.

### Complexity and acceptance

One optional npm package, one read request/response pair, and one persisted
reference-app state file (observations and policy). Authorized administration uses a separate durable action ledger. No new deployed service,
database, worker framework, or P2A dependency. The reference app supplies a local
polling loop; production apps supply their scheduler and authenticated storage.

Acceptance covers independent account reads over a real WebSocket using the
production runner and SDK, multiple machines/accounts, identity changes,
missing fields, failure/staleness/reset handling, reconnect, malformed provider
responses, protocol JSON Schema/conformance, policy budgets/renewals, package
installation, and the reference UI. Live read-only provider checks are recorded
separately from fixtures. Administrative writes require a designated test
organization; without it they cannot be claimed live-verified.

## Integration and validation

- [Run the reference dashboard](../demo/accounts/README.md).
- [Use the optional policy/action package](../packages/hcp-management/README.md).
- [Read accounts through the runner](../packages/hcp-runner/README.md#account-usage).
- [Use the app-side SDK](../packages/hcp-sdk/README.md#account-usage).

Release candidate 0.4.0 keeps existing session behavior and introduces capability-gated account reads. Billing commands and admin credentials remain outside the employee-machine protocol. Multi-account observations are supported; automatic account issuance and general subscription plan changes are not implemented. A consuming organization must reserve its shared budget transactionally before administrative authorization and schedule changes from actual provider billing dates.

Live verification on 2026-09-12: the local Codex app-server returned real account plan and per-bucket quota windows without a prompt. The local Claude Team account returned `rate_limits_available: false`, correctly surfaced as `not_applicable`. No Enterprise admin key/test organization was supplied, so GET/POST/DELETE administration was validated against wire fixtures, not live billing. No purchases, plan changes, or account issuance occurred.

## Sources

- [Codex account API](https://learn.chatgpt.com/docs/app-server)
- [Claude SDK](https://github.com/anthropics/claude-agent-sdk-typescript), pinned in runner package.json.
- [Claude Enterprise administration](https://support.claude.com/en/articles/15330651-claude-enterprise-admin-api-reference-guide)
- [Claude seat billing](https://support.claude.com/en/articles/12004354-purchase-and-manage-seats-on-team-plans)

## Validation record

Validated locally on 2026-09-12:

- `npm run release:check`: build, all 188 workspace tests, four 0.4.0 package archives, clean consumer installation, public exports, installed CLI, and public SDK WebSocket acceptance passed. The acceptance flow includes account read → canonical SDK projection → management decision and the existing session's terminal events.
- Generated JSON Schema and all 36 conformance fixtures agree. Five account fixtures cover reads, available/unavailable snapshots, secret-field rejection, and invalid quota rejection.
- `npm audit --omit=dev --audit-level=high`: zero vulnerabilities.
- `npx tsx examples/basic-runner-flow.ts`: passed.
- Built `hcp-runner accounts --config ...`: live Codex returned three windows; Claude returned explicit `not_applicable`, without prompts or a control-plane connection.
- Real dashboard/browser: current Codex account rendered, threshold changes persisted and changed the decision, restart restored the 95% policy, Claude unavailability rendered, and current page logged no browser errors. At a 390px viewport, document and scroll widths both remained 390px. Temporary viewport override was reset.
- Production WebSocket/HTTP dashboard tests cover duplicate account sources, correlated refreshes, authorization/origin rejection, malformed settings, failure preservation and restart. Provider data in this automated scenario is injected test data; the preceding native reads are the separate live evidence.

The design normalizes provider data at the runner boundary, gives one reducer ownership of account projections, keeps decisions in the optional management package, and represents unavailable data and uncertain administrative effects explicitly. The reference app reuses these contracts and adds no backend service dependency.

The 0.4.0 runner configuration now requires unique provider ids and at most 32 instances per runner, bounding account collection and wire snapshots. Larger fleets use multiple authenticated runners. Registry publication and P2A integration were not performed. Enterprise live administration and organization-wide deployment require the consuming application's authenticated employee mapping, transactional budget reservations, provider credentials and actual billing contracts.
