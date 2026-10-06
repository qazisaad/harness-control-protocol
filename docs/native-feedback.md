# Native feedback

An application can offer explicit feedback submission when its selected execution profile advertises `native_feedback`. This describes a live conversation owner, the supported classifications and whether diagnostics can be requested. It does not authorize automatic reporting.

```ts
const receipt = await host.submitNativeFeedback(sessionId, {
  classification: "bug",
  reason: "The user's report",
  include_diagnostics: false,
}, {id: appFeedbackCommandId});
```

The diagnostics choice is required. The request cannot supply native conversation IDs, arbitrary diagnostic file paths, tags or native RPC parameters. The runner resolves the owned retained conversation, validates its original provider configuration and live execution profile, and persists a dispatch fence before contacting the provider. Submission does not start a model turn or create another execution owner.

The result's `feedback_id` is the provider receipt. `diagnostics_requested` records the explicit choice; it does not assert which files the provider uploaded. A completed receipt can be replayed with the same command identity and parameters. A conflicting identity refuses. After a lost acknowledgement or a 30-second acknowledgement deadline, the retained submission remains unknown and cannot be automatically repeated, including after runner restart. Changing the command identity may submit another report and is a new application/user decision.

Codex 0.160.0's interactive profile currently implements the contract using the existing owned `feedback/upload` transport and classification `bug`. Claude and OpenCode do not advertise this extension. Feedback is optional for every provider and independent of history, background work and settings operations.

Validation uses a local native RPC fixture and public packed SDK/runner consumers. No real feedback or diagnostic upload is sent by the acceptance suite.
