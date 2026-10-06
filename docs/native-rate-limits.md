# Native quota observations

An execution profile can advertise `account_limit_observations: "native_session"`. Its native quota notifications enter the durable session event stream as `account.rate_limits.updated`, with the original `provider_instance_id` and a typed `observation`. Apps can parse it with the public `harnessRateLimitObservationSchema`.

An observation reports only the native windows present in that frame: window identity, status, optional utilization and reset time. Omitted values remain unknown. Utilization is a fraction and can exceed one. Overages retain their separate native status, use flag, reset time and disabled reason. A rejected base window can coexist with allowed overage; apps must preserve both rather than declare the entire account blocked.

The source is native and scope is `native_session`. The event does not assert an authenticated account identity, include a complete quota inventory or authorize aggregating different sessions into one account. It has no invented originating turn. Full account reads retain their separate `host.accounts.read` / `host.accounts.snapshot` contract and verified account identity rules. Credentials and arbitrary native fields are not projected.

Claude's pinned interactive SDK integration projects `rate_limit_event` after native session initialization, including between app turns. Contradictory or malformed information produces a bounded warning and leaves the runtime usable. Frames from another native session fail the existing ownership check. API-key sessions may emit no subscription quota information; advertising the observation path does not promise an available quota reading.

The current evidence is installed SDK types, native stream fixtures, ownership tests and public packed consumers. The acceptance suite does not deliberately exhaust a real subscription, and no live quota notification is claimed. Codex has its separate authenticated account read; OpenCode does not advertise an unsupported account-limit observation path.
