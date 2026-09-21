# Architecture

## Repositories

The runner is intentionally structured as a standalone public project.

- `packages/hcp-protocol`: public protocol types and schemas
- `packages/hcp-runner`: local runner CLI and daemon
- `apps/mock-control-plane`: local test control plane for third-party validation
- `apps/sample-mcp-server`: local reference MCP server for proof-of-possession tests
- `examples`: standalone non-P2A flows for local validation

## Boundary

The runner connects outbound to a control plane. The browser and hosted app do not require inbound network access to the user's machine.

Provider executable paths, home directories, launch arguments, and persistent environment variables remain runner-local by default.

This public runner repository intentionally does not implement Agentic Playground product integration. It has no Convex, WorkOS, frontend, workflow queue, or P2A observability dependencies. P2A can consume HCP schemas and events later, but this repo stays usable with any compatible control plane.

## MCP SDK Boundary

The runner should use the official Model Context Protocol TypeScript SDK for MCP protocol mechanics.

SDK responsibilities:

- Streamable HTTP client transport
- MCP client connection lifecycle
- tool discovery
- tool calls
- standard MCP protocol errors
- auth-provider hooks for request credentials
- MCP server primitives for mock servers and examples

Runner responsibilities:

- decide which MCP transports are allowed by HCP policy
- map HCP `McpServerAttachment` records into SDK clients
- resolve runner-owned stdio profile ids into locally configured processes without exposing command configuration
- enforce `allowed_tools` and `denied_tools`
- attach MCP servers only to explicitly configured harness sessions
- redact inputs, outputs, and headers before logging
- emit HCP MCP events
- close clients and remove temporary config at session end
- rely on the control plane for lease minting and revocation decisions

The SDK should sit behind a small runner-owned wrapper so SDK version changes do not leak into harness adapters.

The sample MCP server exposes both proof-bound Streamable HTTP and local stdio entry points using official SDK transports. It is a reference path for local tests, not a production authorization service.

## Reliability Boundary

The runner owns local acceptance, idempotency receipts, per-session event sequencing, retained replay windows, and session event snapshots. The control plane owns the sequence it has durably applied and sends that cursor in `host.accepted`.

The runner does not own product thread/message history or workflow queues. A hosted application persists HCP events through its canonical production reducer and stores its cursor in the same transaction as the resulting projection. See [Reliability And Snapshots](reliability-and-snapshots.md).

## Consumer identity and custom harnesses

Local leases, actions and their events use HCP session, lease, host, provider and workspace identities. Organization, workflow, run and node IDs belong to the consuming application's records, mapped by session or lease ID. They are not fields in the public local capability contract. This keeps one execution identity through retry/replay without requiring a workflow engine. The 0.4.0 release removes those formerly required product fields; callers must omit them.

Custom harness developers import `HarnessAdapter`, its input/output types, `ProviderDriverStatus` and `HarnessAdapterRegistry` from `@harness-control/runner/harnesses`. Supply the registry to `HarnessSessionManager`, then the manager to `RunnerConnection`. See [`examples/custom-harness.ts`](../examples/custom-harness.ts) and [`examples/public-sdk.mjs`](../examples/public-sdk.mjs). The packed release check compiles this adapter outside the monorepo and exercises it through terminal execution, a local capability action, snapshot reduction and session exit.

The `connect` CLI discovers bundled providers. Applications embedding custom adapters configure their provider instances and registry themselves; they do not need to patch the default registry or import private package paths. User-facing product setup instructions belong to the consuming application.
