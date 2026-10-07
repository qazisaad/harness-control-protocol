# @harness-control/sdk

App-side APIs for an HCP runner. Requires Node.js 22+ for the examples; the SDK itself has no Node transport or provider dependency.

```sh
npm install @harness-control/sdk @harness-control/protocol
```

The local machine runs `@harness-control/runner`. The application accepts its outbound WebSocket and owns authentication, pairing approval, authorization, and durable storage. HCP is a protocol, not a shared hosted service.

```ts
import { HcpHostConnection, createCommand } from "@harness-control/sdk";

// socket is already authenticated and bound to your authorized machine.
const host = new HcpHostConnection({ send: message => socket.send(JSON.stringify(message)) });
socket.on("message", raw => {
  const received = host.receive(raw.toString());
  if (received.message.type === "host.hello") {
    // Check runner_id and host_id against the authenticated identity first.
    host.accept({ protocol_version: "hcp.v0", heartbeat_interval_seconds: 30 });
  }
  // Persist messages and inspect event/snapshot reduction results here.
  // Consume terminal events; an ACK does not mean the turn has finished.
});
socket.on("close", () => host.disconnect());
socket.on("error", () => host.disconnect());

// After acceptance and capability discovery:
const command = createCommand({
  type: "harness.turn.send",
  payload: { session_id: "session-1", turn_id: "turn-1", input: "Explain this repository" },
}, { id: "your-stable-command-id" });
// Persist command before sending when recovery across app restarts is required.
const acknowledgement = await host.send(command);
```

`startSession`, `sendTurn`, `cancelTurn`, `stopSession`, `requestSnapshot`, `respondToApproval`, `respondToInput`, `detachTools`, `runLocalAction`, and `manageWorkspaces` provide typed convenience calls. Each accepts a protocol payload, optional command identity/timestamp/metadata, and optional wait timeout/AbortSignal. MCP attachments are supplied in `startSession`. Model discovery comes from `host.capabilities.updated`; workspace operations are `list`, `add`, `rename`, and `remove`.

Session commands resolve to an ACK. Snapshot, workspace, and local-action commands resolve to their matching result. Local/workspace errors are typed result messages; NACKs throw `HcpCommandRejectedError`. Disconnect, timeout, or aborting a wait throws `HcpOutcomeUnknownError` and never retries or cancels remote work. Send an explicit cancel command when appropriate.

## Conversation controls

Capabilities advertise `native_history`, `history_pagination`, `conversation_fork`, `conversation_rollback`, `active_steering`, `manual_compaction` and `content_retrieval` independently. Omitted fields mean unknown support. A live execution session and a retained native conversation have distinct lifetimes.

Use `configuration_inheritance` in a start payload to require which native sources may be inherited: `user_settings`, `project_settings`, `hooks`, `mcp_servers`, and `plugins`. Each requested boolean must match the adapter's declared enforcement; unknown or different enforcement rejects the start before provider launch. `session.configured` reports the adapter's declaration. An inherited MCP inventory is distinct from runner-authorized attachments. Only request properties your app needs; omission makes no isolation claim.

Optional `approval_options` refines the selected native approval authority. `prompt_categories` requires all five Boolean prompt classes, profile `approval_prompt_filter` and `auto_edits`; false rejects that flow. `permission_prompting: "reject_unapproved"` requires profile `native_permission_prompting`, `ask` and user review. Claude interactive implements this as native `dontAsk` with startup readback; unapproved callbacks deny without application review. It refuses plan mode with this fixed policy. These options bind continuations and are separate from builtin availability, MCP authority and OS sandboxing. Unsupported provider/profile combinations refuse before native admission.

`approval_options.permission_rules` supplies a bounded ordered list of `{permission, pattern, action}` with an explicit first `*`/`*` baseline. Check profile `native_permission_rules` for its vocabulary, matching and scope. Controlled OpenCode interactive declares `root` scope and requires all native task launches denied. Controlled background declares `root_and_children`: its first rule must deny everything before effective overrides. An owned native prompt hook waits for verified launch custody, installs and reads back the complete child policy before model dispatch, and preserves native child restrictions. This profile permits one child generation; grandchildren remain denied. Unknown policy mutations fence the owner without retry. Both profiles require exact complete native readback. Patterns use slash normalization, `*` for any characters, `?` for one character and a trailing ` .*` to match optional command arguments; Windows matching ignores case. The last matching rule wins. Rules bind continuations, persist with retained history and cannot change through the current idle transition contract. Ordered callbacks support one-shot decisions only. Selected MCP review remains separate; these rules do not provide an OS sandbox.

