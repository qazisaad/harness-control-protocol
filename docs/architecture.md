# Architecture

## Repositories

The runner is intentionally structured as a standalone public project.

- `packages/hcp-protocol`: public protocol types and schemas
- `packages/hcp-runner`: local runner CLI and daemon
- `apps/mock-control-plane`: local test control plane for third-party validation
- `apps/sample-mcp-server`: local reference MCP server for proof-of-possession tests
- `examples`: standalone non-P2A flows for local validation

## Boundary

The runner connects outbound to a control plane. The browser and hosted app do not require inbound network access to the user's machine.

Provider executable paths, home directories, launch arguments, and persistent environment variables remain runner-local by default.

This public runner repository intentionally does not implement Agentic Playground product integration. It has no Convex, WorkOS, frontend, workflow queue, or P2A observability dependencies. P2A can consume HCP schemas and events later, but this repo stays usable with any compatible control plane.

## MCP SDK Boundary

The runner should use the official Model Context Protocol TypeScript SDK for MCP protocol mechanics.

SDK responsibilities:

- Streamable HTTP client transport
- MCP client connection lifecycle
- tool discovery
- tool calls
- standard MCP protocol errors
- auth-provider hooks for request credentials
- MCP server primitives for mock servers and examples

Runner responsibilities:

- decide which MCP transports are allowed by HCP policy
- map HCP `McpServerAttachment` records into SDK clients
- resolve runner-owned stdio profile ids into locally configured processes without exposing command configuration
- enforce `allowed_tools` and `denied_tools`
- attach MCP servers only to explicitly configured harness sessions
- redact inputs, outputs, and headers before logging
- emit HCP MCP events
- close clients and remove temporary config at session end
- rely on the control plane for lease minting and revocation decisions

The SDK should sit behind a small runner-owned wrapper so SDK version changes do not leak into harness adapters.

The sample MCP server exposes both proof-bound Streamable HTTP and local stdio entry points using official SDK transports. It is a reference path for local tests, not a production authorization service.

## Reliability Boundary

The runner owns local acceptance, idempotency receipts, per-session event sequencing, retained replay windows, and session event snapshots. The control plane owns the sequence it has durably applied and sends that cursor in `host.accepted`.

The runner does not own product thread/message history or workflow queues. A hosted application persists HCP events through its canonical production reducer and stores its cursor in the same transaction as the resulting projection. See [Reliability And Snapshots](reliability-and-snapshots.md).

## Consumer identity and custom harnesses

Local leases, actions and their events use HCP session, lease, host, provider and workspace identities. Organization, workflow, run and node IDs belong to the consuming application's records, mapped by session or lease ID. They are not fields in the public local capability contract. This keeps one execution identity through retry/replay without requiring a workflow engine. The 0.4.0 release removes those formerly required product fields; callers must omit them.

Custom harness developers import `HarnessAdapter`, its input/output types, `ProviderDriverStatus` and `HarnessAdapterRegistry` from `@harness-control/runner/harnesses`. Supply the registry to `HarnessSessionManager`, then the manager to `RunnerConnection`. See [`examples/custom-harness.ts`](../examples/custom-harness.ts) and [`examples/public-sdk.mjs`](../examples/public-sdk.mjs). The packed release check compiles this adapter outside the monorepo and exercises it through terminal execution, a local capability action, snapshot reduction and session exit.

The `connect` CLI discovers bundled providers. Applications embedding custom adapters configure their provider instances and registry themselves; they do not need to patch the default registry or import private package paths. User-facing product setup instructions belong to the consuming application.

### Optional conversation controls

Adapters can declare `conversationOperations` (`read`, `rollback`) and implement `conversationOperation(input)` using the exported `HarnessAdapterConversationInput` type. The existing `harness.conversation.request` wire command stays unchanged. The manager checks the retained provider identity, allowed workspace and idle conversation before calling the selected driver. It validates the returned command/session/operation binding and prevents the adapter's persistence callback from changing the authorized conversation identity or scope.

Codex implements these hooks with its existing native history and fenced rollback logic. An adapter without the requested hook receives `conversation_operation_unsupported`; the manager never falls back to Codex. `retire` remains a runner-owned deletion of the local association and does not invoke or delete native provider history. No consumer database or thread/run identity is required.

Full interactive parity also requires native ownership and interaction contracts; conversation controls do not imply those capabilities. Existing adapters need not implement optional hooks to remain usable for their supported session operations.

Committed event subscriptions preserve FIFO order, including reentrant publication. A synchronous publication flush admits at most 128 events; an observer that exceeds this limit is detached through its error handler. Later publications remain usable. Counting the whole flush, rather than only the pending queue, prevents a one-event-at-a-time observer from monopolizing the runner indefinitely.

