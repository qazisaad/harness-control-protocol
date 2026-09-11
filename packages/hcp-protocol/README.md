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
