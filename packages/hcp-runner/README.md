# @harness-control/runner

Local runner for Harness Control Protocol, with Codex, Claude Code, OpenCode, and mock adapters. Requires Node.js 22+ and an HCP-compatible application/control plane. Install and authenticate the coding agents you intend to use locally.

```sh
npm install --global @harness-control/runner
hcp-runner version
hcp-runner connect https://your-app.example/hcp/runner
```

Choose which detected agents to enable in the terminal, then approve this computer in the browser that opens. HCP saves its configuration and starts the connection. Keep the terminal open; run the same command to reconnect. Add existing project folders from your app after connecting.

Repeating the ordinary `connect` command while HCP is running reports that the original process is still active; it does not start another runner. Check your app for actual connection status. To restart or change setup, press Ctrl+C in the original terminal, wait for it to stop, then repeat the command. After a crash, ownership is recovered automatically while preserving saved setup. An older PID lock whose owner cannot be verified produces a diagnostic instead of deleting files. Both `connect` and `run --config` enforce exclusive ownership; see [runner ownership](https://github.com/qazisaad/harness-control-protocol/blob/main/docs/runner-ownership.md).

Use your application's actual runner URL. Guided setup allows folder registration under the local filesystem root (the home drive on Windows), but adds no folders automatically. Custom roots and provider settings can be changed in the printed configuration path. Existing settings are preserved on reconnect. Credentials stay in the local credentials file; do not commit it. The runner connects outward, so the local machine needs no inbound port.

`connect` stores one installation ID in `~/.hcp-runner/identity.json` and endpoint-specific configuration under `~/.hcp-runner/connections/`. On upgrade it adopts the existing runner ID. The ID survives reconnects, package upgrades, and credential replacement; it is not a hardware fingerprint. Do not copy this directory to another computer.

Use `--config <path>` to adopt an existing configuration on first setup. Its location is remembered, so the standard command reconnects it afterward. A second configuration for the same endpoint is rejected, and only one `connect` process can use that endpoint at a time. Use `--providers codex,claude` for explicit noninteractive selection, `--no-browser` to open the printed link manually, or `--pair` to replace revoked credentials with browser approval. Control planes should match the approved account and runner ID within their environment, rotate credentials on that existing machine record, and preserve its references. Hostnames are labels, not identity.

Run `codex login` or `claude auth login` locally if needed, then restart HCP. The lower-level `pair --out runner.json` and `run --config runner.json` commands remain available for integrations that own their runner identity and configuration lifecycle.

For embedding, public modules are available at `/connection`, `/config`, `/harnesses`, `/mcp`, `/state`, and `/pairing`. Importing the package does not start a runner. See [configuration and examples](https://github.com/qazisaad/harness-control-protocol#runner-configuration), [workspace management](https://github.com/qazisaad/harness-control-protocol/blob/main/docs/workspace-management.md), and [provider support](https://github.com/qazisaad/harness-control-protocol/blob/main/docs/native-providers.md).

Capabilities vary by provider. In particular, the current Claude adapter does not implement filesystem containment; an app requesting restricted execution must reject that combination instead of widening policy.

## Account usage

Account monitoring is independent of sessions and opt-in per provider instance:

```json
{
  "id": "work-codex",
  "driver_kind": "codex",
  "account_usage": { "scope_id": "your-organization-workspace" }
}
```

This is a provider entry inside your existing runner config, not a whole config. `scope_id` is an operator assertion used when the provider does not expose organization identity. Keep it consistent across machines only for the same billing scope. Without scope/subject, identities remain host-local. `home` selects an existing provider home; no login is created or switched.

For Claude, use `driver_kind: "claude"` and explicitly set `account_usage.allow_experimental_claude: true`. The pinned SDK API is experimental; some accounts report quota data unavailable. Missing limits are never presented as zero.

```sh
hcp-runner accounts --config /absolute/path/runner.json
```

Prints one normalized JSON account snapshot without connecting to a control plane or submitting prompts. Exit success means collection completed; individual unavailable observations include reasons. Provider credentials stay local. Configure provider display names without private email addresses because labels are shared.

Applications can import `AccountUsageReader` from `@harness-control/runner/accounts`, call `read(requestId, payload)`, then `close()` in a finally block. Reads coalesce per provider, cache for 30 seconds, bound process concurrency to four, and time out each collector after 15 seconds by default. Custom collectors must stop their native resources when the signal aborts. Wire reads require an accepted authenticated connection and advertise `account_usage`; local opt-in remains authoritative.

## Build a custom harness

The `@harness-control/runner/harnesses` export provides `HarnessAdapter`, all adapter input/output types, `ProviderDriverStatus`, `HarnessAdapterRegistry`, and `HarnessSessionManager`.

```ts
import { HarnessAdapterRegistry, HarnessSessionManager } from "@harness-control/runner/harnesses";
import { RunnerConnection } from "@harness-control/runner/connection";

const sessions = new HarnessSessionManager(config, {
  adapterRegistry: new HarnessAdapterRegistry([new MyHarnessAdapter()]),
});
const connection = new RunnerConnection({ config, runnerVersion, harnessSessions: sessions });
await connection.connect();
```

Implement `HarnessAdapter` and configure a provider instance whose `driver_kind` matches your adapter's `driverKind`. Advertise the capabilities your adapter implements and validate session configuration in `validateStart`. The runner owns sequencing, receipts and transport; the adapter owns provider execution and cleanup. The repository's `examples/custom-harness.ts` is a typed example, and `examples/public-sdk.mjs` exercises it through public packages and a real loopback connection.

Local capability leases bind to HCP sessions and local resources. Keep product organization, workflow, run and node attribution in your application, mapped by the session or lease ID. The built-in `connect` command is a convenience for bundled providers; custom applications compose the public classes above.
