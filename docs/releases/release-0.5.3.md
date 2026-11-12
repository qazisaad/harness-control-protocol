# 0.5.3

Protocol, SDK and runner are released together at 0.5.3. The wire version remains `hcp.v0`, and the WebSocket message schema is unchanged, so `protocol_schema_sha256` is the same as 0.5.2.

## Claude filesystem containment

- Claude Code now supports `read_only` and `workspace_write`, enforced by its native OS shell sandbox. The turn fails if the sandbox is unavailable, and commands cannot escape it.
- `read_only` denies every write. `workspace_write` allows writes only to the folder and any selected `writable_roots`. Network is off unless `sandbox_options.network_access` is true.
- Before any input, the runner reads back Claude's effective sandbox settings and refuses the turn (`sandbox_unconfirmed`) unless they match exactly.
- In contained modes, Write, Edit, NotebookEdit and sub-agent tools are removed because they bypass the shell sandbox. File changes go through sandboxed Bash. `danger_full_access` keeps the full tool set.
- Claude Code itself creates an empty `.claude/.cc-writes/` directory in the folder when it runs sandboxed Bash.
- Claude model lists now mark the account's default model with `is_default`.

## Building a control plane

- `@harness-control/protocol/pairing.schema.json` exports the pairing and connection-token HTTP contract, with an `x-hcp-endpoints` map. `PAIRING_HTTP_PATHS` names the paths in TypeScript.
- `hcp-runner check-control-plane <runner-url> --hooks <test-hooks-url>` runs 18 black-box lifecycle checks over HTTP and WebSocket against any control plane. It is also importable from `@harness-control/runner/control-plane-check`.
- New docs: a docs index with adoption levels, concepts, a control-plane tutorial, the [lifecycle spec](../control-plane/lifecycle.md), an integration checklist, an examples index and `llms.txt`.
- New private `apps/reference-control-plane`: a small SQLite control plane that passes every lifecycle check and runs a turn on a real agent.
- The provider support tables in `docs/native-providers.md` are now generated from the runner's code, and a test fails when they drift.

## Security

- The runner's MCP dependencies are upgraded to `@modelcontextprotocol/client` 2.4.0, `core` 2.4.0, `server` 2.4.0, `node` 2.1.2 and `sdk` 1.32.2. This fixes published high-severity advisories, including HTTP transports re-sending custom headers on cross-origin redirects, unbounded request bodies, and mixed-up shared transports.
- Known remaining advisory: zod 4.4.3 ([GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5), memory use when validating oversized constrained collections). Upgrading zod changes generated schema output and timestamp validation, which changes `protocol_schema_sha256`. It is held back for a coordinated release with consumers' schema pins.

## Examples

- `examples/codex-runner-flow.ts` now uses the model the Codex account reports as its default, or `HCP_CODEX_MODEL`, instead of a fixed model that some plans reject.

## Upgrading

No consumer change is required. Apps that offered only `danger_full_access` for Claude can now offer `read_only` and `workspace_write` when the provider's capabilities advertise them.
