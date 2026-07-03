# Release Process

Harness Control Protocol is pre-1.0. Releases should be conservative and should not imply production stability until the compatibility policy says so.

## Package Names

The public package scope is:

- `@harness-control/protocol`
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

## Publishing Notes

Before the first npm publish:

- Confirm npm organization/package ownership for `@harness-control`.
- Decide whether private example apps should remain unpublished.
- Add provenance/signing configuration if available.
- Confirm `exports`, `types`, and `bin` fields resolve from built packages.
- Publish from a clean build artifact, not an unvalidated worktree.
