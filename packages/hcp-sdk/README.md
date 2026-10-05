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
