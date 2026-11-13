# Installing coding agents

**Who this is for:** people connecting their own machine who don't have Claude Code, Codex or OpenCode yet, and app builders who want to offer an "Install" button.

The runner can install the tested version of a coding agent for itself. It installs into its own folder, points its configuration at that copy and checks it with the same probe it uses for capabilities. Signing in stays with you, on your machine.

## Install on your machine

Stop the runner first (press Ctrl+C in its terminal). Then, with the configuration file `hcp-runner connect` printed:

```sh
hcp-runner providers install codex --config ~/.hcp-runner/connections/<id>/runner.json
hcp-runner providers update claude --config <path>
hcp-runner providers status --config <path>
```

`install` refuses when the agent already works; `update` switches it to the tested version and does nothing when it already reports that version. `status` prints each configured agent's version, status and sign-in command, and suggests `install` or `update` when the agent is not at the tested version. Start the runner again afterwards.

When the agent needs you to sign in, the command prints it, for example:

```text
Codex 0.161.0 is installed and set in /home/me/.hcp-runner/connections/1a2b/runner.json.
Status: unauthenticated
Sign in on this machine: /home/me/.hcp-runner/providers/codex/0.161.0/node_modules/.bin/codex login
```

Run that command in a terminal. It uses the installed copy and, when the agent has a custom `home`, that home. OpenCode works without an account and never asks you to sign in.

## What gets installed

| Agent | npm package | Tested version |
| --- | --- | --- |
| Claude Code | `@anthropic-ai/claude-code` | `2.1.289` |
| Codex | `@openai/codex` | `0.161.0` |
| OpenCode | `opencode-ai` | `1.18.34` |

These are the only versions a runner release installs. They are generated into [provider support](native-providers.md#versions) from the same table, and each is the version the adapter publishes execution profiles for (Claude has no version gate, so it pins the version the acceptance runs used). A new runner release can change them.

The runner runs your `npm install` with an exact `package@version`, into `~/.hcp-runner/providers/<agent>/<version>`. It never uses `sudo` or a global install, never changes an agent you installed yourself, and never runs a shell command line. npm uses your own registry settings, and the package's install script runs as you. The install happens in a private folder that becomes the version folder only after the probe reports the tested version, so a version folder is always complete. Every configured instance of that agent then uses the new copy; an agent with no instance gets one named `<agent>-local`. The configuration file is replaced atomically.

Windows is not supported yet: the runner refuses with `unsupported_platform`. Install the agent yourself there.

## Let your app install agents

Remote setup is off unless you turn it on. Stop the runner, add the agents your app may install to `runner.json`, then start it again:

```json
{
  "provider_setup": { "remote_agents": ["codex", "opencode"] }
}
```

Only you can change this list: the app can never enable remote setup, add an agent, or choose a package, version, URL or folder. There is no "ask me on the machine" mode; an agent is either listed or not.

## For app builders

Capabilities include `provider_setup: {agents: [{agent, version}]}`: the agents this machine allows and the version each would install. An empty list means remote setup is off. A runner without the field does not support remote setup.

Send `host.providers.setup.request` with only the agent, the action and a near expiry:

```json
{"agent": "codex", "action": "install", "expires_at": "2026-11-13T12:00:30Z"}
```

With the SDK, `await peer.setupProvider({agent: "codex", action: "install", expires_at})` resolves with the matching `host.providers.setup.result`. An ACK never finishes it; the default wait is 15 minutes because npm can be slow. The result carries the request's `request_id`, `agent` and `action`, and one `outcome`:

| `outcome.kind` | Fields | Meaning |
| --- | --- | --- |
| `installed` | `version`, `changed`, `status`, `login_command?` | The agent reports the tested version. `changed: false` means nothing was installed or reconfigured. `status` is the provider status after the change; `login_command` is present only when it is `unauthenticated`. |
| `refused` | `reason`, `message` | Nothing was attempted: `remote_setup_disabled`, `agent_not_allowed`, `already_installed`, `request_expired`, `unsupported_platform` or `request_id_reused`. |
| `failed` | `reason`, `message` | `install_failed` (npm or the install folder), `verification_failed` (the installed command did not report the tested version) or `configuration_failed` (a session is active, or `runner.json` changed on disk; the files are installed and a retry reuses them). |

After a change the runner publishes `host.capabilities.updated`. Provider snapshots that need sign-in carry `auth.login_command`, a command line for the machine's user to run in a local terminal. Show it; never run it for them.

The runner records each result for 24 hours. Sending the same request id again returns the recorded result without installing again; a different request under a used id is refused with `request_id_reused`. Setups of one agent run one at a time.

**Unknown outcomes.** If the connection drops or your wait times out during an install, the outcome is unknown. The install keeps running on the machine. Read capabilities when the runner reconnects, or resend the same request id to receive the recorded result. Do not send a new id until you know the first one finished.

Only machine owners should be able to trigger setup. Bind requests and results to the authenticated runner connection, and expire queued requests.
