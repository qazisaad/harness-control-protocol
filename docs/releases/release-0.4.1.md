# HCP 0.4.1 publication

Published protocol, SDK and runner 0.4.1 to npm on 2026-09-18, in dependency order.
The release adds process ownership and automatic crash recovery to connect and
run --config, with saved identity and credentials preserved. Duplicate ordinary
connect calls return success without starting another runner. Ownership remains
inside HCP; consuming products only adopt the package and explain terminal lifetime.
See runner-ownership.md for the lock contract and migration limits.

## Artifact identity

These are the exact archives from the successful full release gate. Registry
SHA-512 integrity was compared with each local archive after publication.

| Archive | SHA-256 |
| --- | --- |
| harness-control-protocol-0.4.1.tgz | d7e22c57a982df22cd2357a980df7473b89fdbd2315b20d33bd44294f42c43a1 |
| harness-control-sdk-0.4.1.tgz | 84b6453ff6d0a847541aff211157b74f57ba0a2bc61cce499d15ae03f4ae8551 |
| harness-control-runner-0.4.1.tgz | e9a1e4d671e865ade748b699caccfabebd35f9b2b94b60ab3307fbe3bfe6d91d |

Protocol schema SHA-256 remains
ce20b9d74126f51a5c702a33c9ac002116f661ee190367d54183f369d712b75f,
unchanged from 0.4.0. The wire envelope remains hcp.v0.

## Validation

- Full release check: all 192 tests, build, clean external installation with
  install scripts disabled, public adapter TypeScript compilation and public SDK
  WebSocket acceptance through session.exited passed.
- The dev-server exit test now requests HTTP readiness. It checks exit before
  readiness instead of assuming Node exits within the no-readiness 250 ms
  settlement window. No production dev-server behavior changed.
- The published npm runner connected to local Agentic Playground, rejected a
  duplicate owner cleanly, recovered after SIGKILL and reused identical config,
  credentials and installation identity.
- A real native Codex workflow after recovery reached P2A succeeded and journal
  session.exited. P2A records the run and session identifiers in
  docs/future/local-harness-hcp/12-runner-connection-recovery.md.
- P2A adopted exact protocol and SDK 0.4.1 pins and regenerated its backend
  contract. Its 51 focused frontend checks, typecheck, 34 backend checks and
  contract sync check passed.

Local native validation was on macOS; the cross-platform CI matrix was not run
remotely during publication. No P2A production deployment is claimed. Existing
0.3.0 direct-run processes must be stopped before upgrading because they bypass
connection ownership.
