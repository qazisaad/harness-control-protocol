# MCP Stdio And Cursor

HCP currently supports backend-supplied MCP attachments only when the attachment uses Streamable HTTP:

```json
{
  "name": "sample",
  "transport": "streamable_http",
  "url": "https://example.com/mcp",
  "headers": {
    "Authorization": "Bearer short-lived-token"
  },
  "lease_id": "mcp_lease_123",
  "proof_of_possession": {
    "scheme": "runner_signed_request",
    "key_id": "proof_key_123",
    "required_headers": ["x-hcp-proof-signature", "x-hcp-proof-nonce"]
  }
}
```

The protocol intentionally rejects backend payloads that include `transport: "stdio"`, `command`, `args`, or other executable config fields. A hosted control plane should not be able to push arbitrary local process execution into a developer machine through an MCP attachment.

## What Works Today

```text
Control plane
  -> harness.session.start with streamable_http MCP attachment
  -> local runner validates lease and proof requirements
  -> runner connects to the remote Streamable HTTP MCP server
  -> runner injects proof-of-possession headers on every upstream request
  -> Codex/Claude receive a runner-owned loopback MCP endpoint when needed
```

For Codex and Claude Code, HCP does not pass the platform MCP URL or bearer/proof headers directly to the provider CLI. The runner creates a session-owned loopback proxy such as `http://127.0.0.1:<port>/mcp`, injects proof headers upstream, and passes only process-local MCP config to the provider command.

## What Does Not Work Today

This is not supported:

```json
{
  "name": "unsafe-local-tool",
  "transport": "stdio",
  "command": "node",
  "args": ["server.js"]
}
```

The schema and tests reject that shape. Local filesystem, Git, shell, and dev-server operations are HCP-native local actions, not MCP tool calls.

## Safe Future Stdio Design

A safe `stdio` path should keep executable ownership local:

```text
local runner config defines named stdio MCP profile
  -> control plane references profile id
  -> runner checks local policy and launches the command locally
  -> runner bridges stdio MCP to a loopback/proof-bound HCP-compatible endpoint
  -> provider receives only the runner-owned loopback endpoint
```

The invariant is that command paths, arguments, environment, and working directory policy live in local runner configuration. The control plane can request a named profile, but it cannot supply raw executable config.

## Cursor Status

This repository does not yet implement a first-class Cursor adapter or a validated Cursor MCP export flow.

Cursor-facing work should be treated as a future adapter/export task until it is tested against current Cursor behavior. A safe version would export or register a local MCP endpoint that Cursor can consume without letting a hosted backend supply arbitrary `stdio` command/args.
