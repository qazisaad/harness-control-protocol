# @harness-control/protocol

Shared TypeScript types, Zod validators, JSON Schema, pairing contracts, and the canonical session event reducer for Harness Control Protocol. No provider or transport dependencies.

```sh
npm install @harness-control/protocol
```

```ts
import { parseHcpMessage, HcpSessionEventReducer } from "@harness-control/protocol";
const message = parseHcpMessage(JSON.parse(wireMessage));
```

Use `@harness-control/protocol/schema.json` for validators in Python or other languages. Use `@harness-control/sdk` for app-side commands and request correlation, and `@harness-control/runner` on the local machine.

The package includes `hcp-protocol-conformance` and conformance fixtures. See [HCP documentation](https://github.com/qazisaad/harness-control-protocol#readme) for wire semantics and compatibility. Package versions and the wire protocol version (`hcp.v0`) are separate.

### MCP review extension v1

HCP owns `io.harness-control/review-v1`. Tool metadata under this key contains a policy (`always`, or `argument` with a name and allowed values). Call metadata under the same key contains `{request_id, action_json}`. These are review hints and a bound grant, not independent authorization: the control plane still validates its current user, tool policy, lease, decision and dispatch claim.

Import `mcpReviewActionSchema`, `mcpReviewGrantSchema`, `mcpReviewPolicySchema`, `mcpReviewActionBytes`, and `hashMcpReviewAction` from `@harness-control/protocol`. Action JSON is a closed `{kind: "mcp_tool", attachment_name, tool_name, arguments}` object. The immutable action string is limited to 65,536 UTF-8 bytes; the hash is lowercase hexadecimal SHA-256 of those exact bytes, without whitespace or Unicode normalization. Do not parse and reserialize it before hashing or forwarding.

Non-TypeScript consumers use `@harness-control/protocol/mcp-review.json` and the shared `mcp-review-fixtures.json`. In addition to JSON Schema validation, enforce the manifest's UTF-8 byte limit and validate the grant's embedded action JSON against the action schema. The versioned key intentionally has no application-specific alias.

Durable continuation is an adapter capability (`durableMcpContinuation: true`), not a restriction in the persisted operation contract. Only adapters that can restore their native execution context should declare it. The built-in Codex adapter currently does; other built-ins do not. Application authorization and supported-provider policy remain the control plane's responsibility. See `examples/mcp-review-consumer.mjs` for approval and restart recovery using public APIs with an independent adapter.
