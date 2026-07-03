# Security Policy

## Supported Versions

Harness Control Protocol is pre-1.0. Security fixes are made on `main` until versioned releases begin.

| Version | Supported |
| --- | --- |
| `main` | Yes |
| Published pre-1.0 packages | Best effort |

## Reporting A Vulnerability

Do not publish exploit details in public issues.

Until GitHub private vulnerability reporting is enabled for this repository, open a minimal public issue asking for a private maintainer contact path. Include only:

- The affected component.
- Whether the issue affects local machine access, credentials, MCP attachments, protocol validation, or hosted control-plane trust.
- A safe way for maintainers to contact you.

After a private channel is established, include reproduction steps, affected commit/package versions, and any suggested mitigation.

## Security Boundaries

HCP treats the local runner as the sensitive boundary:

- The runner connects outbound to a control plane.
- Local workspaces, provider homes, provider credentials, executable paths, and persistent environment stay runner-local.
- Local filesystem, Git, shell, and dev-server operations require HCP local action leases.
- MCP attachments are currently accepted only as Streamable HTTP server URLs with proof-of-possession requirements.
- Backend-supplied stdio MCP command/args are rejected by protocol validation.
- Codex and Claude Code receive runner-owned loopback MCP proxy URLs, not platform bearer/proof headers.

## High-Risk Areas

Please report issues that allow:

- Escaping configured workspace containment.
- Running unapproved local commands.
- Bypassing local action lease scope, expiry, attribution, or approval hashes.
- Supplying backend-controlled stdio MCP executable configuration.
- Leaking provider paths, credentials, tokens, MCP headers, or tool arguments in logs/events.
- Reusing proof nonces or accepting stale proof signatures.
- Mutating persistent provider configuration when only process-local configuration is intended.

## Dependency Security

Run:

```bash
npm audit
```

Dependency remediation should be reviewed separately from behavior changes unless a vulnerability directly blocks the behavior change.
