# Native provider support

The runner uses Codex app-server over local stdio and Claude Agent SDK `0.3.267`. This replaces completion-only CLI output parsing. HCP still owns command receipts, session events, replay, and snapshots; provider runtimes own native execution. An ACP bridge is not included.

## Supported contract

This table describes the current source implementation. The verification record below describes historical live runs; it does not certify every current operation or installed provider version.

| Behavior | Codex | Claude | OpenCode |
| --- | --- | --- | --- |
| Execution | Persistent native thread; a process starts/resumes it for each turn | Fresh SDK query, persistence disabled | 1.x HTTP/SSE server and native session |
| Text/reasoning streaming | Native delta notifications | SDK partial messages | Text/reasoning SSE deltas |
| Tool activity | Items, commands/output, file changes, plan/diff updates | Tool-use/result item lifecycle | Rich tool normalization not implemented |
| Final output | Successful native terminal plus final assistant item required | Successful typed result required | Message response plus session-idle event |
| Usage | Native thread token totals; not necessarily per-turn usage after resume | SDK model totals, including cached input; estimated cost | Not normalized |
| Sandbox | `read_only`, `workspace_write`, `danger_full_access` | `danger_full_access` only | `danger_full_access` only; no filesystem containment |
| Approval policy | `ask` -> `untrusted`, `auto_edits` -> `on-request`, `full_access` -> `never` | `full_access` -> `bypassPermissions` | `full_access` only, explicit session allow rules |
| Model options | `reasoningEffort`; native model catalog | SDK `effort` | `provider/model` identifier; nonempty options rejected |
| Multi-turn and durable continuation | Supported through the retained native binding | Unsupported; one turn per session | Multiple live turns; durable continuation unsupported |
| Native interactions | Command/file approvals and blocking structured questions; accept/decline/cancel only | Unsupported | Unsupported; question/task tools denied in this profile |
| Plan mode and images | Supported | Unsupported | Unsupported and rejected |
| Native history and conversation rollback | Read/rollback/retire; rollback never restores files | Unsupported | Unsupported |

`full_access` describes approval behavior, not filesystem access. Codex workspace-write checks the returned policy and rejects extra writable roots or implicit temporary-directory writes. Claude restricted modes fail before provider execution; SDK permission modes are not treated as filesystem containment.

Provider snapshots include optional `execution_capabilities`: streaming, multi-turn, continuation, Plan mode, history/rollback and supported policies. An omitted capability object means unknown support. Model descriptors separately advertise image input. Use the advertised contract, not the presence of a field or command in the protocol, to authorize execution.

Codex continuation requires an explicit durable `continuation_group_key` and the original provider/workspace/tool/policy binding. It does not replay earlier prompts. Claude rejects a second turn; OpenCode retains only its active native session and rejects durable continuation.

Codex/Claude reject nonempty `launch_args` and unsupported/duplicate model options. Host-local executable/environment configuration remains trusted configuration, not a remote escape hatch. Codex routes supported native approval/input replies through the owning request; unhandled native requests fail honestly. Live tool-server detach remains unsupported.

OpenCode probe and launch reject unknown/non-1.x versions rather than interpreting a different runtime as 1.x. Restricted sandboxes, interactive approval policies, Plan mode, images, durable continuation and model options are rejected before dispatch. Its unrestricted profile does not isolate inherited native hooks/configuration/MCP inventory; do not use it where that isolation is required. Version gating and session permission requests have automated fixture coverage, not new live-provider certification. See the native [permission semantics](https://opencode.ai/docs/permissions/) and the separate [v2 contract](https://opencode.ai/v2/docs/permissions).

## MCP and configuration

Codex reads effective MCP configuration and disables inherited servers using configuration overrides; it does not copy serialized config values or modify the user's config file. Selected names cannot collide with inherited names. Before the prompt, it checks the thread MCP inventory: unselected servers must be explicitly disabled and expose no tools. Missing inventory support or unverifiable scope fails closed.

Codex uses runner-authorized dynamic tools for the selected MCP attachments. Native tool calls pass through the runner's review/continuation owner. The native MCP inventory must remain disabled; a native approval does not grant application MCP authority.

Claude uses `strictMcpConfig: true` and `settingSources: []`. User/project/local settings, hooks and settings-dependent customizations are not loaded in this profile. The Claude Code system-prompt preset is used; question/plan and child-agent tools are disabled. Codex apps, plugins and multi-agent integration remain disabled. Broader interactive profiles are future work, not implied by multi-turn support.

Claude receives runner-loopback MCP proxies; Codex uses the runner tool bridge. Platform proof credentials stay in the runner. `CODEX_HOME` and `CLAUDE_CONFIG_DIR` retain provider-instance authentication scope; a connection token is not provider authentication.

## Lifecycle and validation

Codex and Claude use a shared owner to decide the terminal outcome after runtime cleanup. Cancellation/stop aborts the owned runtime, terminates the process group, escalates if needed, and waits for actual close. Sending SIGKILL is not itself proof of closure. The running turn publishes its single terminal event before a waiting cancel/stop operation resolves. Unexpected process loss, malformed output, provider limits, and timeouts fail the turn; they never restart it automatically. OpenCode has its own HTTP abort/server-stop path; equivalent process-closure guarantees still need separate validation.

Diagnostic CLI capture remains bounded at 64 KiB. Codex decodes split UTF-8 frames and rejects oversized protocol frames at 8 MiB. Command/change/plan/diff projections are separately bounded and can contain explicit summaries; full-content retrieval remains future work. Claude streaming is parsed by the SDK. Codex retains native conversation bindings, but does not recover a lost live native callback or independently detached/background work. Transport replay does not recreate a provider process.

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
