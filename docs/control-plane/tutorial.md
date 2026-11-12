# Build a control plane in an afternoon

**Who this is for:** app developers adding HCP to their product.
**What you'll have at the end:** a server that pairs a real machine, adds a folder, runs one turn on a real coding agent, revokes the machine, and passes all 18 [lifecycle checks](lifecycle.md).
**Level:** 1.

You'll run the [reference control plane](../../apps/reference-control-plane), use it end to end, then read its code. It is about 400 lines of TypeScript on SQLite. The same design works in any language and database.

## What you need

- Node.js 22.13 or newer, and npm.
- A coding agent installed and signed in on your machine: Claude Code (`claude auth login`), Codex (`codex login`) or OpenCode.
- This repository, built:

```sh
git clone https://github.com/qazisaad/harness-control-protocol.git
cd harness-control-protocol
npm install && npm run build
```

## 1. Start the server

```sh
export HCP_ADMIN_TOKEN=$(openssl rand -hex 24)
npm run start --workspace @harness-control/reference-control-plane
```

It prints the URL a runner connects to: `http://127.0.0.1:8787/hcp/runner`. Data goes into `hcp-control-plane.sqlite`. Change it with `HCP_DATABASE`, and the port with `PORT`.

The admin token stands in for your app's login. Whoever holds it acts as the one admin user.

## 2. Connect a machine

In a second terminal, from the repository:

```sh
npm run dev:runner -- connect http://127.0.0.1:8787/hcp/runner
```

Pick the coding agents to enable. The runner opens the pairing page, which shows a code and an approval command.

The published runner works too (`npx @harness-control/runner@0.5.3 connect …`). The server only admits runners built from the same protocol schema it was built with (see [connection tokens](lifecycle.md#connection-tokens)).

## 3. Approve it

Copy the `curl` command from the pairing page and run it in a third terminal. It looks like this:

```sh
curl -X POST http://127.0.0.1:8787/admin/approve \
  -H "Authorization: Bearer $HCP_ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"request_id":"…","pairing_code":"…"}'
```

The runner terminal says it is connected. List your machines and copy the `credential_id`:

```sh
curl -s http://127.0.0.1:8787/admin/machines -H "Authorization: Bearer $HCP_ADMIN_TOKEN"
```

## 4. Add a folder

The runner never shares a folder on its own. The app asks for it, and the runner checks the path against its local allowed roots:

```sh
export MACHINE=<credential_id>
curl -s -X POST http://127.0.0.1:8787/admin/folders \
  -H "Authorization: Bearer $HCP_ADMIN_TOKEN" -H "content-type: application/json" \
  -d "{\"credential_id\":\"$MACHINE\",\"path\":\"$PWD\",\"display_name\":\"HCP repo\"}"
```

## 5. Run a turn

The reference server cannot answer approval requests; that is [Level 2](../README.md#adoption-levels). So pick a sandbox the agent supports and an approval policy under which it won't ask. The server never widens access for you: it refuses a sandbox or policy the agent does not advertise ([provider support](../native-providers.md) lists them).

Codex and Claude Code both enforce a real read-only sandbox, so use it with an approval policy that doesn't ask. Set `provider_instance_id` to `codex-local` or `claude-local`:

```sh
curl -s -X POST http://127.0.0.1:8787/admin/turn \
  -H "Authorization: Bearer $HCP_ADMIN_TOKEN" -H "content-type: application/json" \
  -d "{\"credential_id\":\"$MACHINE\",\"provider_instance_id\":\"claude-local\",\"sandbox_mode\":\"read_only\",\"approval_policy\":\"full_access\",\"prompt\":\"In two sentences, what does this repository do?\"}"
```

`full_access` here only means "don't ask". The agent still cannot write files: the sandbox blocks it. OpenCode has no sandbox, so it accepts only `danger_full_access`, which lets the agent run anything your user account can.

The answer comes back as `final_text`, with `outcome: "turn.completed"`. If you leave out `sandbox_mode` and `approval_policy`, the server uses `read_only` and `ask`. If the agent then asks for approval, for example before running a command, the server stops the turn and tells you why.

## 6. Revoke it

```sh
curl -s -X POST http://127.0.0.1:8787/admin/revoke \
  -H "Authorization: Bearer $HCP_ADMIN_TOKEN" -H "content-type: application/json" \
  -d "{\"credential_id\":\"$MACHINE\"}"
```

The runner's connection closes at once, and it can no longer get tokens. To connect again, it must be approved again.

## 7. Prove it follows the spec

Stop the runner, then run the lifecycle checks. The admin API doubles as the checks' [test hooks](lifecycle.md#run-the-checks):

```sh
npm run dev:runner -- check-control-plane http://127.0.0.1:8787/hcp/runner \
  --hooks http://127.0.0.1:8787/admin/ --hooks-token-env HCP_ADMIN_TOKEN
```

You should see 18 `PASS` lines. The same checks run in the package tests: `npm test --workspace @harness-control/reference-control-plane`.

## 8. Read the code

Read the two files next to the [lifecycle spec](lifecycle.md):

| File | What to look at |
| --- | --- |
| [`store.ts`](../../apps/reference-control-plane/src/store.ts) | The three tables. `exchange` and `consumeToken` are the [two atomic steps](lifecycle.md#the-two-atomic-steps), each one conditional `UPDATE`. `revoke` raises the generation. |
| [`server.ts`](../../apps/reference-control-plane/src/server.ts) | The pairing endpoints, the approval page, the admin API, WebSocket admission (spend the token, match the hello, keep one live socket) and `runTurn`. |

Two details in `runTurn` apply to every app:

- **Start waiting before you send.** `waitForSessionEvent` only sees events that arrive after it starts. A fast agent can finish before your send call returns.
- **An ACK only means "accepted".** The turn ends with `turn.completed`, `turn.failed`, `turn.aborted` or `turn.cancelled`.

## 9. Make it yours

Before production, replace each stand-in:

| Stand-in | Replace with |
| --- | --- |
| One admin token | Your sessions and roles. Bind each machine to the approving user, and check that user's rights again at exchange time. |
| SQLite | Your database. The SQL in `store.ts` works on Postgres as written. In Convex, make each atomic step one mutation. |
| One process holds every socket | With several processes, send revocation to the process holding the socket through pub/sub or a database subscription. Keep the heartbeat check as a backstop. |
| `mcp_proof_secret` stored as plain text | Encrypt it at rest. |
| Test hooks on `/admin/` | Hooks served only in test environments, behind their own token. |
| Turns held in memory | Store commands before sending them, and store events with your replay cursor. See [reliability and snapshots](../reliability-and-snapshots.md). |

Then work through the [integration checklist](checklist.md).
