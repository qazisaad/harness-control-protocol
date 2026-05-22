# HCP Runner

Open-source local runner for the Harness Control Protocol (HCP).

HCP connects hosted apps and workflow systems to local coding-agent harnesses such as Codex and Claude Code without requiring inbound network access to the user's machine.

## Goals

- Run as a local process on an execution host.
- Connect outbound to an HCP control plane over WebSocket.
- Advertise local provider instances, workspaces, and capabilities.
- Launch harness sessions with temporary MCP attachments.
- Stream normalized harness events back to the control plane.
- Keep provider executable paths, homes, launch args, and persistent environment local to the runner.

## Initial Shape

This repo contains the public protocol, runner implementation, mock control plane, examples, and docs needed for apps to adopt HCP.

Planned layout:

```text
packages/hcp-protocol/
packages/hcp-runner/
apps/mock-control-plane/
examples/
docs/
```

## Current Status

Planning/scaffold only.
