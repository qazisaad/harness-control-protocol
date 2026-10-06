# Native retry observations

A profile advertising `native_retry_observations: "session"` can publish `native.retry.updated` with a public `HarnessNativeRetryObservation`. It reports an observed retry, rather than an app command or permission to replay a prompt. The runner requires an initialized live native conversation owner.

The observation preserves native attempt count, maximum retries, retry delay, HTTP status (including null when no response arrived), a bounded error code and optional first-response timeout measurements. `max_retries` keeps the native meaning; it is not renamed to total attempts. Missing first-response measurements remain absent. Raw native error descriptions, headers and credentials do not enter the contract.

The current scope is explicitly `session` with `correlation: "unattributed"`; the event cannot contain `turn_id`. Claude's installed SDK retry frames have no originating prompt or child identifier. A notice may concern background work even while another root is active. Consumers can display native session retry progress without treating it as a terminal root failure or moving it onto the newest user message. A later reply proves only the reply's own correlation, not which uncorrelated retry it resolved; there is no fabricated recovery event.

Claude interactive projects recognized SDK error codes after initialization, including between roots. Repeated identical item identities are deduplicated. Conflicting reuse and bounded registry overflow fence the owner; malformed evidence emits a bounded warning without making arbitrary native strings public. Another native session's frames fail ownership checks. Other profiles do not advertise this path unless implemented.

Validation uses installed SDK types, native message-stream fixtures, protocol/schema conformance and the independent packed WebSocket consumer. It does not deliberately induce provider throttling or claim a live retry was observed.
