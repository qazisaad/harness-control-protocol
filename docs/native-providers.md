# Native provider support

The runner uses Codex app-server over local stdio and Claude Agent SDK `0.3.267`. This replaces completion-only CLI output parsing. HCP still owns command receipts, session events, replay, and snapshots; provider runtimes own native execution. An ACP bridge is not included.

## Supported contract

This table describes the current source implementation. The verification record below describes historical live runs; it does not certify every current operation or installed provider version.

| Behavior | Codex | Claude | OpenCode |
| --- | --- | --- | --- |
| Execution | Persistent native thread; a process starts/resumes it for each turn | Fresh SDK query per turn; retained SDK session | OpenCode 1.3.15+ HTTP/SSE within major version 1 |
| Text/reasoning streaming | Native delta notifications | SDK partial messages | Text/reasoning SSE deltas |
| Tool activity | Items, commands/output, file changes, plan/diff updates | Tool-use/result item lifecycle | Tool arguments/output/errors and todo updates |
| Final output | Successful native terminal plus final assistant item required | Successful typed result required | Message response plus session-idle event |
| Usage | Native conversation token totals, explicitly scoped | SDK turn model totals, including cache counts; estimated cost | Owned root-prompt step totals, with duplicate/order handling and uncertainty |
| Context measurements | Latest native request counters and reported model capacity, separate from conversation totals | Latest root-request counters and compaction post-token counts; no inferred capacity | Final owned prompt response's last-request counters; validated model/variant; no inferred capacity |
| Sandbox | `read_only`, `workspace_write`, `danger_full_access` | `danger_full_access` only | `danger_full_access` only; no filesystem containment |
| Approval policy | `ask` -> `untrusted`, `auto_edits` -> `on-request`, `full_access` -> `never` | `ask` -> `default`, `auto_edits` -> `acceptEdits`, `full_access` -> `bypassPermissions` | Explicit session rules for all three policies |
| Model options | `reasoningEffort`; native model catalog | SDK `effort` | `provider/model` and one string `variant` |
| Multi-turn and durable continuation | Retained native binding | Retained SDK session, including runner recreation | Retained directory-bound session, including runner recreation |
| Native interactions | Command/file approvals and blocking structured questions; accept/decline/cancel | Tool callbacks and blocking structured questions; accept/decline/cancel | Permission replies once/reject; blocking single/multiple-choice questions |
| Plan mode and images | Supported | Supported | Supported |
| Instruction roles | Native system/base and developer | Explicit system prompt | Unsupported |
| Steering | Native `turn/steer`, exact active-turn correlation | SDK input channel, exact active-turn correlation | Unsupported |
| Manual compaction | Native compaction completion | `/compact` plus confirmed native compact boundary | Native summarize completion |
| History, fork and conversation rollback | Read, fork, rollback and runner retirement | SDK history/fork; rollback replaces the logical binding with a verified retained-prefix copy | HTTP history/fork; rollback replaces the logical binding with a verified retained-prefix copy |
| Portable history | Typed messages, reasoning, commands, file changes and optional extensions | Typed messages, reasoning, tool calls/results and optional extensions | Typed messages, reasoning, tool calls/results and optional extensions |
| Large content | Scoped bounded retrieval | Scoped bounded retrieval | Scoped bounded retrieval |

`full_access` describes approval behavior, not filesystem access. Codex workspace-write checks the returned policy and rejects extra writable roots or implicit temporary-directory writes. Claude restricted modes fail before provider execution; SDK permission modes are not treated as filesystem containment.

Provider snapshots include optional `execution_capabilities`: streaming, multi-turn, continuation, Plan mode, history/rollback and supported policies. An omitted capability object means unknown support. Model descriptors separately advertise image input. Use the advertised contract, not the presence of a field or command in the protocol, to authorize execution.

The public adapter interface also has an optional `session_events` observation channel, tested by the independent packaged consumer. It delivers session-bound diagnostics/display extensions between turns through the normal event sequence and replay. Current native drivers do not yet advertise that channel, pending their persistent-runtime and child/background ownership implementations. This hook alone does not enable native children or claim their cancellation.

Usage observations can declare `scope` (`turn` or `conversation`), `status` (`complete` or `partial`) and a provider source. Missing metadata is unknown, not complete turn usage. Input totals include cached and cache-creation input; these components are separately available. Output totals include reasoning tokens where the provider reports them separately. OpenCode counts only assistant steps whose native parent matches the admitted prompt, regardless of event order; duplicate steps do not inflate totals. Conflicting or unresolved observations remain partial. No observed owned steps means no usage claim. These counts do not describe context capacity, account quotas or application billing.

`configuration_inheritance` describes permitted native user/project settings, hooks, inherited MCP servers and plugins separately. Omitted fields mean unknown enforcement. A start command can require specific values; unknown or different enforcement fails before native launch. The runner reports its declared values in `session.configured`. Selected runner-authorized MCP attachments are distinct from inherited MCP servers. Claude disables settings sources and all hooks, requires its requested workspace/permission mode, and verifies the selected MCP and empty plugin inventories. Codex disables inherited MCP/plugins; its other configuration sources are not yet claimed isolated. OpenCode currently permits native configuration inheritance and rejects a request to disable it.

Continuation requires an explicit durable `continuation_group_key` and the original provider/account/workspace/tool/policy binding. It does not replay earlier prompts. Reads support revision-bound pagination. Forks require a fresh session identity and continuation key, an expected history hash, and optionally the last retained turn. Unknown native mutation outcomes fence automatic repetition. Retirement removes the runner association, not provider files.

Every conversation rollback returns `filesystem_undo: false`. Claude/OpenCode preserve their source transcript and create a replacement native conversation containing the verified retained prefix; native IDs can change. Apps coordinate their own filesystem checkpoints. OpenCode copies and verifies the source permission rules on forks rather than relying on native inheritance.

