# Contributing

Harness Control Protocol is early, pre-1.0 infrastructure. The highest-value contributions keep the protocol contract clear, the runner local-first, and the examples easy to verify.

## Development Setup

Prerequisites:

- Node.js 20 or newer.
- npm 10 or newer.

Install and validate:

```bash
npm install
npm run check
npm test
npm run build
```

Run the browser quickstart demo:

```bash
npm run demo:quickstart
```

## Project Shape

- `packages/hcp-protocol` owns HCP message types, runtime parsers, JSON Schema, conformance fixtures, and the conformance CLI.
- `packages/hcp-runner` owns the local runner CLI, control-plane connection, harness sessions, MCP attachment policy, and local action execution.
- `apps/mock-control-plane` is a local WebSocket control plane for tests and integration examples.
- `apps/sample-mcp-server` is a Streamable HTTP MCP reference server with proof verification.
- `demo/quickstart` is the browser demo for local actions, provider turns, and sample MCP setup.

The package scope is `@harness-control/*`. The runner binary remains `hcp-runner`.

## Change Guidelines

- Keep protocol fields explicit and validated at the protocol boundary.
- Keep local filesystem, Git, shell, and dev-server access behind HCP local action leases.
- Do not let backend payloads supply local executable paths, shell command strings, or stdio MCP command/args.
- Prefer small changes with focused tests over broad refactors.
- Update conformance fixtures when protocol behavior changes.
- Keep generated JSON Schema in sync with protocol source.

If protocol schemas change, run:

```bash
npm run schema:generate --workspace @harness-control/protocol
npm run build
```

## Validation

For most changes, run:

```bash
npm run check
npm test
npm run build
```

For runner/provider changes, also run the examples that apply:

```bash
npx tsx examples/basic-runner-flow.ts
npx tsx examples/codex-runner-flow.ts
npx tsx examples/claude-runner-flow.ts
```

The Codex and Claude examples skip live turns when the local CLI is unavailable or unauthenticated.

## Pull Request Expectations

Pull requests should include:

- A short explanation of the protocol or runner behavior being changed.
- Tests or conformance fixtures for new behavior.
- Any compatibility impact for control planes, runners, or adapters.
- Validation commands and results.

Avoid mixing dependency upgrades, formatting churn, and behavior changes in one pull request.
