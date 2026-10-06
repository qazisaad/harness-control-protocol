# Native asynchronous output

An execution profile can advertise `native_async_output: "session"`. The durable session stream then accepts `native.output.updated` containing a public `HarnessNativeOutputObservation`. It preserves assistant output that has a verified native conversation owner but no proven app-turn correlation.

The observation carries a native source, item identity and owned content reference. Its scope is `session` and its correlation is explicitly `unattributed`; the event cannot carry `turn_id`. Consumers retrieve the content through the ordinary scoped content API. They can display it in the conversation without declaring that it completed, resumed or belonged to a particular root turn.

The pinned Claude interactive integration retains nonempty assistant blocks, including between root turns. Repeated identical wrapper identities are deduplicated; conflicting reuse and bounded registry overflow refuse further admission. Foreign native sessions fail ownership checks. Only the assistant blocks enter the content store, rather than arbitrary SDK metadata.

Claude stamps the app prompt UUID on the first reply frame of a typed native turn. Its reply lane continues across API responses and tool rounds until the native result. HCP requires that stamp before establishing a lane; admitting a prompt alone does not establish one. It records native API message identities as well, so a known older message cannot adopt a newer root on replay. The lane closes at the terminal result. Assistant output between native turns remains session scoped, and a late frame stamped with an old prompt does not become output for a newer root. This is correlation under the pinned SDK's native turn contract, not a promise that every autonomous response has a root identity.

The protocol corpus, native stream fixtures and packed public consumer exercise schema validation, scope, deduplication, content retrieval and root isolation. The opt-in native check is `HCP_NATIVE_LIVE=1 HCP_LIVE_PROVIDER=claude HCP_LIVE_ASYNC_OUTPUT=1 node scripts/check-native-work-live.mjs`. Other drivers do not advertise this observation path merely because the protocol supports it.
