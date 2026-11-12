# Reference control plane

A small HCP control plane you can read in one sitting and deploy: pairing, one-time connection tokens, revocation, folders and one turn, on SQLite. It passes every check in the [control-plane lifecycle spec](../../docs/control-plane/lifecycle.md).

Walk through it with the [tutorial](../../docs/control-plane/tutorial.md).

```sh
export HCP_ADMIN_TOKEN=$(openssl rand -hex 24)
npm run start --workspace @harness-control/reference-control-plane
```

| Setting | Default |
| --- | --- |
| `HCP_ADMIN_TOKEN` | Required. Stands in for app login. |
| `HCP_DATABASE` | `hcp-control-plane.sqlite` |
| `HCP_PUBLIC_URL` | The listening address. Set it to your HTTPS origin behind a proxy. |
| `HOST`, `PORT` | `127.0.0.1`, `8787` |

| File | Holds |
| --- | --- |
| [`src/store.ts`](src/store.ts) | Tables, the state machine and the two atomic steps |
| [`src/server.ts`](src/server.ts) | Pairing endpoints, approval page, admin API, WebSocket admission and one turn |
| [`src/index.test.ts`](src/index.test.ts) | Runs all lifecycle checks, and a full Level 1 flow with a real runner and the mock agent |

Needs Node.js 22.13 or newer for `node:sqlite`. Before production, replace the stand-ins listed in [the tutorial's last step](../../docs/control-plane/tutorial.md#9-make-it-yours).
