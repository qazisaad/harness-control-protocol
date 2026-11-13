# Public packages and integration contract

**Who this is for:** app developers using the HCP packages.
**What you get:** what each package does, what your app owns, and the rules for commands, events and advanced session features.
**Level:** 1 for the first four sections, 2 and 3 after that.

## The three packages

All three are released together, at the same exact version.

| Package | Contains | Depends on |
| --- | --- | --- |
| `@harness-control/protocol` | Wire types, validation, JSON Schemas (messages and pairing), pairing contracts and the canonical session event reducer | Zod only. No provider SDK, no Node transport |
| `@harness-control/sdk` | Typed command builders and one authenticated runner connection (`HcpHostConnection`) | The protocol package only |
| `@harness-control/runner` | The CLI, embeddable runner modules, provider adapters, filesystem policy, durable command receipts, MCP attachments and `check-control-plane` | Protocol, provider SDKs, `ws` |

Every app uses these same public exports. For example, P2A uses the SDK's stateless `createCommand`/`parseCommand` inside Convex transactions. Its Python WebSocket service validates messages against the JSON Schema shipped in the installed protocol package. No Node service is needed for that.

## Who owns what

| Your app owns | The SDK does | The runner owns |
| --- | --- | --- |
| Pairing approval, sign-in, which user owns which machine, authorisation | Validates every incoming message | Local policy: which agents, folders and tools are allowed |
| Hosting the WebSocket | Builds typed commands and matches replies to them | Running the coding agents |
| Storing commands, events and the replay cursor | Keeps an in-memory event view with the protocol reducer | Durable receipts, so retried commands are safe |
| Deciding what to do after a gap or an unknown outcome | Reports gaps, conflicts and unknown outcomes | Retained event windows for replay |

The SDK never widens permissions. Provider capabilities and the runner's local policy always win.

## Connecting one socket

