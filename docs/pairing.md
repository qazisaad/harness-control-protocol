# Runner pairing

The reference HTTP contract lives in `packages/hcp-protocol/src/pairing.ts`. These are control-plane HTTP messages, separate from HCP WebSocket envelopes.

1. The runner generates a 32-byte random exchange secret and posts its SHA-256 hex hash, runner id, host id, and `protocol_version` to `/pairing-codes`.
2. The control plane returns `request_id`, `pairing_code`, `pairing_url`, `expires_at`, and `poll_interval_seconds`. The `connect` command opens the approval URL and prints a fallback link/code before polling. The lower-level `pair` command only prints instructions. A display code cannot exchange credentials.
3. An authenticated user authorized by the consuming application approves or declines the request in the consuming product. The runner posts `request_id`, its exchange secret, and the same identities/protocol to `/pairing-exchange`.
4. Pending returns `{ "status": "pending" }`. Approved returns `{ "status": "approved", "control_plane_url": "...", "credential": { ... } }`. Expired, declined, consumed, or mismatched requests return an HTTP error. Approval authority must be revalidated when credentials are issued.
5. The runner validates returned identities and the control-plane URL, then atomically replaces its credential file with a mode-0600 file. HTTP requests reject redirects and have bounded timeouts; polling stops at expiry or cancellation. Lost delivery after a consumed exchange requires a new pairing attempt.

Credentials require a dedicated `mcp_proof_secret` in addition to the login secret. The CLI no longer falls back to the login secret for proof signing. Old development credentials without a proof secret require re-pairing.

`/runner-connection-token` authenticates the login credential and requires `protocol_schema_sha256`, computed from the installed package's exported schema. The control plane compares it with its tested integration pin and returns a short-lived, single-use token. The runner sends the token in the WebSocket Authorization header. A schema digest is compatibility admission, not cryptographic attestation of the executable.

HTTP endpoints are rooted at the control-plane origin; its configured WebSocket URL may have a path such as `/hcp/runner`. Credentials, query parameters, and fragments are forbidden in that URL. Remote connections require HTTPS/WSS; local loopback development may use HTTP/WS.

The mock control plane starts requests as pending and exposes `decidePairing(requestId, "approved" | "declined")` to test code. It does not authenticate browser users and must not be deployed as a hosted authorization service. The standalone examples explicitly approve their test requests through this hook.

P2A binds each machine to its approving user; organization membership does not grant other users access. P2A owns personal approval, durable single-use exchange, encrypted proof storage, credential revocation, and connection fencing. HCP's runner implementation does not itself establish those hosted guarantees. Validate the consuming product through actual approval, connection, capability publication, and revocation before marking pairing end to end verified.
