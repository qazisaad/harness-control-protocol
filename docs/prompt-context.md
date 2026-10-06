# Application-supplied conversation context

`harness.turn.send.context` and `harness.session.start.first_turn.context` accept a typed context packet:

```json
{
  "delivery": "prompt_context",
  "messages": [
    {"role": "user", "content": "An earlier request"},
    {"role": "assistant", "content": "An earlier answer"}
  ]
}
```

Use `execution_capabilities.prompt_context` to discover support. Codex, Claude Code and OpenCode declare this delivery. Custom adapters opt in with `promptContextInputs: true`. The packet allows at most 100 nonempty user/assistant messages, with a combined encoded JSON limit of 128 KiB. System and developer roles are excluded. HCP keeps the session's native system/developer instructions, approval policy, containment and background owners intact.

The manager prepares the context as an explicit application-supplied history description in the current user prompt. It does not manufacture earlier native turns. Native history injection remains the separately declared `native_history_injection` capability and revision-checked `inject` operation. Apps can choose native injection where available or prompt context for a handoff to a provider that lacks it.

`context.input.prepared` identifies the admitted HCP turn, app provenance, delivery, message count, encoded byte count and SHA-256 of the canonical role/content message array. It confirms preparation for dispatch; it does not certify that a model consumed the context or completed its turn. Use the native terminal result and, where needed, history/recall acceptance for that evidence. The event does not contain the supplied text. Context is included only when explicitly selected for that turn. Compaction rejects context packets.

Applications own the choice of source history, redaction, truncation and conversion of portable tool/result records into handoff text. Historical role labels carry no new instruction authority. Files remain independently selected scoped input references; changing providers requires uploading authorized bytes into the new provider's ownership scope. HCP does not permit another provider or conversation to adopt an old attachment reference.

`scripts/check-prompt-context-live.mjs` verifies first-prompt recall from typed handoff context, prepared-event provenance, native conversation recall after runner restart and absence of implicit reinjection. Set `HCP_NATIVE_LIVE=1` and choose `HCP_LIVE_PROVIDER=codex`, `claude` or `opencode` with an authenticated installation.
