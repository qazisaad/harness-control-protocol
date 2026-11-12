# Integration checklist

**Who this is for:** the person signing off an HCP integration before release.
**How to use it:** every row is something your app must own. Each one says how to check it.

HCP is a protocol and a runner, not a hosted service. Everything below is your app's job.

## Level 1: pair, connect, run a turn

| Your app must | How to check |
| --- | --- |
| Serve the three pairing endpoints with bodies matching [`pairing.schema.json`](../../packages/hcp-protocol/schemas/pairing.schema.json) | `check-control-plane`: `pairing.*` |
| Let only a signed-in, authorised user approve a machine, and bind the machine to that user (and tenant) | Manual test with a second user, who must not see or use the machine |
| Check the approver's rights again when issuing the credential | Remove the approver's access between approve and exchange; the exchange must fail |
| Store only hashes of pairing codes, exchange secrets and credential secrets; encrypt `mcp_proof_secret` | Code review of the database schema |
| Make the one-time exchange and token spending atomic | Code review against [the two atomic steps](lifecycle.md#the-two-atomic-steps); `pairing.exchange_single_use`, `socket.rejects_reused_token` |
| Pin `protocol_schema_sha256` to the protocol version you tested, and tell users how to update | `token.rejects_unknown_schema` |
| Admit a socket only with a fresh token and a `host.hello` matching the credential | `socket.*` |
| Keep at most one live connection per machine | `socket.single_live_connection` |
| Revoke: refuse tokens and close the live socket within your stated time | `revoke.*` with `--revoke-timeout-seconds` set to your promise |
| Add folders only when the user asks, through `manageWorkspaces` | Manual test: a new machine shows no folders |
| Treat an ACK as "accepted" and wait for a terminal turn event | Code review; start waiting before sending |
| Run `hcp-runner check-control-plane` against staging in CI | CI job output |

## Level 2: tools, approvals and questions

| Your app must | How to check |
| --- | --- |
| Mint MCP leases and revoke them; the runner only enforces them | [Architecture: MCP boundary](../architecture.md#mcp-sdk-boundary) |
| Show approval and input requests to the right user, and answer only the matching request | [Public packages: commands and completion](../public-packages.md#commands-and-completion) |
| Handle `native.request.lost` and owner-lost events as "cannot answer any more" | Same section |

## Level 3: durable sessions and conversation controls

| Your app must | How to check |
| --- | --- |
| Store each command before sending it, and keep its id when retrying | [Reliability and snapshots](../reliability-and-snapshots.md) |
| Store events and the replay cursor in the same transaction, and pass only that stored cursor to `accept` | Same doc; restart your server mid-turn and check that no events are lost or duplicated |
| Recover from `gap`, `conflict` and `host.replay.unavailable` with a snapshot | Same doc |
| Check provider capabilities before offering history, fork, rollback or steering | [Provider support](../native-providers.md) |

## Before you call it done

Run the real flow once end to end on staging: a real user approves, the machine connects, publishes its capabilities, runs one turn to `turn.completed`, and is revoked. A passing check suite is necessary, but it is not that test.
