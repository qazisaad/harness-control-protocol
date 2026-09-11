# @harness-control/runner

Local runner for Harness Control Protocol, with Codex, Claude Code, OpenCode, and mock adapters. Requires Node.js 22+ and an HCP-compatible application/control plane. Install and authenticate the coding agents you intend to use locally.

```sh
npm install --global @harness-control/runner
hcp-runner version
hcp-runner pair https://your-app.example/hcp/runner --out runner.json
```

Open the approval URL printed by the CLI. Once approved, configure `provider_instances`, `workspaces`, and optionally `workspace_management.allowed_roots` in `runner.json`, then:

```sh
hcp-runner run --config runner.json
```

Use your application's actual runner URL. Pairing does not automatically configure coding agents or authorize folders. Credentials stay in the local credentials file; do not commit it. The runner connects outward, so the local machine needs no inbound port.

For embedding, public modules are available at `/connection`, `/config`, `/harnesses`, `/mcp`, `/state`, and `/pairing`. Importing the package does not start a runner. See [configuration and examples](https://github.com/qazisaad/harness-control-protocol#runner-configuration), [workspace management](https://github.com/qazisaad/harness-control-protocol/blob/main/docs/workspace-management.md), and [provider support](https://github.com/qazisaad/harness-control-protocol/blob/main/docs/native-providers.md).

Capabilities vary by provider. In particular, the current Claude adapter does not implement filesystem containment; an app requesting restricted execution must reject that combination instead of widening policy.