1. Authenticate the socket (see the [lifecycle spec](control-plane/lifecycle.md#the-websocket)).
2. Create one `HcpHostConnection` for that physical socket.
3. On `host.hello`, check `runner_id` and `host_id` against the authenticated identity, then call `accept`.
4. Pass `accept` only a replay cursor you have **durably stored**. Receiving an event does not mean you may advance the stored cursor. The SDK's reducer is an in-memory view, not an acknowledgement.
5. On socket close or error, call `disconnect`. Create a new connection for the next socket.

After acceptance, the runner sends its capabilities: providers, models, folders and policies. Store them in your app's view. A missing capability means unknown, not deleted. Workspace results and session snapshots marked complete replace what you had, as the protocol defines.

You can restore a reducer from validated, stored snapshots and pass it to the constructor.

## Commands and completion

Every app-to-runner operation has a typed SDK method:

| Area | Methods |
| --- | --- |
| Sessions and turns | `startSession` (MCP attachments go here), `sendTurn`, `cancelTurn`, `stopSession`, `requestSnapshot` |
| Answers | `respondToApproval`, `respondToInput` |
| Tools and machine | `detachTools`, `runLocalAction`, `manageWorkspaces` (list, add, rename, remove), `setupProvider` ([install or update an agent](provider-setup.md)) |
| Conversations | `conversation` and typed helpers; see [conversation controls](#conversation-controls) |

What each call resolves to:

| Call | Resolves to | Finished when |
| --- | --- | --- |
| Session and turn commands | An ACK: the runner **accepted** it | The matching terminal `harness.event`, such as `turn.completed` |
| Snapshot, workspace, provider setup and local-action requests | Their matching result message. An ACK never finishes them | The result arrives |
| Any refused command | Rejects with `HcpCommandRejectedError` and the runner's structured error (a NACK) | — |

Rules:

- **Store a command before sending it** if you need to recover from a crash. Keep the same id and payload on every retry.
- The SDK **never retries** by itself.
- Workspace and local-action errors come back as typed result messages, not NACKs, so their snapshots and audit records are kept.
- **Start waiting for an event before you send** the command that causes it. `waitForSessionEvent` only sees events after the point it starts.
- Only **one root turn** runs per session at a time. A refused concurrent turn id can be used again. Cancelling an older turn cannot interrupt a newer one or its MCP reviewer.

### When the outcome is unknown

A timeout, a cancelled local wait or a lost connection rejects with `HcpOutcomeUnknownError`. All pending waits reject when the connection closes. None of these cancel the work on the runner.

- Reconcile first, with a snapshot or a list, before sending another change.
- To stop a running turn, send an explicit cancel.
- Never turn an unknown outcome into a second delivery of the same prompt.

Your app decides how long to keep event history.

## Execution profiles and late requests

**Level 2.**

- Choose an advertised `execution_profile` when starting a session. Leaving it out keeps the `isolated` behaviour.
- Each profile in `execution_profiles` declares its runtime lifetime and whether it supports native work and between-turn session events. See [provider support](native-providers.md).
- A persistent adapter registers who answers its session's interactions with `registerSessionInteractions`.
- Approval and input requests that arrive late keep the root turn they were admitted under. Your answer must name that exact origin.
- `native.request.lost` means the live callback is gone. `native.work.owner_lost` fences the work controller. Replaying these events restores what you display, not the callbacks.

### Session-scoped input

Some agents ask for input without a confirmed root turn.

- These use `request_scope: "session"` on the requested, resolved and lost events, and on `harness.input.respond`.
- No `turn_id` is allowed in that data or in its event envelope.
- Without `request_scope`, replies stay bound to a turn, as before.
- The native owner checks scope, request, session and answer schema before accepting. An app's MCP grant cannot answer it.
- Once the owner is lost, replies are refused, even if a callback object still exists.

The packaged example consumers exercise a question asked after a turn completes, and session-scoped input. They check that answers from another turn, turn-bound answers to session input, and answers after owner loss are refused.

## Effective settings

**Level 3.** What you asked for and what the agent actually used are reported separately:

| Event | Confirms |
| --- | --- |
| `settings.effective` | The complete root settings snapshot |
| `settings.options.effective` | Only the native model and model options |

- Both require an admitted `turn_id`, `scope: "root"` and `source: "native"`.
- `model_selection` may hold the agent's canonical model id and restored default options, even if you sent an alias or removed an override.
- They do not change child work that is already running.
- Never infer policy or containment from a model-option event.

## Empty conversations

**Level 3.** An `empty_conversation` capability (on the provider or the selected profile) confirms that a native conversation exists at startup, before any prompt.

- Send a `continuation_group_key` to keep it across unloads and runner restarts.
- Startup saves and reads back the binding before reporting `native_conversation_ready`. An adapter cannot report it with an unconfirmed generated id.
- Startup adapters receive the already-authorised MCP tool lists in `mcpToolsets`. Native tool definitions can exist before the first turn, without permission to call tools while idle.

## Child agents (native work)

**Level 3.** Approval, input and lost-callback events may carry `native_work_id` when the native owner confirms a child execution.

- They keep the child's original root turn, even while another root turn runs.
- Session-scoped input cannot claim a work id without that origin.
- The runner checks that the work is live before admitting a new child request.
- Adapters use `reviewNativeWorkMcp(workId)` for child MCP operations, and the shared `dispatchMcp` slot for the whole approval, call and input lifecycle.
- A lost callback never resumes the root to recreate it. Unresolved MCP receipts block later dispatch.

This interface does not depend on any app's task or thread model.

## Conversation controls

**Level 3.** `conversation` and its helpers offer, when the capability is advertised: history reads, fork, rollback, content retrieval, work controls and context injection (`injectContext`).

- `live_history_read` lets you read a retained thread without unloading its owner. Changes need an idle owner.
- Injection carries user and assistant text plus an expected history hash. Its result says whether the context was applied, or the agent confirmed it has no such method.
- Injection fences and receipts are owned by the runner. They carry no product ids or formatting rules.

See the [SDK README](../packages/hcp-sdk/README.md#conversation-controls) for examples.

## Account usage

**Level 3.** A read and snapshot pair, gated by the `account_usage` capability, reports provider account limits without a session. Only send account reads when the runner advertises `account_usage`. Capacity policy, budgets and admin actions belong to your app. HCP needs no extra service. See [account capacity](account-capacity.md).

## Releasing and validating the packages

For maintainers. `npm run release:check` builds and tests the repository, packs only the allowed files, and installs all three tarballs in a clean project. That project uses public exports only, and drives a real runner over loopback WebSocket through folder changes and a mock-provider session's terminal event. This proves package and protocol boundaries. It does not prove live Codex or Claude execution.

Publish in this order: protocol, then SDK, then runner. Consumers such as P2A pin exact registry versions and take their schemas from the installed package. Publishing needs npm access to the `@harness-control` scope. A packed candidate can be tested before publishing; it is not a registry release. See the [release process](maintainers/release-process.md).
