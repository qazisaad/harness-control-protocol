# Idle conversation configuration transitions

A fresh `harness.session.start` owner can explicitly replace a retained conversation's policy or execution profile by setting `continue_session: true`, its existing `continuation_group_key`, and:

```json
"conversation_transition": {
  "transition_id": "unique-app-transition-id",
  "expected_history_hash": "sha256-from-current-conversation-read"
}
```

Use a fresh HCP session ID, retain the original provider/workspace, instructions, configuration inheritance and selected tools, and supply the desired `approval_policy`, `sandbox_mode` and `execution_profile`. Model/options remain subject to the driver's separate root-setting contract. A transition cannot contain `first_turn`; it does not authorize a model request.

The app stops the old owner and waits for successful shutdown, reads retained native history, then starts the replacement owner. Discovery must advertise `idle_configuration_transition: true` on the selected target profile. The runner requires confirmed source shutdown, closed native work, no unresolved fork/rollback/injection/transition, and a previously verified configuration base. It compares current native history with the selected hash before dispatch.

Before native startup the runner persists a bounded pending receipt with the transition ID, original/target binding hashes, expected history and target owner ID. Startup must preserve native conversation identity, return matching native policy evidence, and verify unchanged history again. Only then does the runner atomically retain the new binding and complete its receipt. `session.configured.native_policy_readback` distinguishes native effective policy from requested settings. A plain ACK or requested value cannot stand in for that evidence.

Receipts cannot be erased or rewritten, nor completed without their prior dispatch fence. Missing startup/readback/history confirmation retains the pending fence. Automatic retry, another startup, conversation mutation and retirement then refuse; read-only diagnosis remains available. Reusing a session or transition ID cannot silently create another execution owner. This first implementation deliberately quarantines uncertain outcomes; it does not provide an operator reconciliation command yet.

The base binds instructions, inheritance, tools, provider configuration and canonical workspace. Local capability authority is bound by actor, host, policy version and grant descriptors; fresh lease/session IDs and expiry timestamps are separate authorization, so equivalent renewed leases do not alter the conversation base. Changing those authority fields requires a separate supported handoff. Legacy bindings without a base must establish one through a verified normal continuation before requesting a transition.

The native targets use the same interface without app-specific fields or native RPC passthrough:

- Codex 0.160.0 `interactive`: `thread/resume` readback verifies actual approval policy, reviewer, sandbox and containment before any root model admission.
- Claude Code 2.1.289 / SDK 0.3.267 `interactive`: an existing retained conversation boots with an empty input channel. Permission controls establish an observed opposite mode, then restore the selected mode, requiring native status frames bound to that exact conversation. Selected MCP proxies are registered only after that proof, with exact native registration receipt and connected endpoint inventory. No prompt is offered. This capability does not claim that Claude can create a durable fresh empty conversation or change the bound tool catalog. The ordinary first root still requires its full workspace, permission, MCP and plugin initialization proof.
- OpenCode 1.18.34 `interactive`: explicit controlled configuration, the original account owner and an existing non-background native conversation are required. The session endpoint appends rules. The adapter verifies source permissions before dispatch, then verifies the complete effective target rules in both update and fresh readback. Only the known wildcard/edit/question/task vocabulary with wildcard paths is accepted; unknown or path-specific grants refuse. The current transition cannot enter or leave the background child execution contract. OpenCode supplies no filesystem containment, so its sandbox remains `danger_full_access`. Probe and server startup deadlines are bounded at 15 and 30 seconds respectively.

Model/options controls remain independent of idle policy replacement. Missing native status, mismatched permissions, provider loss or changed history cannot complete a transition receipt. The application's sequence is confirmed stop, then closed-history read, then replacement. Reading before stop can select a stale hash while native transcript records are still flushing.

The opt-in native acceptance is `HCP_NATIVE_LIVE=1 HCP_LIVE_PROVIDER=codex node scripts/check-idle-transition-live.mjs` (also `claude` and `opencode`). It tests an isolated source, interactive policy replacement and restoration, supported sandbox changes, unchanged native history, marker recall, durable receipts across runner recreation and ordinary continuation after completion. See `native-providers.md` for completed acceptance evidence and remaining limits.

For Claude, add `HCP_LIVE_MCP=1` to exercise the same selected local MCP catalog across idle policy transitions. It also verifies actual native tool invocation after the transitions and closure of all replaced proxies. Native registration uncertainty cannot complete the configuration receipt or admit a prompt.
