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
- enforce `allowed_tools` and `denied_tools`
- attach MCP servers only to workflow-launched harness sessions
- redact inputs, outputs, and headers before logging
- emit HCP MCP events
- close clients and remove temporary config at session end
- rely on the control plane for lease minting and revocation decisions

The SDK should sit behind a small runner-owned wrapper so SDK version changes do not leak into harness adapters.

The sample MCP server uses the official SDK server transport and verifies HCP proof headers before handing requests to the SDK transport. It is a reference path for local tests, not a production authorization service.