OpenCode also checks retained native permission rules against the original runner-authorized approval policy before resume, history reads, and native forks. Out-of-band permission changes fail instead of silently changing authority. Older retained entries without recorded approval metadata must first resume under their bound start policy before using offline conversation controls.

Codex/Claude reject nonempty `launch_args` and unsupported/duplicate model options. Host-local executable/environment configuration remains trusted configuration, not a remote escape hatch. Codex routes supported native approval/input replies through the owning request; unhandled native requests fail honestly. Live tool-server detach remains unsupported.

OpenCode probe and launch require 1.3.15+ within major version 1; unknown/older/2.x versions fail explicitly. Restricted sandboxes and unknown model options fail before dispatch. Its profile does not yet isolate inherited native hooks/configuration/MCP inventory; it is not eligible where that isolation is required. Native task tools remain denied. Fixtures verify the HTTP/SSE controls, not live-provider certification. See the native [permission semantics](https://opencode.ai/docs/permissions/) and the separate [v2 contract](https://opencode.ai/v2/docs/permissions).

## MCP and configuration

Codex reads effective MCP configuration and disables inherited servers using configuration overrides; it does not copy serialized config values or modify the user's config file. Selected names cannot collide with inherited names. Before the prompt, it checks the thread MCP inventory: unselected servers must be explicitly disabled and expose no tools. Missing inventory support or unverifiable scope fails closed.

Codex uses runner-authorized dynamic tools for the selected MCP attachments. Native tool calls pass through the runner's review/continuation owner. The native MCP inventory must remain disabled; a native approval does not grant application MCP authority.

Claude uses `strictMcpConfig: true` and `settingSources: []`. User/project/local settings, hooks and settings-dependent customizations are not loaded in this profile. The Claude Code system-prompt preset is used; child-agent tools remain disabled. Question/plan tools are enabled for `ask`/`auto_edits` and disabled for the existing `full_access` automation profile. Codex apps, plugins and multi-agent integration remain disabled. Broader interactive profiles are future work, not implied by multi-turn support.

Claude receives runner-loopback MCP proxies; Codex uses the runner tool bridge. Platform proof credentials stay in the runner. `CODEX_HOME` and `CLAUDE_CONFIG_DIR` retain provider-instance authentication scope; a connection token is not provider authentication.

## Lifecycle and validation

Codex, Claude and OpenCode use a shared owner to decide turn termination after runtime cleanup. Cancellation/stop aborts owned work, terminates process groups when required, escalates if needed, and waits for actual close. Sending SIGKILL is not itself proof of closure. The running turn publishes its single terminal event before a waiting cancel/stop resolves. Unexpected process loss, malformed output, provider limits, and timeouts fail honestly; execution is never restarted automatically. OpenCode can retain its server after an acknowledged HTTP turn abort; failed abort closes it.

Diagnostic CLI capture remains bounded at 64 KiB. Codex frames, OpenCode HTTP/SSE responses and Claude history-helper output are bounded at 8 MiB. Stream deltas and history pages are separately bounded. Large output fields carry previews and optional `content_ref`; clients fetch exact bytes with `content` operations in chunks of at most 64 KiB. The default content store retains at most 8 MiB per object, 64 MiB total, 1,024 entries and 24 hours. Expired, evicted or cross-session references fail explicitly. JSON state stores persist content beside the state file. Applications can supply another bounded content store through public runner exports.

These implementations do not recover lost live native callbacks or independently detached/background work. Transport replay does not recreate a provider process. Session remembered permissions, native children/background tasks, broader configuration profiles, full event fidelity and additional T3 provider drivers remain migration gates. This source revision is not a full T3 replacement.

Codex permission-grant requests use the same immutable native-review owner as approvals. The current profile offers turn-scoped grants only. A restricted sandbox never offers acceptance that broadens its containment; rejected requests return an empty native grant. Session-scoped grants require a persistent interactive runtime and remain unavailable.

The fixture suite covers split/large output, native failures and EOF, policy rejection, MCP scope mismatch, option forwarding, cancellation races, and process cleanup. Event transcripts are validated with public schemas and the production reducer, including duplicate replay. Connection tests cover unsupported-command NACKs; session tests reject unimplemented preflight expectations.

Run from this repository root:

```sh
npm run check
npm test
npm run schema:generate --workspace @harness-control/protocol
node --import tsx examples/codex-runner-flow.ts
node --import tsx examples/claude-runner-flow.ts
node --import tsx examples/codex-policy-smoke.ts
```

Live smoke examples use the local mock control plane and existing provider authentication. They prove real streamed turns through WebSocket/session handling and terminal cleanup, plus MCP proxy setup; they do not prove a provider-issued MCP tool call or production pairing. The [approval-gated pairing client](pairing.md) is implemented; hosted approval and proof storage must be verified in the consuming control plane.

The Codex policy smoke uses temporary files to check workspace writes, outside/symlink denials, and read-only behavior. It also invokes the native command sandbox directly so model refusal alone cannot pass the read-only enforcement check.

## Verification record

On 2026-09-10, TypeScript checking and all 144 automated tests passed. Local smoke runs used Codex CLI `0.153.4` and Claude Code `2.1.220` with Agent SDK `0.3.267`. Both local control-plane flows reached `turn.completed` and session shutdown; the Codex policy smoke verified allowed workspace writes and denied outside, escaping-symlink, and read-only writes. These results certify the named local scenarios, not other operating systems or provider versions.

The dependency audit reports three pre-existing findings: `fast-uri` (high), `hono` and `qs` (moderate). Their locked versions were unchanged by this update. Dependency remediation is not claimed by these adapter changes.
