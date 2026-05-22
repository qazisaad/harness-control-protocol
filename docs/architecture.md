# Architecture

## Repositories

The runner is intentionally structured as a standalone public project.

- `packages/hcp-protocol`: public protocol types and schemas
- `packages/hcp-runner`: local runner CLI and daemon
- `apps/mock-control-plane`: local test control plane for third-party validation

## Boundary

The runner connects outbound to a control plane. The browser and hosted app do not require inbound network access to the user's machine.

Provider executable paths, home directories, launch arguments, and persistent environment variables remain runner-local by default.
