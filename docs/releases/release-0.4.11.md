# 0.4.11 release candidate

Codex execution reuses an initialized app-server process after a successful turn.
The adapter owns at most four exclusive leases and retires idle processes after
two minutes. The key includes provider configuration and environment, canonical
workspace path and identity, sandbox, approval policy and MCP attachments. Every
invocation still reads configuration, checks tool inventory and creates a fresh
thread or resumes an explicitly authorized persisted conversation.

Runner-owned app servers receive `-c thread_unload_delay_secs=0`. After completion,
the adapter unsubscribes and verifies an empty `thread/loaded/list` inventory and
no pending native RPC/request work within two seconds. Older native providers or
failed cleanup destroy the process instead of reusing it. Cancellation, native
failure and uncertain outcomes also destroy it. Logical session exit closes its
MCP clients and capabilities; an already cleaned idle process remains runner-owned.
Embedding applications must call `HarnessSessionManager.close()` at shutdown.
`RunnerConnection.close()` does this automatically, including queued startup cleanup.

Private `CodexHarnessAdapterOptions.onProcessLease` instrumentation reports a
boolean only; the public event schema does not change. No model or tool execution
is replayed, and conversation histories or approval callbacks cannot be inferred
from a matching process key.

Local native Codex 0.160.0 acceptance completed three fresh logical sessions with
process reuse false/true/true and first text 4126/2763/3107 ms. These include model
variation and exclude hosted/UI transport; they do not establish production savings.
Final release checks validate archives and clean consumer imports. Publishing,
control-plane dependency upgrades and paired-runner replacement remain release
steps; source validation alone does not upgrade installed runners.

Claude uses one streaming-input SDK query across turns in the same live HCP
session. An independent HCP conversation receives a separate query. Every turn
rechecks provider/environment, canonical workspace, model/effort, MCP configuration
and execution policy bindings. An expired, stopped or changed conversation fails
without starting an empty replacement. Multi-turn capability is enabled; durable
cross-HCP-session continuation remains unsupported. Cancellation and failure stop
the native process; session exit and runner shutdown close retained queries.

OpenCode leases an initialized local server but creates a distinct native session
for each HCP session. It verifies session.idle before successful completion and
requires native DELETE acknowledgement before returning the server to the pool.
Failed/deadline cleanup, turn failure and cancellation physically stop the server.
Native abort response loss during shutdown does not replace the physical-close
proof. Server scope binds executable, environment, canonical workspace and its
identity, policy and MCP configuration. Startup/session creation and cleanup have
bounded timeouts. Codex, Claude and OpenCode share the exclusive process pool:
four entries per adapter, two-minute idle expiry and capacity retained during stop.

Provider reuse regressions exercise persistent SDK input/history, unrelated
conversation isolation, changed scope rejection, exhausted input streams, real
HTTP/SSE server reuse with unique native sessions, failed deletion, workspace scope
changes and cancellation with physical child closure. Claude/OpenCode native model
benchmarks were not run: their executables are unavailable in the current WSL PATH.
