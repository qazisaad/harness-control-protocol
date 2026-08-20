# MCP Stdio And Cursor

HCP supports proof-bound Streamable HTTP attachments and references to runner-owned stdio profiles. A Streamable HTTP attachment is supplied as:

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

## Named Stdio Profiles

```text
Runner config
  -> defines profile id, command, args, environment, workspace-relative cwd, provider bindings, and tool policy
Control plane
  -> requests only { transport: runner_stdio_profile, profile_id: sample-tools }
Runner
  -> resolves the local profile and intersects tool policy
  -> launches stdio MCP inside the selected workspace
  -> bridges it through a session-owned loopback endpoint
Provider
  -> receives only the loopback URL
```

The runner advertises profile ids and policy in `host.capabilities.updated`, but never advertises command, args, environment, or cwd. Codex, Claude Code, and OpenCode all receive the same runner-owned loopback shape.

## Rejected Executable Injection

This is not supported:

```json
{
  "name": "unsafe-local-tool",
  "transport": "stdio",
  "command": "node",
  "args": ["server.js"]
}
```

The schema and conformance tests reject that shape. Local filesystem, Git, shell, and dev-server operations are HCP-native local actions, not MCP tool calls. The invariant is that executable ownership stays local. Profile cwd values must be workspace-relative and resolve inside the selected workspace; optional provider bindings prevent a profile from being used by an unintended provider instance.

## Cursor Status

This repository does not yet implement a first-class Cursor adapter or a validated Cursor MCP export flow.

Cursor-facing work should be treated as a future adapter/export task until it is tested against current Cursor behavior. A safe version would export or register a local MCP endpoint that Cursor can consume without letting a hosted backend supply arbitrary `stdio` command/args.
