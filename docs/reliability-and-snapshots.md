# Reliability And Snapshots

HCP uses at-least-once command and event delivery. A control plane may resend a command or receive the same event more than once. The runner makes those retries safe by persisting event windows and settled idempotency receipts before it sends their corresponding network messages.

## Command Acceptance

`hcp.command.ack` means the runner accepted responsibility for a command. It does not mean the provider turn or local action completed.

```text
Control plane sends harness.turn.send
  -> runner validates and reserves the turn identity
  -> runner persists the command ACK receipt
  -> runner sends hcp.command.ack
  -> runner emits sequenced turn.started and terminal events independently
```

If the same command ID and payload arrive again within the receipt retention window, the runner returns `duplicate: true` without executing it again. A reused command ID with a different payload is rejected. Settled command and local-action receipts are retained for at least 24 hours by the default store.

## Cursor Ownership

Cursor direction is explicit:

```text
Runner host.hello
  -> advertises retained_events ranges
Control plane host.accepted
  -> supplies resume.last_event_sequence values it durably applied
Runner
  -> replays events after each supplied sequence
```

The runner never claims to know what the control plane persisted. The control plane must advance its cursor only after its event projection and cursor update are durably committed together.

When a requested cursor is outside the advertised range, the runner sends `host.replay.unavailable`. This message is deliberately outside the per-session event sequence, because a missing sequence cannot safely report its own gap. The control plane can request `harness.session.snapshot`, recover through another durable source, or mark the session uncertain.

## Snapshot Omission Semantics

A session snapshot is a retained canonical event slice. It is not product chat storage.

- `completeness: "complete"` always starts at sequence 1 and uses `omission_semantics: "replace"`.
- `completeness: "partial"` uses `omission_semantics: "preserve"` and cannot delete omitted projected state.
- A partial snapshot names `retention_gap` or `size_limit`; either reason means the control plane must preserve state it cannot see.
- `tombstones` are the only deletion signal inside a partial projection.
- Snapshot events are contiguous, belong to one session, and end at `through_sequence`.

Control planes should reduce snapshot events through the same production event reducer used for live and replayed `harness.event` messages.

`HcpSessionEventReducer` in `@harness-control/protocol` is the reference implementation. It classifies each event as applied, duplicate, gap, or conflict; applies complete snapshots as replacement; applies partial snapshots as preservation-only deltas; returns tombstones to the caller's entity projector; and produces the cursor for the next `host.accepted` message. The mock control plane uses this reducer rather than a separate test-only projection.

## Durable Runner State

The CLI uses an atomic JSON state store at:

```text
~/.hcp-runner/state/<runner-id>.json
```

Set `state_path` in runner config to override that location. The file contains retained session events, command receipts, and local-action receipts. It does not contain provider credentials, product messages, workflow queues, or full terminal history.

If the state file is malformed, startup fails rather than silently discarding idempotency history. Applications embedding `HarnessSessionManager` can inject a `RunnerStateStore`; the default in-memory store is intended for tests and short-lived embedding only.
