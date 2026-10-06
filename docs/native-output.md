# Native asynchronous output

An execution profile can advertise `native_async_output: "session"`. The durable session stream then accepts `native.output.updated` containing a public `HarnessNativeOutputObservation`. It preserves assistant output that has a verified native conversation owner but no proven app-turn correlation.

The observation carries a native source, item identity and owned content reference. Its scope is `session` and its correlation is explicitly `unattributed`; the event cannot carry `turn_id`. Consumers retrieve the content through the ordinary scoped content API. They can display it in the conversation without declaring that it completed, resumed or belonged to a particular root turn.

The pinned Claude interactive integration retains nonempty assistant blocks, including between root turns. Repeated identical wrapper identities are deduplicated; conflicting reuse and bounded registry overflow refuse further admission. Foreign native sessions fail ownership checks. Only the assistant blocks enter the content store, rather than arbitrary SDK metadata.

Claude stamps the app prompt UUID on the first reply frame. HCP records its native API message identity so subsequent blocks of that same message retain the proven root. Another unstamped native message cannot inherit that root. A late frame stamped with an old prompt does not become output for a newer root. This is message correlation, not a promise that every native autonomous response has a root identity.

The protocol corpus, native stream fixtures and packed public consumer exercise schema validation, scope, deduplication, content retrieval and root isolation. The opt-in native check is `HCP_NATIVE_LIVE=1 HCP_LIVE_PROVIDER=claude HCP_LIVE_ASYNC_OUTPUT=1 node scripts/check-native-work-live.mjs`. Other drivers do not advertise this observation path merely because the protocol supports it.
