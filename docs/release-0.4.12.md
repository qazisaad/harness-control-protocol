# 0.4.12

Session starts accept optional native `instructions` (up to 131072 characters), separate from user task input. Codex sets developer instructions on both new and resumed threads and explicitly clears them when omitted. Claude appends them to its native system preset; changing instructions on a live conversation fails closed. OpenCode rejects supplied instructions before starting a runtime because its adapter does not implement this contract.

Protocol, SDK and runner must be upgraded together. Older strict parsers reject the new optional field. Schema generation, archive consumer checks and provider regressions verify the package contract; mock provider tests do not certify a live model execution.
