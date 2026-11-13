# 0.6.0 (draft)

Protocol, SDK and runner are released together at 0.6.0. The wire version remains `hcp.v0`. This release adds message types and capability fields, so **`protocol_schema_sha256` changes**. This draft has not been published.

## Installing coding agents

- `hcp-runner providers install <claude|codex|opencode> --config <path>` installs the runner's tested version of an agent with the user's npm into `~/.hcp-runner/providers/<agent>/<version>`, never with `sudo` or globally, and points every instance of that agent at it. `providers update` switches to the tested version; `providers status` prints version, status and sign-in command per configured agent. Stop the runner first. See [installing coding agents](../provider-setup.md).
- Tested versions: Claude Code `2.1.289`, Codex `0.161.0`, OpenCode `1.18.34`. They come from one table, which the CLI, remote setup, capabilities and the generated [provider matrix](../native-providers.md#versions) all read. Codex and OpenCode pin the newest versions their adapters publish execution profiles for.
- An install is verified with the agent's own probe in a private folder before it becomes the version folder and before the configuration changes.
- Sign-in is never automated. Provider snapshots that need sign-in carry `auth.login_command`, a command line for the machine's user, built from the configured executable and home. `hcp-runner connect` now prints it, and the install command for missing agents.
- Windows is refused with `unsupported_platform`.

## App-triggered setup (off by default)

- The machine's user can allow it per agent with `"provider_setup": {"remote_agents": ["codex"]}` in `runner.json`. The app cannot enable it.
- Capabilities include `provider_setup: {agents: [{agent, version}]}`. An empty list means off.
- New `host.providers.setup.request` `{agent, action: "install" | "update", expires_at}` and `host.providers.setup.result` `{request_id, agent, action, outcome}`. The outcome is `installed {version, changed, status, login_command?}`, `refused {reason, message}` or `failed {reason, message}`. The app never names a package, version, URL or path.
- The runner records each result for 24 hours: the same request id returns the same result without a second install. Setups of one agent run one at a time, and a successful change republishes `host.capabilities.updated`.
- SDK: `setupProvider(payload)` resolves with the result; an ACK never finishes it. A disconnect or timeout leaves the outcome unknown: read capabilities or resend the same id.

## Upgrade together

- `protocol_schema_sha256` is now `3b5ad3969e272323232f59654d06d1a96f962508c120ea8b30558b17e695167f` (recompute after any further schema change before publishing). A control plane that pins the digest must move its pin and its runner install command to 0.6.0 in one release.
- Strict 0.5.x parsers reject the new message types and the new `provider_setup` and `auth.login_command` fields.
- `RunnerConnectionOptions.providerSetup` lets embedders choose the install folder and package installer.

## Verification

Recorded on macOS arm64 (13 November 2026): `hcp-runner providers install opencode` and `providers install codex` from source into a temporary runner home installed `opencode-ai@1.18.34` (status `ready`) and `@openai/codex@0.161.0` (status `unauthenticated`, with its `codex login` command); `update opencode` reported it already current and `install opencode` was refused as already installed. Claude Code was not installed in this check.
