# Harness Control Protocol (HCP)

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178c6.svg)](https://www.typescriptlang.org/)
[![Protocol](https://img.shields.io/badge/protocol-hcp.v0-orange.svg)](packages/hcp-protocol)

Open-source protocol and local runner for connecting hosted harnesses to local developer tools.

HCP connects hosted apps, workflow systems, and local coding-agent harnesses through an outbound WebSocket connection. The control plane can start sessions, send turns, attach short-lived MCP servers, and receive normalized runtime events without requiring inbound network access to the user's machine.

This repository contains the protocol package, runner implementation, MCP attachment layer, local capability engine, mock control plane, sample MCP server, examples, and architecture docs needed to build and test HCP integrations.

## Project Status

Harness Control Protocol is an early, pre-1.0 foundation. The protocol and runner core are implemented and covered by tests, but production harness adapters and hosted control-plane integration are still being built.

Implemented today:

- HCP v0 envelopes, message schemas, event types, local action contracts, and parser helpers.
- Public JSON Schema export, conformance fixtures, and a conformance CLI.
- Runner CLI commands for `version`, `pair`, and `run`.
- Reference pairing with single-use pairing codes, local credential storage, and short-lived connection tokens.
- Outbound WebSocket lifecycle with hello, accept/reject, heartbeat, reconnect, replay, and capability snapshots.
- Control-plane command handling with ACK/NACK responses and duplicate-command idempotency.
- Adapter-based session lifecycle with deterministic mock, Codex, and Claude Code adapters.
- Local capability leases and real filesystem, Git, shell, and dev-server executors.
- MCP Streamable HTTP attachment client using the official Model Context Protocol TypeScript SDK.
- Attachment policy for allowed/denied tools, expiry checks, proof-bound requests, redaction, and close-on-session-end.
- Sample Streamable HTTP MCP server with server-side proof verification.
- Mock control plane and end-to-end example for local development and integration testing.
- Codex and Claude Code live-smoke examples that advertise real local provider readiness, validate proxied MCP setup, and run one real provider turn when local CLI config and auth are valid.
- Browser quickstart demo for local action onboarding, Codex/Claude prompt checks, and sample Streamable HTTP MCP attachment setup.

Next major work:

- Richer provider-native event normalization.
- Published packages and release automation.
- Contributor docs, security-reporting process, and compatibility matrix.

## Why HCP Exists

Most hosted automation products need a safe way to use a developer's local environment: source code, Git state, provider credentials, local tools, and running dev servers. Opening inbound ports or copying long-lived credentials into a hosted service is a poor default.

HCP uses a local runner instead:

```mermaid
flowchart LR
  App["Hosted app or workflow"] --> CP["HCP control plane"]
  Runner["Local HCP runner"] --> CP
  Runner --> Workspace["Local workspace"]
  Runner --> Provider["Coding-agent harness"]
  Runner --> MCP["Temporary MCP servers"]
  Provider --> Workspace
```

The runner is the local trust boundary. It advertises what is available, accepts only policy-bound commands, launches local harness sessions, attaches temporary MCP tools, and streams normalized events back to the control plane.

## Repository Layout

| Path | Purpose |
| --- | --- |
| `packages/hcp-protocol` | Public TypeScript types, Zod schemas, HCP message envelopes, and parser helpers. |
| `packages/hcp-runner` | Local runner CLI, connection lifecycle, config loading, session management, MCP attachment client, and local action policies. |
| `apps/mock-control-plane` | Local WebSocket control plane for development, tests, and third-party validation. |
| `apps/sample-mcp-server` | Streamable HTTP MCP server that verifies HCP proof-of-possession headers. |
| `demo/quickstart` | Browser-based quickstart control plane for local actions, provider turns, and sample MCP attachment flow. |
| `examples/basic-runner-flow.ts` | Standalone reference flow from pairing through session turn and cleanup. |
| `examples/codex-runner-flow.ts` | Live-smoke reference flow for local Codex CLI readiness, proxied MCP setup, and one Codex turn. |
| `examples/claude-runner-flow.ts` | Live-smoke reference flow for local Claude Code readiness, proxied MCP setup, and one Claude Code turn. |
| `docs/architecture.md` | Architecture boundary and MCP SDK responsibility split. |
| `docs/license-decision.md` | Apache-2.0 licensing rationale. |

## Quick Start

Prerequisites:

- Node.js 20 or newer.
- npm 10 or newer.

Clone and validate the project:

```bash
git clone https://github.com/qazisaad/harness-control-protocol.git
cd harness-control-protocol
npm install
npm run check
npm test
npm run build
```

Run the browser quickstart demo:

```bash
npm run demo:quickstart
```

Open the printed URL, usually `http://127.0.0.1:8790`.

![HCP quickstart console](demo/quickstart/assets/quickstart.png)

The browser console starts a local demo control plane and a local HCP runner, then sends real HCP messages across the runner/control-plane WebSocket. It includes buttons for README read, Git status, a hardcoded safe Node shell command, and dev-server start/stop.

Codex and Claude Code appear in the provider list when configured by the demo runner. If the local CLI is installed and authenticated, the prompt panel can send a real `harness.turn.send` to that provider. If a CLI is missing or unauthenticated, the demo reports the provider as unavailable and does not fake a response.

The MCP panel starts the sample Streamable HTTP MCP server and attaches it through HCP. For Codex and Claude Code sessions, the runner creates a session-owned loopback proxy and passes process-local MCP config to the provider. On machines without a ready provider CLI, the mock provider still validates the proof-bound Streamable HTTP client path.

Start the mock control plane in one terminal:

```bash
npm run dev:mock -- --host 127.0.0.1 --port 8787
```

Create a paired local runner config and connect the runner in another terminal:

```bash
npm run dev:runner -- pair http://127.0.0.1:8787 \
  --runner-id local-runner \
  --host-id local-host \
  --out ./runner.local.json

npm run dev:runner -- run --config ./runner.local.json
```

The `pair` command accepts `http`, `https`, `ws`, or `wss` control-plane URLs. With the mock control plane it requests a single-use pairing code, exchanges it for a runner credential, stores credentials separately, and writes a runner config with a normalized WebSocket URL.

For tests that only need a config file and no reference credential exchange, pass `--offline`.

Run the standalone example:

```bash
npx tsx examples/basic-runner-flow.ts
```

Run the Codex live-smoke reference flow:

```bash
npx tsx examples/codex-runner-flow.ts
```

This flow pairs with the mock control plane, connects a local runner, probes the configured Codex provider, and starts a real Codex turn only when `codex --version` and `codex login status` succeed. The example uses runner-local `launch_args` to pass a process-scoped `service_tier=fast` override for current Codex CLI compatibility; it does not edit `~/.codex/config.toml`. The live turn uses HCP `approval_policy: "full_access"` so `codex exec` can run non-interactively while the sandbox remains `workspace_write`. If Codex is unavailable or unauthenticated, the example prints the provider snapshot and exits without sending a turn.

Run the Claude Code live-smoke reference flow:

```bash
npx tsx examples/claude-runner-flow.ts
```

This flow pairs with the mock control plane, connects a local runner, probes the configured Claude Code provider, validates proxied MCP setup, and starts a real Claude Code turn only when `claude --version` and `claude auth status --json` succeed. The live turn uses `claude -p --output-format json --no-session-persistence` with HCP `approval_policy: "full_access"` so the provider can run non-interactively without creating a persisted Claude session.

Run the public protocol conformance fixtures:

```bash
npm run conformance --workspace @hcp-runner/protocol
```

## Runner Configuration

A runner config describes the local host, allowed workspaces, provider instances, and local capabilities that may be advertised to the control plane.

```json
{
  "runner_id": "local-runner",
  "host_id": "local-host",
  "control_plane_url": "ws://127.0.0.1:8787/",
  "workspaces": [
    {
      "id": "app",
      "path": "/absolute/path/to/workspace",
      "git_remote": "git@github.com:example/app.git"
    }
  ],
  "provider_instances": [
    {
      "id": "codex-local",
      "driver_kind": "codex",
      "display_name": "Codex Local",
      "enabled": true,
      "models": [
        {
          "id": "gpt-5.5",
          "label": "GPT-5.5",
          "is_default": true,
          "capabilities": {
            "option_descriptors": []
          }
        }
      ],
      "local_capabilities": ["filesystem", "git", "shell", "dev_server"]
    }
  ],
  "local_capabilities": [
    {
      "id": "filesystem",
      "status": "available",
      "scopes": ["workspace_read", "workspace_write"],
      "approval_required": false
    },
    {
      "id": "git",
      "status": "available",
      "scopes": ["workspace_read", "workspace_write"],
      "approval_required": false
    },
    {
      "id": "shell",
      "status": "available",
      "scopes": ["workspace"],
      "approval_required": true
    },
    {
      "id": "dev_server",
      "status": "available",
      "scopes": ["workspace"],
      "approval_required": true
    }
  ]
}
```

Provider executable paths, home directories, launch arguments, and persistent environment variables stay in the local runner config. They are not sent to the control plane as part of capability snapshots.

## Protocol Model

HCP messages are JSON envelopes with an id, type, protocol version, timestamp, payload, and optional metadata.

Core message families:

- Host lifecycle: `host.hello`, `host.accepted`, `host.rejected`, `host.heartbeat`, `host.capabilities.updated`.
- Control-plane commands: `harness.session.start`, `harness.turn.send`, `harness.turn.cancel`, `harness.session.stop`, `harness.approval.respond`, `harness.input.respond`, `tool_servers.detach`.
- Command results: `hcp.command.ack`, `hcp.command.nack`.
- Runtime events: `harness.event` with known event types such as `session.started`, `turn.completed`, `mcp_tool.started`, and `local_capability.action.failed`.

The protocol package exposes both TypeScript types and runtime schemas so control planes, runners, and tests can validate the same contract.

## MCP Attachments

HCP can attach temporary MCP servers to a workflow-launched harness session. Runner-side MCP support is intentionally wrapped behind `McpAttachmentClient` so the official SDK handles protocol mechanics while runner-owned policy remains local.

The runner enforces:

- Streamable HTTP transport validation.
- Attachment expiry.
- Proof-bound request headers.
- Allowed and denied tool lists.
- Redaction of headers, arguments, outputs, and errors before logging.
- Event emission for connection, discovery, tool calls, denial, and failure.
- Client close and cleanup when the harness session ends.

For Codex and Claude Code sessions, the runner creates a session-owned loopback MCP proxy for each attachment. The proxy talks to the platform MCP server through `McpAttachmentClient`, injects the required proof-of-possession headers, and exposes a local `http://127.0.0.1:<port>/mcp` endpoint to the provider CLI through process-local config overlays. Codex receives `-c mcp_servers.<name>.url=...`; Claude Code receives `--mcp-config ... --strict-mcp-config`. The adapters reject unproxied MCP attachments, so platform URLs and bearer/proof headers are not passed directly to provider CLIs and permanent user config is not mutated.

HCP does not currently accept backend-supplied `stdio` MCP attachments. Payloads with `transport: "stdio"`, `command`, or `args` are rejected by protocol validation. The recommended future design is local runner-owned named stdio MCP profiles that a control plane can reference without supplying executable config. See [MCP Stdio And Cursor](docs/mcp-stdio-and-cursor.md).

## Local Capability Leases

Local capabilities are short-lived grants minted by the control plane and enforced by the runner. A lease is bound to a session, host, provider instance, and workspace.

Local machine actions are HCP-native protocol contracts, not MCP tool calls. The protocol package defines `local.action.request`, `local.action.response`, and `local.action.error` envelopes for filesystem read/list/write/patch, Git status/diff, shell exec, and dev-server start/stop. The runner handles inbound `local.action.request` messages over the control-plane WebSocket and returns protocol-valid `local.action.response` or `local.action.error` messages. Each request binds session and turn attribution, lease identity, sandbox requirements, output limits, cancellation behavior, approval action hashes when required, and the expected local capability audit event mapping.

The runner validates:

- Lease expiry and revocation.
- Session, host, provider, and workspace binding.
- Requested scopes against configured runner capabilities.
- Provider support for each capability.
- Max-call limits.
- Local action request idempotency by `request_id` and payload hash.
- Protocol output limits and truncation flags for filesystem, Git, and shell outputs.
- Shell command policy including executable allow/deny lists, argument patterns, shell-wrapper permission, timeout, and selected-workspace-only current working directory.
- Workspace containment using real paths so symlink escapes are rejected.

## Development

Useful commands:

| Command | What it does |
| --- | --- |
| `npm run check` | Type-checks every workspace with `tsc -b --pretty false`. |
| `npm test` | Runs all package and app tests. |
| `npm run build` | Builds all TypeScript projects. |
| `npm run demo:quickstart` | Starts the browser quickstart demo on `127.0.0.1:8790` or the next available port. |
| `npm run dev:mock -- --port 8787` | Starts the local mock control plane. |
| `npm run dev:runner -- version` | Prints the runner and protocol versions. |
| `npm run dev:runner -- pair <url>` | Generates a runner config for a control-plane URL. |
| `npm run dev:runner -- run --config <path>` | Connects the runner to a control plane. |

The repo uses npm workspaces:

```bash
npm test --workspace @hcp-runner/protocol
npm test --workspace @hcp-runner/runner
npm test --workspace @hcp-runner/mock-control-plane
npm test --workspace @hcp-runner/quickstart-demo
```

## Security Posture

HCP treats the local machine as the sensitive boundary.

- The runner connects outbound; it does not require inbound network access.
- Provider paths, homes, launch args, and persistent environment remain runner-local.
- Workspaces must be explicitly configured when workspace restrictions are enabled.
- Local actions require leases and are checked again at action time.
- MCP tools are attached per session and closed at session end.
- Tool arguments, outputs, request headers, and errors are redacted before event logging.
- The sample MCP server rejects invalid proof signatures, nonce reuse, stale timestamps, host/session/provider/workspace/server binding mismatches, revoked leases, and unselected tools.

This project does not yet include a formal `SECURITY.md`. Until that exists, avoid publishing exploit details in public issues; open a minimal issue requesting a private maintainer contact path.

## Contributing

Contributions are welcome while the project is still taking shape. The most useful contributions right now are small, focused pull requests that improve one of the core contracts:

- Protocol schema clarity and test coverage.
- Runner lifecycle behavior.
- MCP attachment policy and compatibility.
- Local capability lease enforcement.
- Mock control-plane developer experience.
- Architecture docs and examples.

Before opening a larger change, start with an issue describing the use case and the protocol surface it needs.

## License

Harness Control Protocol is licensed under the [Apache License 2.0](LICENSE). The license was chosen because this project is intended to be adopted by applications, companies, and open-source infrastructure while preserving a clear patent grant.
