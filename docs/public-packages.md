# Public packages and integration contract

HCP has three public packages, released together at the same exact version:

- `@harness-control/protocol`: wire types, validation, JSON Schema, pairing contracts, and the canonical session event reducer. No provider SDK or Node transport dependency.
- `@harness-control/sdk`: app-side command construction and one authenticated runner connection. It depends only on the protocol package.
- `@harness-control/runner`: local CLI and embeddable runner modules, including provider adapters, filesystem policy, durable command receipts, and MCP attachments.

P2A and external apps use these same exports. P2A's Convex transactions use the SDK's stateless command API; its Python WebSocket service validates JSON Schema exported by the installed protocol package. No Node service is added to P2A.

## Ownership and transport

The application owns pairing approval, authentication, machine/user ownership, authorization, WebSocket hosting, durable command/event storage, and persisted replay cursors. Authenticate the socket and verify `host.hello` against that identity before calling `accept`. Use one SDK connection per physical socket. Call `disconnect` on socket close/error and create a new connection for the next authenticated socket.

The SDK validates envelopes at entry, builds typed commands, correlates replies, and applies the existing protocol reducer. Its event reducer is an in-memory view, not a durable acknowledgement. Pass only durably committed cursors to `accept`; receiving an event does not authorize advancing a persisted cursor. Apps can restore a supplied reducer from validated persisted snapshots.

Providers, models, workspaces, and policies arrive through capability messages. Pass these to the app's projection; omitted capabilities are not deletion. Workspace results and explicitly complete session snapshots have the replacement semantics defined by the protocol. Gaps, conflicts, and replay-unavailable messages are surfaced for explicit snapshot recovery.

## Commands and completion

Every current app-to-runner operation has a typed SDK method: session start, turn send/cancel, session stop/snapshot, approval/input response, MCP detach, local actions, and workspace list/add/rename/remove through `manageWorkspaces`. MCP attachments are part of session start. Provider capabilities and local policy remain authoritative; the SDK never widens requested permissions.

Prepare and persist the complete command before sending if crash recovery is required. Its id and payload survive retries. The SDK never retries automatically. Session/turn command promises resolve to an ACK, which means accepted, not completed. Consume `harness.event` through the terminal event. Snapshot, workspace, and local-action requests resolve only to their matching result; an ACK cannot finish these requests. Workspace/local errors remain typed result messages so their snapshots and audit evidence are not lost. NACKs reject with the runner's structured error.

Timeout, cancellation of a local wait, or connection loss can leave the operation's outcome unknown. They do not cancel a remote operation. Reconcile via snapshots/list before creating another mutation; use the explicit cancel command for a running turn. All pending waits are rejected when their connection closes. The application bounds retained event storage according to its lifecycle.

## Release and validation

Build and test the repo, pack allowlisted files, and install all three tarballs in a clean external project. That project imports public exports only and drives the real runner over loopback WebSocket through folder changes and a mock-provider session's terminal event. This verifies package and protocol boundaries; it does not claim live Codex/Claude execution.

Publish protocol first, then SDK and runner. P2A pins exact registry versions and derives Python schemas from the installed package, avoiding a separate checkout as schema owner. npm account access to the scope is required to publish. Packed release candidates can be tested before publishing; they are not described as registry releases.

No new persisted entity, worker, service, cross-service protocol, or compatibility mode is introduced. The only new state is a bounded set of in-flight waits per socket; durable facts remain with their existing owners.
