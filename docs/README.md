# HCP documentation

Harness Control Protocol lets your hosted app drive coding agents (Claude Code, Codex, OpenCode) on a user's own machine. The user's machine connects out to your server, so it needs no open port.

New here? Read [Concepts](concepts.md) first (5 minutes). Then pick your path.

## Pick your path

### I'm building an app that uses HCP

You write the server side, the *control plane*. HCP gives you the protocol, a TypeScript SDK, a spec and a test suite.

1. [Concepts](concepts.md): the words and the picture.
2. [Build a control plane in an afternoon](control-plane/tutorial.md): run, use and read a small working server.
3. [Control-plane lifecycle spec](control-plane/lifecycle.md): pairing states, the two atomic steps, revocation, and `check-control-plane`.
4. [Public packages and integration contract](public-packages.md): the SDK, commands and what "done" means for a turn.
5. [Integration checklist](control-plane/checklist.md): sign-off before release.

### I'm connecting my own machine

1. [Runner README](../packages/hcp-runner/README.md): install, `hcp-runner connect`, and keeping it running.
2. [Pairing](pairing.md): what happens when you approve a machine.
3. [Workspace management](workspace-management.md): which folders your app can see.
4. [Provider support](native-providers.md): what each coding agent can do.

### I'm adding a new coding agent (adapter)

1. [Architecture](architecture.md): the runner's boundaries.
2. [Runner README: build a custom harness](../packages/hcp-runner/README.md#build-a-custom-harness).
3. [Custom harness example](../examples/custom-harness.ts).
4. [Provider support](native-providers.md): the capability table your adapter must fill in.

### I'm changing the protocol

1. [Compatibility policy](compatibility.md).
2. [Protocol package README](../packages/hcp-protocol/README.md): schemas and conformance fixtures.
3. [Contributing](../CONTRIBUTING.md) and the [release process](maintainers/release-process.md).

## Adoption levels

You don't need everything. Stop at the level your product needs.

| Level | You can | You need |
| --- | --- | --- |
| **1. Run a turn** | Pair a machine, add a folder, run one prompt read-only, show the answer, revoke the machine | [Tutorial](control-plane/tutorial.md), [lifecycle spec](control-plane/lifecycle.md), [pairing](pairing.md), [workspace management](workspace-management.md) |
| **2. Tools and approvals** | Attach MCP tools, let the agent write files, and answer its approval and input requests | [Public packages](public-packages.md), [MCP attachments](mcp-stdio-and-cursor.md), [prompt context](prompt-context.md), [input files](input-files.md) |
| **3. Durable and advanced** | Survive restarts without losing events, keep warm sessions, read history, fork, roll back, steer, track quotas | [Reliability and snapshots](reliability-and-snapshots.md), [provider support](native-providers.md), and the Level 3 docs below |

## All reference docs

| Doc | Level | About |
| --- | --- | --- |
| [Concepts](concepts.md) | 1 | Words, picture and packages |
| [Control-plane tutorial](control-plane/tutorial.md) | 1 | Build and run a working server |
| [Control-plane lifecycle spec](control-plane/lifecycle.md) | 1 | States, atomic steps, revocation, checks |
| [Integration checklist](control-plane/checklist.md) | 1–3 | What your app must own, and how to check it |
| [Pairing](pairing.md) | 1 | The runner's side of pairing |
| [Workspace management](workspace-management.md) | 1 | Adding and listing folders |
| [Runner ownership](runner-ownership.md) | 1 | One runner per machine and endpoint |
| [Public packages](public-packages.md) | 1–2 | SDK, commands, completion |
| [Architecture](architecture.md) | 2 | Runner boundaries and MCP responsibilities |
| [MCP stdio and attachments](mcp-stdio-and-cursor.md) | 2 | Attaching MCP tool servers |
| [MCP input bridge](mcp-elicitation-bridge.md) | 2 | MCP tools that ask the user for input |
| [MCP detach](mcp-detach.md) | 2 | Removing tools from an idle session |
| [Prompt context](prompt-context.md) | 2 | Passing app context with a turn |
| [Input files](input-files.md) | 2 | Uploading files into a session |
| [Reliability and snapshots](reliability-and-snapshots.md) | 3 | Delivery, cursors, replay and snapshots |
| [Provider support](native-providers.md) | 3 | Generated capability tables per agent and profile |
| [Configuration transitions](configuration-transitions.md) | 3 | Changing policy on a retained conversation |
| [Native work history](native-work-history.md) | 3 | Reading and forking child agents' work |
| [Native output](native-output.md) | 3 | Output that arrives between turns |
| [Native retries](native-retries.md) | 3 | Retry observations |
| [Native quota observations](native-rate-limits.md) | 3 | Quota events during a session |
| [Native feedback](native-feedback.md) | 3 | Sending feedback to the provider |
| [Account capacity](account-capacity.md) | 3 | Reading account limits without a session |
| [Compatibility policy](compatibility.md) | — | What can change between versions |

Release notes are in [releases/](releases/). Maintainer notes (migration handoff, parity evidence, release process, licence decision) are in [maintainers/](maintainers/).
