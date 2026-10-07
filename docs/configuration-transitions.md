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

## Explicit MCP catalog replacement

A profile advertising `idle_mcp_catalog_transition` can accept the same stop/read/start flow with `conversation_transition.change: "mcp_catalog"`. Omission remains the original policy-only control. The destination's selected MCP descriptors and runner-discovered tool schemas form its new full binding. A separately retained `configuration_authority_hash` still binds the provider, canonical workspace, instructions, configuration inheritance and local capability authority. Catalog replacement cannot change this hash. Older retained conversations must establish it with a verified ordinary continuation of their original catalog before requesting replacement.

The native target must return exact connected attachment names from its native registry, published as `session.configured.native_mcp_catalog_readback`. Missing, extra or disconnected registry entries cannot complete the durable transition fence. The runner independently owns the authorized tool catalog and its proxies; a requested attachment count is not native readback. No root model prompt is offered during the transition. Failed registration or changed history leaves the pending receipt quarantined.

Claude interactive verifies the SDK dynamic registration receipt and the exact connected HTTP endpoint inventory. Controlled OpenCode interactive verifies its owned provider/configuration and queries `/mcp` for the connected registry. Background OpenCode MCP remains unavailable because child caller provenance is unverified. Codex does not advertise this replacement: the pinned native continuation contracts cannot replace this adapter's persisted dynamic tools. These new controls have focused fixture and packed-consumer evidence; authenticated Claude/OpenCode installed-native catalog acceptance remains pending.

## Claude session model options

Interactive Claude accepts explicit boolean model options `thinking`, `fastMode` and `ultracode`. They use native session flag controls and never write user/project configuration. The runner confirms the flag layer plus effective thinking or applied ultracode, and requires fresh native initialization status for fast mode. A requested fast mode that is disabled or in cooldown cannot be reported as confirmed. Native downgrade, missing readback or lost control response prevents the next prompt and loses the uncertain owner.

Removing an option on a subsequent selection explicitly clears its flag override. `settings.options.effective` reports the actual observed model/effort and boolean settings that native readback establishes. Omitted native defaults remain unknown. Unchanged settings reuse the continuously retained owner; changes require resolved child work and native callbacks before controls can run. The isolated profile refuses these options because it cannot establish this session-control boundary. Installed no-model opt-out/reset checks pass; enabled authenticated model acceptance remains outstanding.

## Explicitly authorized in-place policy selection

A profile declaring `native_policy_control: "idle_native_owner"` supports a distinct public control on its initialized idle physical owner. Authorize future selections explicitly in the original interactive startup, with a continuation group:

```ts
policy_control_authority: {allowed_selections: [
  {approval_policy: "ask", approval_reviewer: "user"},
  {approval_policy: "full_access", approval_reviewer: "user"},
]}
```

After native readiness and root/work/callback closure, use the public SDK:

```ts
const result = await connection.updateNativePolicy(sessionId, {
  expected_revision: 0,
  selection: {approval_policy: "full_access", approval_reviewer: "user"},
});
```

The receipt confirms fresh native permission status on the same native conversation and advances the per-owner revision. The runner publishes `session.configured.policy_revision` and retains prior admissions' policy binding. It never asserts unchanged opaque native history. Claude 2.1.289 / SDK 0.3.267 interactive declares this operation; Codex and OpenCode do not. Reviewer `native_auto` requires `auto_edits` and the matching explicitly authorized selection. Future bypass requires its launch-time native flag while preserving the actual initial ask mode.

This operation cannot change sandbox, approval options, tools, configuration inheritance or other launch authority. Lazy fresh owners may refuse until actual native initialization; a configuration ACK alone is insufficient. An observed active goal, unresolved child or callback, pending native mutation or uncertain owner refuses the control. Missing native/persistence confirmation leaves a durable pending fence with no mutation retry, new root, successor startup or retirement. Confirmed command replay returns its persisted receipt. Separate stop/read/start transitions retain their original exact history requirements.

## Cold application restoration

After confirmed physical closure, a restarted application can open a new session generation with its durable continuation group and `expected_native_reference`, the last identity observed in native session readiness. Set `continue_session: true` and omit `first_turn`. The runner compares that public reference with its own retained private custody before native acquisition or model dispatch, including adapter-specific reference projection when private custody wraps account authority. Existing provider, account, workspace, configuration, pending execution and closure checks still apply. The reference assertion grants no native-ID import authority. The SDK independently checks eager or lazy readiness against the assertion and fences substituted identity.

Keep saved application identity separate from physical session IDs. Allocate a fresh physical generation on restoration. A known unresolved SDK generation remains fenced; restarting a registry is not evidence that uncertain native ownership has closed. Refused continuation must not become fresh conversation creation or model dispatch.
