# Examples

Start at the top and stop at the level your app needs. Run each one from the repository root after `npm install && npm run build`.

## Level 1: pair, connect, run a turn

| Example | Shows | Run |
| --- | --- | --- |
| [Reference control plane](../apps/reference-control-plane) | A small deployable server: pairing, tokens, revocation, folders and one turn on a real agent. Start with its [tutorial](../docs/control-plane/tutorial.md). | `npm run start --workspace @harness-control/reference-control-plane` |
| [`basic-runner-flow.ts`](basic-runner-flow.ts) | The whole flow in one file, against the in-process mock control plane and a mock agent, with a sample MCP server | `npx tsx examples/basic-runner-flow.ts` |
| [`public-sdk.mjs`](public-sdk.mjs) | An app's side using only the published packages: accept a runner, read accounts, manage folders, run a turn to its terminal event | Copied and run by `npm run release:check` |

## Level 1 with a real coding agent

These need the agent's CLI installed and signed in. They run one real turn.

| Example | Agent | Run |
| --- | --- | --- |
| [`claude-runner-flow.ts`](claude-runner-flow.ts) | Claude Code | `npx tsx examples/claude-runner-flow.ts` |
| [`codex-runner-flow.ts`](codex-runner-flow.ts) | Codex | `npx tsx examples/codex-runner-flow.ts` |
| [`codex-policy-smoke.ts`](codex-policy-smoke.ts) | Codex: checks sandbox and approval policies directly through the adapter | `npx tsx examples/codex-policy-smoke.ts` |

## Building an adapter

| Example | Shows |
| --- | --- |
| [`custom-harness.ts`](custom-harness.ts) | The smallest custom coding-agent adapter. Replace the turn body with your agent. |
| [`conversation-controls.ts`](conversation-controls.ts) | A deterministic adapter with history, fork, rollback and other Level 3 controls |

## Package checks (Level 2 and 3)

[`package-checks/`](package-checks) holds one fixture per feature: MCP review and detach, input files, images, plans, child agents, history and more. `npm run release:check` copies each into a clean project that has only the packed packages installed, and runs it. They use synthetic ids, so they prove the public API and wire contract, not live agent behaviour. Read the one for a feature when you implement it; the [docs index](../docs/README.md#all-reference-docs) links each feature's doc.
