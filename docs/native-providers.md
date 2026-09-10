# Native provider support

The runner uses Codex app-server over local stdio and Claude Agent SDK `0.3.267`. This replaces completion-only CLI output parsing. HCP still owns command receipts, session events, replay, and snapshots; provider runtimes own native execution. An ACP bridge is not included.

## Supported contract

| Behavior | Codex | Claude |
| --- | --- | --- |
| Execution | Fresh ephemeral native thread per turn | Fresh SDK query per turn, persistence disabled |
| Text/reasoning streaming | Native delta notifications | SDK partial messages |
| Tool activity | Native item lifecycle | Tool-use/result item lifecycle |
| Final output | Successful native terminal plus final assistant item required | Successful typed result required; limits/API errors never become success |
| Usage | Native thread token totals for the fresh turn | SDK model totals, including cached input; reported cost is an estimate |
| Sandbox | `read_only`, `workspace_write`, `danger_full_access` | Explicit `danger_full_access` only |
| Approval policy | `full_access`, mapped to native `never` | `full_access`, mapped to `bypassPermissions` |
| Model options | `reasoningEffort` forwarded to native `effort`; native catalog supplies choices | `effort` forwarded to SDK |
| Continuation / interactive approvals / input | Unsupported | Unsupported |

`full_access` describes approval behavior, not filesystem access. Codex workspace-write checks the returned policy and rejects extra writable roots or implicit temporary-directory writes. Claude restricted modes fail before provider execution; SDK permission modes are not treated as filesystem containment.

Provider snapshots include optional `execution_capabilities`: `streaming`, `multi_turn`, `session_continuation`, `sandbox_modes`, and `approval_policies`. The same adapter contract advertises and validates these values. An omitted capability object means unknown support, not permission to assume support. `continuation_group_key` is an identity grouping, not a continuation guarantee. This pre-release schema addition requires matching runner/client builds; regenerate JSON Schema from source and pin the tested build.

Each session accepts one turn. A second turn is rejected before provider execution rather than silently starting a fresh conversation.

Native drivers reject nonempty `launch_args`, unsupported/duplicate model options, and continuation requests. Use provider `executable_path`, `home`, `env`, and structured model selection. Host-local executable/environment configuration remains trusted configuration, not a remote escape hatch. Unknown provider-native optional notifications are ignored; unexpected interactive native requests fail the turn. HCP approval/input responses and live tool-server detach receive NACK instead of success for a no-op.

## MCP and configuration

Codex reads effective MCP configuration and disables inherited servers using configuration overrides; it does not copy serialized config values or modify the user's config file. Selected names cannot collide with inherited names. Before the prompt, it checks the thread MCP inventory: unselected servers must be explicitly disabled and expose no tools. Missing inventory support or unverifiable scope fails closed.

Claude uses `strictMcpConfig: true` even with zero attachments and `settingSources: []`. User/project/local settings, hooks, and settings-dependent customizations are intentionally not loaded into this execution profile. The Claude Code system-prompt preset is used. Interactive question/plan tools and child-agent tools are disabled in this first profile. Codex multi-agent and apps integration are disabled for this profile.

Both runtimes receive only runner-loopback MCP proxies. Platform proof credentials stay in the runner. `CODEX_HOME` and `CLAUDE_CONFIG_DIR` retain provider-instance authentication scope; a connection token is not provider authentication.

## Lifecycle and validation

One shared owner decides the terminal outcome after runtime cleanup. Cancellation/stop aborts the owned runtime, terminates the process group, escalates if needed, and waits for actual close. Sending SIGKILL is not itself proof of closure. The running turn publishes its single terminal event before a waiting cancel/stop operation resolves. Unexpected process loss, malformed output, provider limits, and timeouts fail the turn; they never restart it automatically.

Diagnostic CLI capture remains bounded at 64 KiB. Structured turn traffic does not use that capture buffer. Codex decodes split UTF-8 frames and rejects oversized protocol frames at 8 MiB rather than silently truncating JSON. Claude streaming is parsed by the SDK. No durable provider continuation, crash reattachment, or independently detached/background-work recovery is claimed.

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

Live smoke examples use the local mock control plane and existing provider authentication. They prove real streamed turns through WebSocket/session handling and terminal cleanup, plus MCP proxy setup; they do not prove a provider-issued MCP tool call or production pairing. Browser-approved hosted pairing and production proof-secret provisioning remain separate work.

The Codex policy smoke uses temporary files to check workspace writes, outside/symlink denials, and read-only behavior. It also invokes the native command sandbox directly so model refusal alone cannot pass the read-only enforcement check.

## Verification record

On 2026-09-10, TypeScript checking and all 144 automated tests passed. Local smoke runs used Codex CLI `0.153.4` and Claude Code `2.1.220` with Agent SDK `0.3.267`. Both local control-plane flows reached `turn.completed` and session shutdown; the Codex policy smoke verified allowed workspace writes and denied outside, escaping-symlink, and read-only writes. These results certify the named local scenarios, not other operating systems or provider versions.

The dependency audit reports three pre-existing findings: `fast-uri` (high), `hono` and `qs` (moderate). Their locked versions were unchanged by this update. Dependency remediation is not claimed by these adapter changes.
