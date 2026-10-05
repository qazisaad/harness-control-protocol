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
