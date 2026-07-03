# Compatibility Policy

Harness Control Protocol is pre-1.0. This document describes the intended compatibility model so consumers can track changes deliberately.

## Compatibility Surfaces

HCP has four main compatibility surfaces:

- Protocol messages: envelopes, payload schemas, event types, local action contracts, and conformance fixtures.
- Runner behavior: connection lifecycle, pairing, replay, local action enforcement, audit events, and MCP attachment handling.
- Harness adapters: Codex, Claude Code, and future provider-specific process/config behavior.
- Package APIs: TypeScript exports from `@harness-control/protocol` and `@harness-control/runner`.

## Protocol Compatibility

Compatible protocol changes include:

- Adding optional fields.
- Adding new event types under documented extension rules.
- Adding new conformance fixtures that clarify existing behavior.
- Tightening docs without changing parser behavior.

Breaking protocol changes include:

- Removing or renaming fields.
- Making optional fields required.
- Changing accepted enum values.
- Changing local action lease binding or approval semantics.
- Changing MCP attachment transport policy.
- Changing event terminality or replay cursor semantics.

Every breaking protocol change should update conformance fixtures and release notes.

## Runner Compatibility

Compatible runner changes include:

- Stronger validation that rejects previously invalid or unsafe inputs.
- More complete redaction of paths, tokens, arguments, outputs, and errors.
- Additional events that do not replace existing required events.
- Process-local provider configuration hardening.

Breaking runner changes include:

- Changing CLI flags or config file shape.
- Mutating persistent provider config where previous behavior was process-local.
- Changing local action output shapes.
- Removing supported adapters.
- Changing workspace containment rules in a way that affects valid existing configurations.

## MCP Compatibility

Current supported MCP attachment transport:

- `streamable_http`

Current unsupported transport from backend payloads:

- `stdio`

Backend-supplied stdio command/args are intentionally rejected. A future stdio design should use local runner-owned named profiles where command paths, args, environment, and working directory policy live in local config.

## Package Compatibility

Public package imports should use:

```ts
import { HCP_VERSION } from "@harness-control/protocol";
```

The old `@hcp-runner/*` scope is not a published compatibility target. It was replaced before public package release.

## Deprecation Practice

Before 1.0, prefer direct cleanup over long compatibility shims when the affected surface has not been published.

After 1.0, deprecations should include:

- A documented replacement.
- A warning period when practical.
- Conformance coverage for both old and new behavior during the transition.
- A release note naming the removal version.
