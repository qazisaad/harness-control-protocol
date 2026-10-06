# Generic harness migration: implementation and agent handoff

Checkpoint: 7 October 2026. This is the current handoff for the HCP work originally developed on `generic-harness-controls`, starting from `98423ae`. The last feature milestone before integration with remote main was `afc4486`. This checkpoint integrates remote main `35ee339`, including `f83fc37` and the 0.4.12 native instruction API. Read this document before continuing the task. Earlier entries in `native-providers.md` are historical checkpoints, not a current completeness checklist.

## Objective, scope and boundary

Make HCP a reusable protocol/interface through which independent application builders can control native harnesses. T3 Code is the reference consumer used to find missing behavior. Its existing custom native integration must eventually be replaceable without losing supported behavior. **That replacement is not complete, and no T3 adapter has been switched.** No Prompt2Agent implementation was changed in this work.

The user currently uses Codex, Claude Code and OpenCode Go. Cursor, Grok, Antigravity, Pi and ACP are outside this acceptance target; do not claim support or certification for them. Keep the adapter interfaces extensible for other harnesses.

HCP owns native execution lifetimes, request/response translation, effective native settings, owned background work, native conversations, scoped content and tool attachment controls. Applications own product thread IDs, UI, scheduling, checkpoints, orchestration policy and application workflows. Do not add T3-specific IDs, DTOs, named tools, application workflows or raw provider RPC passthrough to the public protocol. T3's eventual consumer adapter should translate its concepts to HCP rather than move product code into HCP.

## Implemented work and why

| Area | Implemented behavior | Reason / limits |
| --- | --- | --- |
| Conversation controls | Public SDK/adapter operations for native read, portable history, pagination, fork, logical rollback, supported injection, compaction and active steering; scoped large-content retrieval; durable mutation receipts. | Apps need conversation control without reaching through the runner to native RPCs. Logical rollback does not claim filesystem undo. Native injection remains provider-specific and capability-gated. |
| Persistent execution | Explicit execution profiles; retained Codex RPC, Claude SDK query and OpenCode observation/server owners; independent background work observations, cancellation, revisions and unload proofs. | A root turn's completion is not the end of subagent/task work. Owned commands are also projected for Codex. Do not infer terminal work from an empty inventory or process disappearance. |
| Ownership and interaction routing | Admitted native turn identities, child ancestry checks, retained callbacks across root turns, supported remembered/session permission choices, asynchronous input and native MCP form handling. Lost callbacks are fenced and reported honestly. | A response must settle the exact still-owned native callback. SDK/process death is not a user cancellation. Native transport data that lacks a root/child identity stays session-scoped. |
| Configuration authority | Explicit instruction roles, supported configuration-inheritance choices, workspace/provider/account bindings, controlled OpenCode configuration and selected MCP isolation. | Native settings, hooks, plugins and tools must not acquire undeclared authority from a user's global configuration. Unsupported inheritance combinations refuse before launch. |
| Effective settings | Native model/options catalogs and measured effective root model/effort settings; supported changes while retaining existing background work; verified idle policy/profile transitions preserving native conversation identity and history. | Requested settings or a control ACK alone are not proof of effective settings. Idle replacement requires confirmed source shutdown, unchanged configuration base and history, and exact target readback. Unknown outcomes remain quarantined. |
| Context and file inputs | Explicit app-supplied user/assistant prompt context with provenance; separately authorized native injection; owned chunked non-image files with integrity, materialization, conversation/fork retention and cleanup. | Handoffs and attachments need generic delivery and ownership, without pretending portable app history is a native transcript or granting it system/developer authority. |
| Native evidence | Scoped context measurements separate from billing usage; typed Claude session quota and retry observations; retained asynchronous assistant output; corrected Claude root correlation across successive native API/tool rounds. | Preserve real native evidence without invented turn attribution, context capacity, account totals, retry recovery or execution completion. Live quota/retry frames were not deliberately induced; those projections also have native-type/stream-fixture evidence. |
| Owned child history | Bounded native/portable child history on verified live owners for Codex interactive, Claude interactive and controlled OpenCode background. | Consumers need child context without arbitrary native-ID access. Current capability is `native_work_history: live_owner`, not offline recovery or child fork/resume. |
| MCP lifecycle | Production HTTP proxy form bridge, modern and bounded legacy continuations; native attach/unload/resume acceptance for all three providers; Claude dynamic registration, verified idle detachment and same-catalog reattachment across idle policy changes. | Registration/removal receipts and connected endpoint inventories precede success; owned proxies close and unknown/pending removal fences prompts. This does not authorize arbitrary catalog replacement. |
| Optional native feedback | Public capability-gated feedback operation, adapter hook and Codex feedback RPC translation, with explicit diagnostics selection and durable no-replay dispatch receipts. | Independent apps may submit explicit feedback. No actual external feedback report was sent during this work. Diagnostics requested are not automatically claimed to be included. |
| Public portability | Generated schema parity, exported SDK/adapter contracts, protocol conformance and separately packed consumers, including custom non-Codex adapters and owned MCP controls. | Features must work through public packages, not imports of runner internals or app-specific assumptions. |

