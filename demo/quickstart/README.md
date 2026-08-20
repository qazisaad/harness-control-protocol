# HCP Quickstart Demo

The quickstart demo is a browser-based control plane that starts a local HCP runner in the same Node process and talks to it over the real HCP WebSocket boundary.

```text
Browser console
  -> demo web control plane
  -> HCP WebSocket message
  -> local runner dispatcher or harness adapter
  -> HCP response/event
  -> browser event stream
```

Run it from the repository root:

```bash
npm run demo:quickstart
```

Open the printed URL, usually `http://127.0.0.1:8790`.

![HCP quickstart console](assets/quickstart.png)

## What It Exercises

- `harness.session.start` for a local mock harness session.
- `local.action.request` and `local.action.response` for README read, Git status, a hardcoded safe Node command, and dev-server start/stop.
- Provider readiness snapshots for mock, Codex, Claude Code, and OpenCode.
- Real `harness.turn.send` to Codex, Claude Code, or OpenCode when the local CLI is ready.
- Streamable HTTP MCP attachment setup with the sample MCP server.
- Runner-owned named stdio profile setup with the sample MCP server.
- Runner-owned loopback MCP proxy setup for Codex, Claude Code, and OpenCode sessions when those providers are selected and available.

## Provider Behavior

The demo probes provider readiness through the runner capability snapshot. If `codex`, `claude`, or `opencode` is unavailable, the UI shows that state and API calls return a clear error instead of a fake provider response.

The deterministic mock provider is always available and is used for local actions. It can also validate both MCP transports without a ready provider CLI.

## Configuration

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `HCP_QUICKSTART_HOST` | `127.0.0.1` | Demo HTTP and HCP WebSocket host. |
| `HCP_QUICKSTART_PORT` | `8790` | Initial demo port. If occupied, the demo searches the next few ports. |
| `HCP_QUICKSTART_WORKSPACE` | repository root | Workspace exposed to the local runner. |

The demo does not edit permanent Codex, Claude, MCP, Git, or shell configuration. Provider MCP config is process-local for the CLI turn.

## Current Boundary

Supported in this demo:

- HCP-native local actions.
- Real local Codex, Claude Code, and OpenCode turns when the local CLI is ready.
- Streamable HTTP MCP attachments with runner proof headers.
- Runner-owned named stdio profiles whose executable config never comes from the browser or control plane.
- Runner-owned loopback MCP proxying for provider sessions.

Not supported:

- Backend-supplied raw `stdio` MCP commands.
- Browser-controlled arbitrary executable command/args.
- First-class Cursor adapter or export flow.
