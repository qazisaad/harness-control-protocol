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

Use a new `HcpHostConnection` for each physical socket. Pass only your durably committed resume cursor to `accept`. `events` uses the canonical protocol reducer; gap/conflict results and `host.replay.unavailable` require application recovery. Retaining an event in memory does not acknowledge durable consumption. The app owns event retention and can supply a restored reducer to the constructor.

For transactional or non-WebSocket code, import `createCommand` and `parseCommand` without constructing a connection. This is the API used by P2A's Convex integration.

See [the public package contract](https://github.com/qazisaad/harness-control-protocol/blob/main/docs/public-packages.md), [pairing](https://github.com/qazisaad/harness-control-protocol/blob/main/docs/pairing.md), and [the standalone example](https://github.com/qazisaad/harness-control-protocol/blob/main/examples/public-sdk.mjs). Provider support is capability-dependent; unsupported policies are never widened automatically.
