# Local runner ownership

Both `connect <url>` and `run --config <path>` acquire the same local connection
owner before starting a runner. `connect` also holds ownership during setup and
pairing. A repeated ordinary `connect` reports that HCP is already running and
exits successfully without starting a second runner. This is a local process
result, not proof that the control plane considers the machine connected.

If a command requests pairing, provider selection, or an explicit custom config
while the connection is occupied, it reports that those changes were not applied.
Stop the original runner with Ctrl+C, then repeat the requested command. Direct
`run --config` also rejects an occupied connection instead of claiming the selected
configuration was started.

## Ownership and crash recovery

`src/ownership.ts` owns acquisition and release. The normalized control-plane URL
selects the existing connection directory under `~/.hcp-runner/connections/`.
`runner.owner` is a persistent file whose open descriptor holds an exclusive OS
lock. The file is never deleted or replaced. Process exit, including SIGKILL,
releases the OS lock; a leftover filename is not evidence of a running process.

The runner uses `fs-native-extensions` 1.5.1 with packaged native binaries, including
macOS, Linux, and Windows x64/arm64. Its [locking API](https://github.com/holepunchto/fs-native-extensions#api)
uses native descriptor locks rather than a heartbeat expiry. There is no daemon,
port reservation, or periodic lock maintenance. Do not delete `.owner` files:
replacing a locked inode would defeat exclusion. These files belong on the local
machine's filesystem, not a shared multi-machine runner home.

The existing `runner.json.lock` is retained as a marker to keep older `connect`
commands out while the new runner is active. Metadata is published atomically,
so a new process cannot leave an empty marker between creation and writing its
PID. New markers have validated version/PID/token metadata; the OS lock is the
authority, and a stale marker is replaced even if its PID has been reused.
Normal release removes only that owner's matching marker while still holding the
OS lock. Release is idempotent.

For a marker left by published 0.3.0, recovery checks its positive PID and proceeds
only when the OS reports that process does not exist. A live/reused PID,
permission failure, or malformed older marker produces a specific diagnostic
without deleting files or killing processes. This migration exists because the
currently published runner can strand real user connections. Older `run --config`
processes did not participate in locking and must be stopped before upgrading;
the new runner cannot retroactively lock an old process's state writes.

The runtime also locks the canonical state path before creating its state store.
It writes through that canonical path, so a symlink cannot become a second writer
when atomic state replacement occurs. Configurations for different endpoints
that share a state file cannot run simultaneously. Two hard-linked state files
are not a supported configuration: atomic replacement would split their identity.

## Shutdown and validation

CLI signal handlers are installed before asynchronous runtime startup. SIGINT and
SIGTERM close the connection and exit; the exit handler releases the connection
marker, and the OS releases descriptor locks. Setup cancellation and startup
errors release ownership through `finally`. No credential or folder reset is
part of recovering an owner.

`ownership.test.ts` exercises real competing subprocesses, SIGKILL, death before
metadata publication, old PID migration, reused PIDs, permission errors, malformed
markers, repeated release, and state aliases. `cli-ownership.test.ts` runs the
actual CLI `main` in subprocesses using an isolated home and loopback control
plane. It proves unchanged config and credentials after a crash, both directions
of `connect`/`run` exclusion, exclusion across shared state, and a native Codex
adapter turn against a local RPC fixture through `turn.completed` and
`session.exited`. It also cancels during pairing, token acquisition, and runtime.

CI runs ownership checks on macOS, Linux, and Windows. The CLI test uses an
executable Unix fixture and is skipped on Windows; native owner/process tests run
there. Local validation is not proof of CI success or of real provider/P2A
production execution.

Consumers own pairing authorization and server-side connection status. They
should adopt the coordinated published HCP release and give restart instructions,
not implement their own lock cleanup. This change adds no wire schema or
control-plane endpoint.
