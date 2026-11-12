# HCP 0.4.0 publication

Published on 2026-09-18 to the public npm registry, in dependency order:

- `@harness-control/protocol@0.4.0`
- `@harness-control/sdk@0.4.0`
- `@harness-control/runner@0.4.0`

The release removes organization/workflow/run/node fields from local capability contracts, exposes the custom adapter API through the public harnesses entry, and keeps runner onboarding independent of a consuming product. It also includes the account observation API already present in the 0.4.0 candidate. See `compatibility.md` for the breaking local-capability changes. The wire envelope remains `hcp.v0`.

## Artifact identity

The published archives are the exact candidates whose build, 181 workspace tests, external TypeScript adapter compilation and public SDK WebSocket acceptance passed before publication. Registry SHA-512 integrity was compared with each local archive after publication.

| Archive | SHA-256 |
| --- | --- |
| harness-control-protocol-0.4.0.tgz | 5edb5c1ee74584d0015a27fd0e9c6fd42c55e857c2dcc4d1043af8b38f3d7b91 |
| harness-control-sdk-0.4.0.tgz | 2c623918bbed23af6ea342ea36b5b44ac38c92ec9e08f506dd1b3345da058897 |
| harness-control-runner-0.4.0.tgz | 7c7c122b1181f1d52c11b1fe9f22e65ed7ed4119f9558bc58ff4ec38f75511ac |

The protocol JSON Schema SHA-256 is `ce20b9d74126f51a5c702a33c9ac002116f661ee190367d54183f369d712b75f`.

Further concurrent working-tree changes are not identified by these hashes and must not be assumed to be in 0.4.0. A subsequent full-source check failed subprocess timing tests on a heavily loaded machine; that check did not replace the validated archives. Subsequent runner changes require another version and their own release validation.

Agentic Playground pins the published protocol and SDK at 0.4.0 and regenerates its Python contract from that installed package. Its runner command uses the same version. This publication does not deploy Agentic Playground or establish production provider acceptance.

A fresh external consumer installed all three packages from npm with a fresh cache after publication. The installed runner reported 0.4.0; the custom adapter compiled through public exports; account observation, workspace management, terminal custom-harness execution, a lease-bound local file read, snapshot reduction and session exit all passed over a real loopback WebSocket.