Optional `sandbox_options` declares native network access and additional writable roots. Every root is `{workspace_id, path}` in a host-authorized workspace; the runner verifies canonical containment before launch. Check the selected profile's `sandbox_options` capability and native readback. Current Codex interactive workspace-write supports these options; other current profiles refuse them. Additional write roots cannot expand read-only authority. Options bind continuation ownership and cannot change through ordinary resume or the current idle transition contract.

Optional start `instructions` accepts bounded `system` and `developer` strings, gated by `instruction_roles`. System instructions replace the native base prompt; developer instructions use the provider's native developer role. Omission preserves native defaults. A provider never flattens an unsupported role into user input. Instructions form part of the continuation binding, so resume must use the same values. Supply app-specific instructions here instead of adding product prompts to HCP adapters.

`session_events` advertises an adapter's between-turn observation channel. These observations share the normal durable event sequence and replay; root-turn completion does not end their subscription. It does not by itself advertise child-agent ownership, pending work or control operations. Adapters receive a session-bound `emitSessionEvent` and content publisher at startup. That channel allows diagnostics and optional display extensions, and rejects root-turn completion or interaction requests. Local runner consumers can observe committed events with `HarnessSessionManager.subscribeEvents`; a failing listener is detached and can reconcile through replay. The WebSocket runner subscribes automatically.

```ts
const read = await host.readConversation("session-1", {limit: 50});
const fork = await host.forkConversation("session-1", {
  target_session_id: "fork-session", continuation_group_key: "fork-conversation",
  expected_history_hash: read.payload.history!.history_hash,
});
const steered = await host.steerTurn("active-session", "active-turn", "Additional input");
await host.compactConversation("active-session", "compact-turn");
```

Read/fork/rollback require an idle retained conversation; steering requires the exact active turn. Reads return an opaque revision-bound `next_cursor` when more history is available. Fork and rollback reject stale history. `retireConversation` removes the runner association without deleting native files. Rollback never restores files; consuming apps coordinate their own checkpoints. A native replacement can change its diagnostic native reference.

Conversation calls resolve to their matching `harness.conversation.result`, including steering turn IDs, fork destinations and content IDs/offsets. Compaction is a turn action: its ACK confirms acceptance; a terminal event confirms the outcome. Use durable command IDs and reconcile unknown mutations before retrying.

Large output/history fields can include `content_ref`. Call `readContent(sessionId, reference.content_id, byteOffset, byteLimit)` with at most 64 KiB per chunk. Decode `data_base64` to bytes and concatenate before UTF-8 decoding; `next_offset` identifies the next chunk. References remain session/provider/workspace scoped and can expire or be evicted. See the [independent consumer](../../examples/conversation-controls-consumer.mjs).

Use a new `HcpHostConnection` for each physical socket. Pass only your durably committed resume cursor to `accept`. `events` uses the canonical protocol reducer; gap/conflict results and `host.replay.unavailable` require application recovery. Retaining an event in memory does not acknowledge durable consumption. The app owns event retention and can supply a restored reducer to the constructor.

For transactional or non-WebSocket code, import `createCommand` and `parseCommand` without constructing a connection. This is the API used by P2A's Convex integration.