Detailed contracts: [configuration transitions](configuration-transitions.md), [owned child history](native-work-history.md), [input files](input-files.md), [prompt context](prompt-context.md), [MCP forms](mcp-elicitation-bridge.md), [MCP detach](mcp-detach.md), [native output](native-output.md), [retry observations](native-retries.md), [quota observations](native-rate-limits.md), [feedback](native-feedback.md), and [provider evidence](native-providers.md).

## Important implementation checkpoints

The full feature history remains in Git; do not squash away the evidence behind the handoff.

- `3414c12` / `791d112`: public conversation-control foundation and bounded content retrieval.
- `113c22c` / `defedc2`: durable native-work observations, cancellation fences and owner-loss handling.
- `e1df672`: persistent Claude ownership and session interactions.
- `dff3d6c` through `49a7b44`: retained Codex ownership, native ancestry/shutdown proofs and late child callbacks.
- `a842f97`, `b5d6906`, `c4ae54f`, `9fb7ac0`: controlled OpenCode configuration, permissions, callback ownership and background profile.
- `29098cd`, `01b9f6c`, `bb891b5`: verified native root settings/model options.
- `f9589c2` / `5199ed1`: supported durable empty-conversation startup without fabricating model turns.
- `f682091` / `43081b9`: owned non-image files and explicit prompt context.
- `96264a0`: owned live child history across the three providers.
- `5e09978`: durable no-model idle policy/profile transitions.
- `09fb327`: modern/legacy production MCP form bridge.
- `9cdcf24`: native feedback interface and Codex background commands.
- `220556f`, `8e1fe0a`, `7e56715`: typed native quota, asynchronous output and retry observations.
- `b946ca2`: Claude reply-lane correction across successive API/tool rounds. The SDK stamps the first reply of a typed turn; do not revert to requiring a stamp on every API response.
- `e0af8b9` / `a03d3a3`: native selected-tool lifecycle acceptance and Claude dynamic MCP detachment.
- `ce19c0b`: confirmed Claude idle policy changes with the same selected MCP catalog retained.
- `afc4486`: actual selected MCP invocation by an owned Claude background child, proved through its bound native transcript.

## Integration with newer remote main

Remote main advanced independently to 0.4.12 while this branch was being developed. Preserve its package versions, registry/runner shutdown API and legacy native instruction input. The explicit-role instruction object remains the preferred new contract; 0.4.12 strings map to Codex developer instructions or Claude's preset append, and remain unsupported for OpenCode. Neither instruction form is prepended to the user prompt.

The older automatic runtime-pooling integration overlaps the new explicit execution-owner contract. Session-owned interactive runtimes are reusable across roots while retaining native work and callback ownership. Isolated owners close independently. Cross-session pooling that deletes OpenCode native sessions on unload would violate the new retained-history/continuation contract and must not be restored just to reproduce an older process-count assertion. Native conversation identity and closure evidence, not a matching cache key, authorize reuse. Integration tests must assert these declared lifetimes, history retention and shutdown fences. The earlier pool utility is not proof that pooled/native ownership has been certified under the new contracts.

Package version 0.4.12 originates from the separate remote-main releases. These migration additions are **not an npm release**, and this merge does not certify that previously published 0.4.12 packages include them. Coordinate an appropriate new package/schema version before publishing or upgrading consumers. Do not publish automatically as part of this handoff.

## Remaining work: start here

### 1. Build the operation-by-operation parity inventory

