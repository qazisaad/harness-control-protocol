# Compatibility Policy

Harness Control Protocol is pre-1.0. This document describes the intended compatibility model so consumers can track changes deliberately.

## Compatibility Surfaces

HCP has four main compatibility surfaces:

- Protocol messages: envelopes, payload schemas, event types, local action contracts, and conformance fixtures.
- Runner behavior: connection lifecycle, pairing, replay, local action enforcement, audit events, and MCP attachment handling.
- Harness adapters: Codex, Claude Code, OpenCode, and future provider-specific process/config behavior.
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

The pre-release cursor contract changed before package publication: `host.hello` now advertises runner-owned `retained_events`, while `host.accepted.resume` carries the control plane's last durably applied sequence. Consumers must not send the old `host.hello.resume` shape.

Every breaking protocol change should update conformance fixtures and release notes.

Version 0.4.0 removes `org_id`, `workflow_id`, `run_id`, and `node_id` from local capability leases, and removes `run_id` from local action attribution, lease bindings and action events. Consumers must omit those fields and keep product attribution in their own records, mapped by HCP session or lease ID. Strict schemas reject the old fields. Session, host, provider, workspace and lease authorization bindings remain enforced. Upgrade the protocol, SDK, runner and the consuming control plane's generated schema together; the wire envelope remains `hcp.v0`.

The native-adapter update adds optional provider `execution_capabilities`. Its presence describes actual streaming, multi-turn/continuation, sandbox, and approval support; omission is unknown. Older strict parsers may reject the added field, so pre-release clients must use a matching schema/build.

The reference pairing HTTP contract now requires private exchange-secret binding, explicit pending/approved responses, and a dedicated MCP proof secret. Connection-token requests include the exported protocol schema digest. Upgrade the control plane and runner together; re-pair old development credentials. This does not change the WebSocket `hcp.v0` envelope schema. See [pairing](pairing.md).

The native Codex/Claude drivers replace the old completion-only CLI paths. They reject `launch_args`, interactive policies, continuation, and second turns within a session. Claude also rejects restricted sandbox modes. `temporaryDirectoryRoot` is removed from Codex adapter options because final output files are no longer used. See [native provider support](native-providers.md) before updating a consumer. These restrictions replace previously ignored or unimplemented behavior; no compatibility fallback reruns work through the old drivers.

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

Current supported MCP attachment transports:

- `streamable_http`
- `runner_stdio_profile`, which references executable configuration owned by the local runner

Current unsupported transport from backend payloads:

- `stdio`

Backend-supplied stdio command/args are intentionally rejected. Named profile references may select local runner configuration, but cannot override command paths, args, environment, or working directory policy.

### Managed MCP review recovery

The runner retains modern URL elicitation without inventing a legacy `elicitationId`; responses bind to the pending request-map key. HTTP and HTTPS URLs are presented for user completion, followed by accept, decline or cancel. URL responses cannot contain form values. Both legacy and modern URL requests use the same persisted operation and deadline as form input. Sampling and roots input remain unsupported in the managed UI.

Codex managed MCP review uses the existing runner state file and standard HCP approval messages. The control plane must support exact-call grants and atomic child-effect claims before admitting review-required attachments. Other drivers do not inherit this capability.

Native probes passed against `codex-cli 0.153.4`, including process loss before a decision, after result persistence, and after native result insertion. The native item-list API omits injected response items. The adapter therefore checks the native-owned JSONL path returned by `thread/read` before inserting a saved result. It validates thread, call, arguments and result; partial, changed or oversized history fails closed. The disk path/format is an unstable native dependency that must be reverified on upgrades. Replace it when the native API provides equivalent idempotent insertion or complete response-item reads.

A dispatch-intent record without a saved result is unknown and never automatically retried. A saved result can resume the native model without another MCP call. Cancellation prevents native continuation even when an already dispatched result arrives. These probes use a local model and read-only callback fixture; they do not certify a deployed control-plane/HTTP/workflow integration.

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
