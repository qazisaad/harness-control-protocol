# Runner pairing

**Who this is for:** app developers who want to know what the runner does when a user connects a machine.
**Level:** 1.

Pairing turns "a terminal on someone's laptop" into "a machine that belongs to a signed-in user of your app". It happens over three HTTP calls, before any WebSocket.

## Who owns what

- **Your app owns the code** on the server side: approval, the one-time exchange, credential storage, revocation and fencing. HCP has no central service.
- **HCP owns the rules and the proof.** The [control-plane lifecycle spec](control-plane/lifecycle.md) states the server's states and atomic steps, and `hcp-runner check-control-plane` checks a running server against them.
- **The runner owns the client side**, described below.

The request and response bodies are in [`pairing.schema.json`](../packages/hcp-protocol/schemas/pairing.schema.json), exported as `@harness-control/protocol/pairing.schema.json`. Generate models from it in any language. In TypeScript, import the Zod schemas and `PAIRING_HTTP_PATHS` from `@harness-control/protocol`.

## What the runner does

1. **Create.** It generates a random 32-byte exchange secret and posts its SHA-256 hash, `runner_id`, `host_id` and `protocol_version` to `/pairing-codes`.
2. **Show the code.** The response has `request_id`, `pairing_code`, `pairing_url`, `expires_at` and `poll_interval_seconds`. `hcp-runner connect` opens the approval page and prints a fallback link and code. `hcp-runner pair` only prints them. The code alone cannot get a credential.
3. **Wait for approval.** A signed-in user of your app approves or declines on the pairing page.
4. **Exchange.** The runner posts `request_id`, the exchange secret and the same identities to `/pairing-exchange`, every `poll_interval_seconds`, until it gets `approved`, an HTTP error, or the request expires.
5. **Save.** It checks that the credential names the same runner, host and control-plane URL it asked for. Then it atomically replaces its credential file (mode 0600).
6. **Connect.** Each time it connects, it posts the credential and `protocol_schema_sha256` to `/runner-connection-token`. It sends the short-lived token it gets back in the WebSocket `Authorization` header.

If the approved credential is lost in transit after the exchange, the runner must pair again. A consumed request cannot be exchanged twice.

## Runner-side rules

- The runner refuses redirects, and every request has a timeout.
- The URL it is given must not contain credentials, query parameters or a fragment. Remote URLs must use HTTPS and WSS; plain HTTP is allowed only on loopback.
- HTTP endpoints are rooted at the URL's origin. The WebSocket URL itself may have a path, such as `/hcp/runner`.
- Credentials need a separate `mcp_proof_secret` for signing MCP requests. The runner never falls back to the login secret. Old development credentials without one must pair again.
- `protocol_schema_sha256` is the SHA-256 of the runner's installed `hcp-message.schema.json`. It tells the control plane which protocol build is connecting. It is not proof of which executable is running.

## Testing without a real app

The [mock control plane](../apps/mock-control-plane) starts every request as pending and lets test code call `decidePairing(requestId, "approved" | "declined")`. It has no user login. Never deploy it.

For a small server you can deploy and read in one sitting, use the [reference control plane](../apps/reference-control-plane) and its [tutorial](control-plane/tutorial.md).

## Done means verified end to end

Before calling pairing done in your product, check it through the real flow: a real approval, a connection, capability publication, and revocation. Run `hcp-runner check-control-plane` against your staging server as part of that.