Native approvals and questions expire after at most five minutes. A matching combined startup turn also respects its original `not_after` deadline. Follow-up turns have their own interaction lifetime and do not inherit the earlier startup deadline.

### Native work ownership

Optional `native_work` is independent of root-turn completion. An adapter declares `nativeWork: true` and emits `native.work.updated` observations for tasks, agents or commands with a session-owned ID, immutable native reference, admitted origin turn and optional owned parent. The runner adds revisions and retains the authoritative inventory independently of bounded event replay. Background work also requires `sessionEvents: true`; cancellable work requires `cancelNativeWork`. A display extension alone never establishes ownership.

The SDK exposes `readNativeWork`, `cancelNativeWork` and `retireNativeWork` through `harness.conversation.request` with `kind: "work"`. Reads paginate up to 32 entries from at most 128 current records, using a session- and revision-bound cursor. Global and per-record `owner_status` distinguish retained observations from live cancellation owners. Restart does not restore native ownership or automatically execute a pending control. Consumers reconcile the inventory after replay gaps and use each record's revision when controlling it.

Cancellation intent and its event are committed atomically before calling the adapter. The native call receives an abort signal and a 30-second deadline. Acceptance means the native owner acknowledged the request; terminal observations prove task completion. A lost response leaves a pending fence and never permits automatic repetition, including after restart. A fresh terminal observation can reconcile that outcome. Root cancellation does not implicitly cancel children. Session shutdown retains its execution lease until all owned work has terminal closure proof.

Retirement removes only terminal work metadata and retains a tombstone, so late observations cannot reopen the execution. It never removes native files or checkpoints. Inventory scope includes the original provider/account configuration, workspace and execution binding. Capacity is bounded to 1024 session inventories and 1024 tombstones per inventory; reaching a limit fails instead of dropping ownership evidence. The independent consumer fixture exercises the public contract. Bundled native providers advertise it only once their runtime owns observation, cancellation and shutdown across root turns.

### Context measurements

`context_usage` advertises portable `context.updated` observations and optional final-output `context`. They are separate from token/cost billing totals. A context observation includes source, measurement timestamp, requested model/options selection, measurement scope (`last_request` or `retained_conversation`) and `measured`, `estimated` or `unavailable` status. Available observations require `used_tokens`; capacity is optional and never inferred from accumulated usage. Unavailable observations cannot carry current counts. Consumers own freshness thresholds and display policy; a measurement is not proof of provider access or account quota.

Codex projects native `tokenUsage.last.totalTokens` and reported `modelContextWindow`; its `tokenUsage.total` remains conversation billing usage. Foreign native-turn observations are ignored. Claude projects only the latest root assistant request's input, output and cache components. Child-agent requests do not replace root context. Claude compaction's optional `post_tokens` is explicitly a retained-conversation measurement. HCP does not supply model-window guesses when the native source omits capacity. Missing or invalid measurements stay unavailable. New requests and compaction publish an invalidation before fresh measurements, so old values cannot silently describe a changed request.

### Portable conversation history

`portable_history` advertises typed `portable_items` on retained-history turns. Core item types cover messages with explicit roles, reasoning, tool calls/results, commands, file changes, plans and context markers. Tool results carry their call ID. Provider-only or malformed native shapes become namespaced display extensions, not invented messages or tool actions. Codex, Claude and OpenCode translate common items in the runner; consumers can use the public `harnessPortableHistoryItemSchema` and `harnessPortableHistoryItemsSchema` without native response parsers. Adapters declaring `portableHistory: true` must supply the typed view or its content reference and fidelity metadata.

Values use `inline`, `reference` or `unavailable` storage. Referenced values are retrieved using the existing scoped content command; decode according to the reference format. `portable_fidelity` describes whether the projected values were retained completely. An unavailable value or omitted content without retention reports partial fidelity. Optional extensions retain provider-specific information for diagnostics; generic clients can ignore them. File changes use canonical added/modified/deleted/renamed/unknown kinds and an explicit previous path for renames. This does not restore files or create application checkpoints.

A turn has at most 100 inline portable items. Larger inventories use `portable_items_ref`, whose JSON decodes with `harnessPortableHistoryItemsSchema` (up to 10,000 entries). A busy turn that would exceed the page budget uses scoped item-list references and a bounded preview, so history retrieval does not require an oversized wire message. `items` and optional `items_ref` retain the legacy diagnostic view. History hashes and mutation boundaries continue to describe the original native snapshot; adding the portable view never changes fork or rollback evidence.

Attachment resource ownership and richer live event fidelity are separate capabilities; a retained input extension does not authorize a local upload or claim a portable attachment implementation.
