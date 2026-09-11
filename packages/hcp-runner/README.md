# @harness-control/runner

Local runner for Harness Control Protocol, with Codex, Claude Code, OpenCode, and mock adapters. Requires Node.js 22+ and an HCP-compatible application/control plane. Install and authenticate the coding agents you intend to use locally.

```sh
npm install --global @harness-control/runner
hcp-runner version
hcp-runner connect https://your-app.example/hcp/runner
```

Choose which detected agents to enable in the terminal, then approve this computer in the browser that opens. HCP saves its configuration and starts the connection. Keep the terminal open; run the same command to reconnect. Add existing project folders from your app after connecting.

Use your application's actual runner URL. Guided setup allows folder registration under the local filesystem root (the home drive on Windows), but adds no folders automatically. Custom roots and provider settings can be changed in the printed configuration path. Existing settings are preserved on reconnect. Credentials stay in the local credentials file; do not commit it. The runner connects outward, so the local machine needs no inbound port.

`connect` stores endpoint-specific configuration under `~/.hcp-runner/connections/`. Use `--config <path>` for an existing installation, `--providers codex,claude` for explicit noninteractive selection, `--no-browser` to open the printed link manually, or `--pair` to replace revoked credentials. Run `codex login` or `claude auth login` locally if needed, then restart HCP. The lower-level `pair --out runner.json` and `run --config runner.json` commands remain available for custom integrations.

For embedding, public modules are available at `/connection`, `/config`, `/harnesses`, `/mcp`, `/state`, and `/pairing`. Importing the package does not start a runner. See [configuration and examples](https://github.com/qazisaad/harness-control-protocol#runner-configuration), [workspace management](https://github.com/qazisaad/harness-control-protocol/blob/main/docs/workspace-management.md), and [provider support](https://github.com/qazisaad/harness-control-protocol/blob/main/docs/native-providers.md).

Capabilities vary by provider. In particular, the current Claude adapter does not implement filesystem containment; an app requesting restricted execution must reject that combination instead of widening policy.