See [the public package contract](https://github.com/qazisaad/harness-control-protocol/blob/main/docs/public-packages.md), [pairing](https://github.com/qazisaad/harness-control-protocol/blob/main/docs/pairing.md), and [the standalone example](https://github.com/qazisaad/harness-control-protocol/blob/main/examples/public-sdk.mjs). Provider support is capability-dependent; unsupported policies are never widened automatically.

## Account usage

After authenticating the socket and accepting a hello with the `account_usage` capability:

```ts
const snapshot = await connection.readAccounts({ provider_instance_ids: ["work-codex"] });
const accounts = connection.accounts.accounts(new Date(), 300_000);
const sourcesToPersist = connection.accounts.snapshot();
```

Omit provider ids to read all configured instances. The default wait is 150 seconds for up to 32 providers collected four at a time; override it for smaller deployments. No harness session or prompt is involved. Only the correlated `host.accounts.snapshot` completes a read; an ACK does not. A response with a different host or requested provider set is rejected.

`HcpAccountUsageReducer` can be restored from validated source snapshots and supplied as the connection's `accounts` option after reconnect. Persist it in the consuming app. Omitted providers are untouched; successful observations replace their source's whole limit list. Failures retain last-good history but suppress fresh decisions. Accounts observed on several sources are deduplicated by key, never summed. Remove retired sources explicitly with `removeSource(hostId, providerInstanceId)`.

Employee mapping, billing scope verification, retention, polling, policy and authorization belong to the host. Keep one canonical policy in the host's server code rather than copying rules into a UI. See the [account contract](../../docs/account-capacity.md).

## Native background work

For providers advertising `native_work`, call `readNativeWork(sessionId, {limit, cursor})` to reconcile session-owned tasks after root completion or a replay gap. Each entry includes a revision and live `owner_status`. Use `cancelNativeWork(sessionId, workId, revision, {id: durableCommandId})` and `retireNativeWork(sessionId, workId, revision)`. Cancellation acceptance is distinct from a terminal task observation; uncertain cancellation is fenced against repetition. Retirement requires terminal status and removes only HCP metadata. Retained work whose owner is unavailable remains readable after restart. See the [native work contract](../../docs/architecture.md#native-work-ownership).

`readNativeWorkInventory(sessionId, options)` assembles a stable roster across bounded pages, preserving each original turn, revision, owner availability and `closure_unconfirmed`. Changed observation hashes/counts/ownership, duplicates, cursor cycles and missing rows refuse rather than returning a mixed snapshot. Caller limits default to 128 items/pages and 32 rows per page. An empty roster does not prove native execution closure.

`readNativeWorkHistoryPageComplete(sessionId, workId, revision, page, options)` hydrates one custody-checked child history page with the verified content reader. Select `options.owner: "retained"` after the physical owner exits. The result retains `{work, history}`: work proof includes its native source, revision and active/retained owner, and history retains wire fidelity, hash, truncation and cursor alongside resolved values. The API does not infer a child launch prompt from its summary or treat a page as a complete conversation.

Register `waitForSessionEvent(sessionId, predicate, options)` before dispatch when a command ACK is insufficient. The predicate must correlate the required native event, original turn, execution or goal generation. The default boundary waits only for subsequent events; explicit `afterSequence` permits retained replay. Only applied validated events or an applied snapshot can satisfy the wait. Conflicts, gaps and unavailable replay fail affected-session waits with `HcpSessionEventWaitError` (`reconciliation_required`); disconnect, timeout and abort also fail without sending a native cancellation or retry. Predicate errors fail that observer. Callbacks and returned events receive independent copies of retained evidence. A failed observation wait does not prove native execution stopped.

`projectHcpNativePhases(events, sessionId, origin?)` projects actual native phase evidence from a validated event slice. It preserves root/execution/admission identities, original turn, goal admission and observed admission/completion times. Terminal-only retained evidence remains usable without an invented admission time; absent terminal status does not establish a running physical owner. Conflicting bindings/outcomes and two admission identities for one native execution refuse. Use the SDK event reducer for stream continuity and replay conflicts before projecting a slice. The result is not an exhaustive execution or whole-session closure inventory. Product run, turn and node IDs remain consumer allocations.

## Context observations

Read `context.updated` events or a terminal output's optional `context` when `context_usage` is advertised. Keep this separate from `usage.updated` billing totals. Inspect `status`, `measurement_scope`, `source`, `observed_at` and `selection` before displaying counts. An unavailable observation clears previous context counts; omitted capacity stays unknown. Latest-request counters and retained-conversation counts are distinct native observations. Apps decide how old a measurement may be before it is considered stale.

## Portable history

When `portable_history` is advertised, read `history.turns[].portable_items` instead of parsing native `items`. Use the exported portable item schemas. Messages have explicit roles; tool results name their call ID. Value storage distinguishes inline JSON, retained references and unavailable content. Use `readConversationPageComplete(sessionId, page, options)` to retrieve referenced native/portable item lists and nested message/tool values. Its `source` preserves the original fidelity, truncation and cursor; `turns[].portable_items[]` pairs the original item with resolved `values`. Resolved values retain their content reference. Unavailable values remain unavailable. This reads one page; it does not claim complete conversation coverage.

Use `readContentComplete(sessionId, reference, options)` for other content references. It assembles bounded chunks, verifies exact reference/offset/byte length and SHA-256, then strictly decodes UTF-8 or JSON. Cancellation, expiry, changed data and failed verification never fall back to previews. Defaults allow 8 MiB per object and 512 chunks; history resolution additionally limits unique referenced bytes to 8 MiB and references to 1,024. Set lower bounds for the application's needs. `maxTotalBytes` counts unique referenced bytes, not inline wire data. SHA-256 requires Web Crypto. Standalone helpers `readHcpContent` and `resolveHcpHistoryPage` support custom transports; pass an integrity-verified reader to the latter. Read `portable_fidelity` before treating a view as complete. Namespaced display extensions can be ignored by generic clients. See the [history contract](../../docs/architecture.md#portable-conversation-history).


Check profile `native_plan_proposals` before depending on proposed-plan events. Current Codex interactive sends native item/execution IDs in `turn.proposed.delta` and `turn.proposed.completed`. `projectHcpProposedPlans` groups a bounded validated event slice by those IDs and preserves original origin. Streamed previews may differ from authoritative completed content, including an empty final plan. A native plan-only completion does not manufacture an assistant chat message. Resolve deferred completed bodies with `readContentComplete` and require a decoded string; previews never replace missing content. Proposal completion ends native item streaming, and does not establish whole-session closure or decide how your application consumes a plan.

Check profile `native_reasoning_segments` before depending on indexed reasoning. Codex interactive's `reasoningSummary` model option accepts `auto` (HCP default), `concise`, `detailed` or `none`, with native effective-settings confirmation. Removing an earlier override explicitly restores `auto`; native omission would retain it. A selected summary setting does not guarantee a model emits reasoning on every request.

`projectHcpReasoningItems` preserves actual item/execution IDs, summary/content indexes and Claude message/block pointers without inventing missing identities. Streaming segment text remains separate from authoritative completed native summary/content arrays. Resolve deferred completed content through `readContentComplete` and validate the resulting body. Native item or block completion does not close its phase, root or session; bounded partial event slices do not prove a complete inventory.

`readReasoningItemsComplete(sessionId, events, origin, options)` retrieves deferred native completed bodies through scoped, integrity-checked chunk reads. Each result preserves the original observation in `source` and exposes authoritative decoded text or summary/content arrays separately in `completed_content`. Missing or corrupt content refuses; an absent body remains distinct from an authoritative empty body. Output-byte and reference bounds cover duplicate decoded bodies as well as unique I/O.

Native execution plans and todo lists are observations, not application workflows. `projectHcpNativePlanObservations(events, sessionId, originTurnId)` preserves snapshot versus tool-input intent, actual native references, array positions and native statuses. `peer.readNativePlanObservationsComplete(sessionId, events, originTurnId, options)` verifies scoped retained step arrays and optional explanation bodies, returning `{source, steps, explanation?}`. An absent explanation stays absent; an explicitly empty native explanation stays empty. Source references remain available separately from decoded bodies. The shared byte/reference budget covers steps and explanations, including repeated decoded output. Missing, malformed or corrupt retained bodies fail instead of substituting previews. Applications allocate their own artifact/step IDs and decide how unsupported native statuses appear. Root-turn completion does not complete pending checklist steps, and a todo tool input does not prove that native state was applied.

For native proposed-plan items, `peer.readProposedPlansComplete(sessionId, events, originTurnId, options)` returns `{source, completed_plan?}` with an integrity-checked complete text body. `source` retains previews, exact native item/execution identities and original references. Preview-only items have no completed body; explicit empty completions remain empty. Item completion does not accept a proposal or close the execution. Missing references, corrupt content and non-text bodies fail. Byte/reference bounds, cancellation and cached-reference consistency apply as in the other complete readers.

Native approval requests can declare `rejection_feedback_supported: true`. Only then may a `harness.approval.respond` rejection (`decline` or `cancel`) include `feedback`, an exact nonempty string of at most 8192 characters. The response remains bound to the original session, turn, request and action hash; changed feedback is a conflicting replay. Supporting Claude callbacks return it as the native denial message; `cancel` also requests native interruption. Unadvertised native callbacks and application MCP reviews reject feedback without consuming the pending decision. The Claude interactive profile declares `native_approval_feedback: "rejection"`; this describes a supported callback translation, not an authenticated tool-execution proof.

`turn.proposed.observed` records complete native proposal tool input, separately from completed native plan items. `projectHcpNativeProposalInputs` preserves observation order, actual native session/call/request references and any supplied root origin. `peer.readNativeProposalInputsComplete` returns `{source, plan}` after verified scoped retrieval; previews, missing references and non-text bodies cannot substitute for the body. Input intent does not accept the plan, complete the tool call or close execution. Native Claude `ExitPlanMode` observations require an actual supplied string body; absent plan fields do not trigger filesystem reads. Child input and old-root replays cannot become current root proposals. `native_plan_proposal_observations: ["tool_input"]` declares this conditional projection, not guaranteed authenticated native emission.

A persistent profile can declare `native_owner_closure: "owned_session"`. Its successful live unload emits `session.exited` with `native_owner_closed: true` only after the native owner stops, owned work/admissions have no unresolved closure and MCP cleanup finishes. This proves closure of that physical ownership generation; retained native history remains reusable only through an explicit continuation/fork. Command ACKs, owner loss, empty work inventories and exits without this marker do not establish physical closure. A saved review's logical retirement never supplies this marker.

`HcpNativeSessions` provides reusable ownership bookkeeping on a public `HcpHostConnection`. `open(payload, options)` requires an explicit profile and no combined first turn, registers readiness before dispatch and distinguishes `reserved` lazy configuration from an `active` native conversation. The default requires native conversation readiness; use `readiness: "configured"` for a declared lazy consumer. `close(sessionId, options)` requires both command acceptance and matching positive physical-closure evidence; an unknown unload cannot be replayed under a new command ID. Registry state is copied, bounded to 4,096 generations and never restores an uncertain owner from later readiness. Owner loss, disconnect, continuity gaps and cancelled waits fence affected ownership without sending cancellation or native stop. `dispose()` detaches observation and fences outstanding generations; it never terminates a provider. Apps own authenticated transport and durable reconciliation. Observed active readiness is not a physical liveness guarantee or exhaustive execution closure.

`subscribeSessionObservations(callback)` supplies copied committed events and lost-continuity notifications independently of command waits. Exact replay duplicates do not produce another event callback; snapshots can supply retained events, so consumers retain per-session positions. Callback failures detach that observer, with a maximum of 128 observers. Disconnect detaches all observers after their final uncertainty notification.

The [independent ownership consumer](../../examples/native-session-ownership-consumer.mjs) demonstrates these lifecycle distinctions through the public package and validated wire events.

Native question forms preserve native headings, exact option labels and descriptions as JSON Schema `title` and `anyOf` annotations. `uniqueItems` and native answer bounds describe the same selection constraints as reply validation; custom answers remain available only where the native question permits them. Free-answer length counts Unicode code points consistently with JSON Schema, including supplementary-plane characters. Applications own UI presentation and product answer adaptation.


### Portable live items

Native `item.started`, `item.updated` and `item.completed` events may include `data.portable`. Its typed display rows cover tools, commands, file changes, messages and reasoning using the same value representation as portable history. Codex MCP/dynamic tool arguments and results, Claude tool calls/results and admitted OpenCode tool snapshots are translated in the runner. Tool namespaces are included only when supplied natively. Missing arguments remain unavailable, and unknown kinds remain extensions with partial fidelity.

Use `connection.readPortableItemComplete(sessionId, event.data.portable)` to resolve retained rows and nested values. It preserves the source observation and fidelity, applies aggregate byte/reference limits, and verifies scoped content chunks before returning complete bodies. Previews are never complete values. `native_item_reference`, `native_call_reference` and `native_execution_reference` identify actual native objects; portable row IDs (including derived result IDs) identify display rows. An item's completion does not complete its root job or independent work. `full` describes the projected fields' availability, not a lossless copy of every native metadata field.

Portable history rows may also carry explicit `native_item_reference` and `native_call_reference`. Use these fields for native identity; `id` remains a display/correlation key. OpenCode tool rows share the actual call key with live observations while preserving the separate native part reference. Missing native references do not authorize upgrading a fallback display ID to native identity.


### Complete native text

`projectHcpTextItems(events, sessionId, origin)` groups text only by actual native item or message/block coordinates. It keeps `streamed_text` separate from `completed_content`, preserves actual message and execution references when supplied, and rejects conflicting frames, changed complete bodies and text after native closure. A block closure without content may be followed by its complete native assistant body; it cannot reopen streaming. Unattributed deltas do not become fabricated physical items.

Use `connection.readTextItemsComplete(sessionId, events, origin)` for large retained bodies. It verifies scoped chunks, preserves the source evidence, enforces byte/reference limits and cancellation, and refuses missing bodies or previews. Native text/block completion does not complete a root job. Claude complete assistant text/thinking blocks and OpenCode native end snapshots provide authoritative bodies; OpenCode completion can replace a streamed preview when its native final snapshot changes.


### Complete root result text

`connection.readFinalTextComplete(sessionId, output)` reads a root's final output without inventing a physical message or item. Native adapters explicitly set `final_text_truncated`: `false` identifies complete inline text; `true` marks a display preview. Large retained bodies also carry `final_text_ref`, an authoritative final-text reference distinct from the general `content_ref`. The reader verifies scoped chunks and preserves the source preview and metadata.

The result reports `complete`, `unavailable` or `unconfirmed`. Unpublished previews remain unavailable, and legacy text without explicit fidelity remains unconfirmed. A general content reference does not establish final-text identity. Empty complete text is valid; literal preview-related words do not change fidelity. This supports native local-command results that have no reported physical text block. It makes no claim that a model ran or that independent work closed.


Owned file uploads can use `peer.uploadInputFile(sessionId, {filename, mime_type, bytes}, options)`. The SDK copies bounded bytes before hashing, verifies the create identity, exact chunk progress and immutable seal receipt, and returns the owned reference for a declared `files` delivery. Uploading does not send a model prompt or prove that a provider supports native document decoding. A failed upload is not retried or implicitly released; `HcpInputFileUploadError.reference`, when present, is the last confirmed reference for explicit read/reconciliation. Never turn an uncertain mutation into an automatic upload retry.


For a model and driver that declare `owned_image_inputs`, use `peer.uploadImageFile(sessionId, {filename, mime_type, bytes})` and pass its typed reference in `sendTurn({..., image_files: [uploaded.reference]})`. Owned image delivery preserves native image bytes separately from file-only context: at most 10 MiB per image, 80 MiB across native images and 100 images including inline inputs. The turn carries scoped references, keeping large base64 bodies out of HCP command frames. The runner verifies owner binding, complete SHA-256 and exact metadata, retains bytes before native dispatch, and uses the provider's native image input. Model acceptance remains conditional on actual provider/model support; uploading a PNG-labelled body alone does not prove native decoding. Original inline `images` retain their smaller transport bound.

Owned ordinary files are bounded to 50 MiB each and 100 file-context references per turn when declared by the provider. The runner reserves complete declared uploads against a 5,000 MiB store quota and 1,024 metadata entries. Release unused uploads explicitly; delivered bytes remain retained until their conversation custody is retired. Quota pressure never silently evicts delivered input files. File context supplies readable workspace files and does not certify native document decoding.

Complete portable history and item readers expose `media` for known `attachment` rows. A media source is typed as `embedded` (canonical base64 and MIME), `url`, `path`, or `native_reference`; the original row, native references, retained body and fidelity remain available. Reading these sources does not fetch a URL, read a native path, acquire input-file custody or create provider-issued identities. Unknown source shapes remain provider extensions. Content objects are bounded to 128 MiB, complete portable hydration defaults to a 256 MiB aggregate, and callers may select smaller limits. The content store has a finite 512 MiB quota with explicit expiry/eviction behavior.