Recheck the current [T3 source](https://github.com/pingdotgg/t3code) before implementing more features. The original comparison used T3 commit `77823bd102ae50430d4acda9a553e5743d2aa5ba`; it is a reference baseline, not a guarantee of today's upstream behavior.

Read T3 `apps/server/src/orchestration-v2/ProviderAdapter.ts`, the active adapters under `apps/server/src/orchestration-v2/Adapters/` (`CodexAdapterV2.ts`, `ClaudeAdapterV2.ts`, `OpenCodeAdapterV2.ts`), and `packages/contracts/src/providerRuntime.ts`. Record each supported operation/event, its HCP equivalent, actual provider/profile capability, relevant validation and any missing behavior. Include recovery, pending work, model/context state, permissions/questions, history/attachments, MCP, fork/rollback, cancellation/unload and optional feedback. Separate product-owned behavior from missing harness contracts. This matrix is required before calling the replacement complete; test counts are not a percentage of parity.

### 2. Implement authoritative provider-loss reconciliation

Primary HCP entry points:

- `packages/hcp-runner/src/harnesses/index.ts`: `#nativeWorkOperation`, `native.work.owner_lost` processing, continuation/startup and unload fences.
- `packages/hcp-runner/src/state/index.ts`: `NativeWorkState`, durable cancellation/mutation receipts and the prohibition on clearing `closure_unconfirmed` through metadata updates.
- `packages/hcp-protocol/src/native-work.ts`, `conversation.ts`, and `packages/hcp-runner/src/harnesses/adapters/types.ts`: public work operations and adapter ownership hooks.
- `packages/hcp-runner/src/harnesses/adapters/providers/codex-work.ts`, `claude-session.ts`, `opencode-work.ts` and their callback routers: exact native execution admission and ancestry.
- `packages/hcp-runner/src/harnesses/native-work.test.ts` and provider ownership tests: negative cases and restart fences.

Persist the native execution/parent/admission evidence needed to authorize a later inspection or recovery before relying on it. A saved public work ID or transcript does not restore physical ownership. Define bounded native proof, durable receipts, stale-proof rejection and honest unknown outcomes. Do not clear uncertainty because a process exited, a list is empty, a caller retired a record or the runner restarted. Do not replay a lost permission/question callback or native mutation. Native providers that cannot prove a requested reconciliation must refuse or report unavailable.

### 3. Complete child conversation recovery and controls

Current history access requires the original live owner. Add only supported, custody-verified retained/offline access and child fork/resume controls needed by the parity inventory. Codex/OpenCode and Claude have different native child semantics; do not advertise a generic action on every driver merely because the protocol has a field for it. Verify parent/native identity, canonical workspace, original account/provider binding, revision/history stability and mutation receipts. Keep execution recovery separate from viewing a transcript. Confirm which child operations T3 actually supports for each provider.

### 4. Broaden supported MCP reconfiguration

Claude now supports verified removal and retaining the same selected catalog across idle policy changes. The base still binds instructions, configuration inheritance, selected tools and local authority. Codex/OpenCode currently detach through confirmed unload and do not advertise Claude's idle removal capability. Changing a catalog is a distinct control with authorization, native readback, receipt/unknown-state behavior and cleanup requirements; do not relax the existing binding hash to allow arbitrary changes.

Certify any required Codex/OpenCode child MCP behavior, Claude child-owned elicitation, remote authentication and broader native/version/OS coverage independently. The six-check Claude child probe proves invocation through owned history; its HTTP callback alone does not supply child identity. OpenCode background MCP caller provenance remains unverified. URL elicitation, sampling/roots and arbitrary MCP configurations are not covered by the current form/invocation checks.

### 5. Close fidelity gaps, migrate consumers and release

Use the matrix to identify remaining native projections rather than add every optional provider feature. Preserve refusals, replacements, failures, effective model/options, native context capacity and account evidence where required and supported. No guessed quota, capacity or successful retry recovery. OpenCode 1.x controlled API-key configuration has evidence; OpenCode 2.x, OAuth/remote configuration and arbitrary native versions do not.

Only after the HCP contracts and native implementations pass their acceptance gates should the T3 consumer adapter replace custom native logic. Validate each relevant T3 operation/event end to end through the public SDK. Keep T3 product orchestration outside HCP. Prompt2Agent will need coordinated package/schema adoption for contracts it consumes; its unrelated working-tree changes were not part of this work. Finish release/version compatibility and independent consumer checks before claiming full replacement.

## Validation and reproducibility

Historical final gate before integration: 130 protocol conformance cases (70 valid, 60 invalid), all workspace tests including **542 runner tests**, generated/packed schema parity, public exports and independent packed consumers. The subsequent Claude child MCP script passed six live checks. See `native-providers.md` for named successes and excluded failed probes; do not count a failed or superseded experiment as acceptance.

Final integrated checkpoint: `npm run release:check` passed on 7 October 2026 with **639 workspace tests, including 561 runner tests**, zero failures, generated/packed schema parity, public exports, TypeScript compilation of public custom adapters and all independent packed consumers. Those consumers covered conversation controls, session observations, scoped content, owned file inputs, prompt context, no-model policy transitions, approval/reload/resume, production MCP form continuation, MCP detachment and startup closure/replay. The final gate includes shutdown/startup race coverage and legacy-string/explicit-role instruction compatibility. The first integrated gate caught a public-example type error; the example now explicitly rejects unsupported legacy string instructions before storing role-based instructions, and the complete gate was rerun successfully.

Fresh installed-provider checks on the merged native code also passed: selected MCP lifecycle checks for Codex (7), Claude (11, including detachment) and OpenCode Go (7); Claude idle policy changes preserving the selected MCP catalog (10); and Claude successive native tool-round correlation (6). These are scoped checks, not proof of offline recovery or full T3 parity. Native logs remain private local validation aids, not repository inputs.

For future source changes, run `npm run release:check` again before pushing. It builds, checks schema/package parity, runs workspace tests and verifies packed public consumers. New native changes require focused installed-provider acceptance in addition to fixtures. Re-run the complete gate after source changes that invalidate it; documentation-only updates do not require repeating unchanged native tests.

Installed native acceptance environment used Ubuntu/WSL, Node 22.23.3, Codex 0.160.0, Claude Code 2.1.289 with Agent SDK 0.3.267, and OpenCode 1.18.34 with Go model `opencode-go/glm-5.3-flash`. These are measured versions, not universal compatibility claims. Authentication was supplied by the user. Never put credentials, raw auth/config, unrestricted native errors or provider output into Git or handoff logs.

Useful opt-in scripts (all require `HCP_NATIVE_LIVE=1`):

- `scripts/check-native-live.mjs`, `check-native-interactions-live.mjs`, `check-empty-conversation-live.mjs`: native controls, interactions and no-model startup.
- `scripts/check-native-work-live.mjs`: provider selected by `HCP_LIVE_PROVIDER`; optional `HCP_LIVE_CHILD_HISTORY=1`, `HCP_LIVE_SETTINGS=1`, and Claude `HCP_LIVE_ASYNC_OUTPUT=1` exercise corresponding slices.
- `scripts/check-codex-work-interactions-live.mjs`, `check-codex-background-commands-live.mjs`: Codex background callbacks/commands.
- `scripts/check-input-files-live.mjs`, `check-prompt-context-live.mjs`: owned inputs and handoffs.
- `scripts/check-native-mcp-live.mjs`: `HCP_LIVE_PROVIDERS=codex,claude,opencode`; Claude `HCP_LIVE_DETACH=1` exercises removal.
- `scripts/check-idle-transition-live.mjs`: `HCP_LIVE_PROVIDER=codex|claude|opencode`; Claude `HCP_LIVE_MCP=1` exercises retained selection through policy changes.
- `scripts/check-claude-elicitation-live.mjs`, `check-claude-multistep-live.mjs`, `check-claude-child-mcp-live.mjs`: production form callbacks, successive tool-round correlation and owned child MCP proof.

Scripts use controlled local fixtures and private acceptance workspaces. Do not run them against a user's application data directory. Native feedback tests use fixtures; a real report with diagnostics needs explicit user authorization. Verify each script's flags and discovery output before reusing it on a different environment.

Local source locations used during development were sibling directories `hcp-review`, `t3code` and the Prompt2Agent checkout beneath `C:/Users/qazis/OneDrive/Documents/p2a`. Linux validation caches were `/home/qazisaad/.cache/hcp-migration-validation` and `/home/qazisaad/.cache/t3-hcp-validation`; they are optional local aids, not repository dependencies or guaranteed credentials. The temporary planning/comparison documents live outside Git. This tracked handoff is the portable starting point for the next agent.

## Non-negotiable evidence rules

- Root completion, session closure, native work terminal state and callback settlement are separate facts.
- Match the exact admitted native identity; reused message IDs keep their original owners. Admission alone cannot establish an unstamped Claude reply lane.
- Native ACK/requested values cannot substitute for effective settings, history identity or closure proof.
- Unknown mutation outcomes remain fenced; no automatic replay, quarantine bypass or fabricated successful receipt.
- Session-scoped observations stay session-scoped when native data lacks a root/child correlation.
- Binding changes require their own supported authorized control; never weaken the base binding as a shortcut.
- Successful fixtures, successful native checks and supported capabilities are different evidence. State their scope precisely.
- No T3-specific public protocol logic. No claim that all seven migration areas or the T3 swap are complete.
