# Release Process

Harness Control Protocol is pre-1.0. Releases should be conservative and should not imply production stability until the compatibility policy says so.

## Package Names

The public package scope is:

- `@harness-control/protocol`
- `@harness-control/sdk`
- `@harness-control/management`
- `@harness-control/runner`

The runner CLI binary remains:

- `hcp-runner`

Internal demo and app packages are private unless explicitly promoted:

- `@harness-control/mock-control-plane`
- `@harness-control/sample-mcp-server`
- `@harness-control/quickstart-demo`

## Release Checklist

1. Confirm the worktree is clean.
2. Confirm package names and README clone URLs match the repository.
3. Run validation:

   ```bash
   npm run check
   npm test
   npm run build
   npm audit
   ```

4. Run smoke examples when local provider setup allows:

   ```bash
   npx tsx examples/basic-runner-flow.ts
   npx tsx examples/codex-runner-flow.ts
   npx tsx examples/claude-runner-flow.ts
   ```

5. If protocol schemas changed, regenerate and commit the JSON Schema:

   ```bash
   npm run schema:generate --workspace @harness-control/protocol
   npm run build
   ```

6. Review compatibility impact against `docs/compatibility.md`.
7. Update README status and release notes.
8. Tag the release only after validation passes.

## Versioning Before 1.0

Until `1.0.0`, any minor version may include breaking protocol changes. Even so, every breaking change should be explicit in release notes.

Examples of breaking changes:

- Removing or renaming protocol message fields.
- Changing validation semantics for existing protocol payloads.
- Changing local action lease requirements.
- Changing MCP attachment transport policy.
- Changing runner/provider adapter command semantics.

Patch releases should be limited to bug fixes, docs corrections, dependency security fixes, and compatibility-preserving hardening.

## Generated Files

The committed schema file is generated from protocol source:

```text
packages/hcp-protocol/schemas/hcp-message.schema.json
```

Do not edit it by hand. Update protocol source and run:

```bash
npm run schema:generate --workspace @harness-control/protocol
```

## Publishing

`@harness-control/protocol`, `@harness-control/sdk`, `@harness-control/runner`, and optional `@harness-control/management` are released together. Set the same exact version in their manifests and internal dependencies, then refresh the root npm lockfile. The wire version remains `hcp.v0` until the wire contract itself changes. Apps, demos, and the monorepo remain private.

Run `npm run release:check`. It builds and tests the repo, packs an allowlist of runtime files with package documentation and licenses, installs all four archives in a clean external project, checks the installed CLI and public exports, and executes `examples/public-sdk.mjs` over a real loopback WebSocket. Successful candidates and their SHA-256 manifest are written to `dist/release`. No source-checkout imports are available to that consumer.

After logging in to an npm account with publish access to `@harness-control`, run `npm run release:publish`. This repeats validation, verifies each artifact hash, and publishes protocol, SDK, runner, and management in dependency order. npm may require browser/2FA approval. Publication is not atomic: if interrupted, inspect each registry version and integrity before publishing only the missing artifacts; never replace an already published version. Use a new version if its contents must change.

P2A pins exact npm versions and generates its Python wire schemas from the installed protocol package. Its lockfile owns package integrity. The packed mock-provider scenario verifies the package boundaries, not a live Codex/Claude account turn.
