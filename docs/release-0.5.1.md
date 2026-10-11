# 0.5.1

0.5.1 builds on the 0.5.0 migration candidate. It adds repository identity for registered workspaces, implements workspace preflight, advertises catalog-backed speed, context-window and ultracode options, and adds Claude additional permitted directories. Protocol, SDK and runner must be upgraded together with the consumer's generated schema; older strict parsers reject the new optional fields.

## Repository identity

`host.capabilities.updated` and `host.workspaces.result` workspaces may carry runner-observed `git` state: a credential-free `remote` (the `origin` remote, or the only remote), `root_commit` (the sorted first parentless commit reachable from `HEAD`), `branch`, `head_commit` and `dirty`. The operator-declared `git_remote` configuration field is unchanged and separate. Every field is optional; absence means unknown or not a repository, never clean or empty. Detection runs read-only git commands without a shell, hooks, prompts or credential helpers, with a five-second per-command bound. Folder browsing does not observe repositories.

`redactGitRemote` removes user info, query and fragment before a remote is published. `normalizeGitRemote` produces a comparison key so SSH, scp-like and HTTPS forms of one repository compare equal; consumers should use it rather than comparing URLs. A root commit identifies a repository across clones and machines even without a remote. Neither proves two checkouts have the same files.

## Workspace preflight

`workspace_preflight` on session start is now implemented instead of refused. It must name the session workspace. The runner observes the workspace before any native startup and refuses with `workspace_preflight_failed` when an expectation is not met:

- `expected_git_remote`: compared with `normalizeGitRemote`.
- `expected_root_commit` (new): exact repository identity.
- `expected_branch`: the current branch; detached `HEAD` does not match.
- `allow_dirty_worktree: false`: requires an observed clean worktree; unknown state fails.
- `required_paths`: relative paths that must exist inside the workspace after symlink resolution.

`workspace.preflight.completed` now reports the observed `branch`, `commit`, `root_commit` (new), `dirty` and `remote` for every session start, with or without expectations. A refused preflight starts no native process. Its evidence describes the workspace at session start, not later turns.

## Model options

- Codex: `serviceTier` is advertised from the native `model/list` `serviceTiers`, with `default` (Standard) plus each native tier such as `priority` (Fast). Selecting `default` clears the override. Effective readback is unchanged.
- Claude: `ultracode` is advertised when native settings report `ultracodeAvailable` and the model supports `xhigh` effort. Enabling it still requires the existing native readback.
- Claude: `contextWindow` (`default` | `1m`) is advertised for the Opus, Sonnet and Fable families, following Claude Code's own 1M aliases. `1m` selects the native `[1m]` model suffix. Interactive sessions confirm the effective suffixed model through settings readback when the owner opens and after a model change. Actual capacity is still reported by `context.updated` after a turn; a model that the API serves with a smaller window reports that measurement.
- Codex context window is not advertised. Its catalog publishes no window sizes, and `model_context_window` is thread-scoped with readback only after a model request.

## Claude additional permitted directories

The Claude interactive profile declares `sandbox_options: ["writable_roots"]` with the new profile field `writable_roots_enforcement: "native_permissions"`. Codex interactive declares `"os_sandbox"`. Roots still name authorized host workspaces and pass the same canonical containment, duplicate and symlink checks.

For Claude the roots become session-scoped `permissions.additionalDirectories` in the native flag settings layer. The runner opens the native owner before any input, confirms the exact directories in both the single flag layer and the effective settings, registers selected MCP servers and returns them in `native_policy_readback.sandbox_options`. Claude has no OS sandbox: roots extend its native permission scope only, the session remains `danger_full_access`, and the approval policy still governs prompts. `network_access` is refused for Claude. Roots bind the continuation and cannot change through resume or idle transitions.

## Runner connection setup

`hcp-runner connect` no longer prompts for agents in the terminal: it discovers installed agents, keeps saved choices, enables discovered agents (or exactly `--providers` when given) and leaves execution choices to the control plane. Saved credentials are verified with a connection-token request before reuse, and a rejected credential requests fresh pairing; network and storage failures never replace credentials. Workspace requests and capability snapshots are sent only on the socket that is still current, and accepting a connection never starts heartbeat or replay timers after the connection closed or reconnected while the snapshot was being prepared.

## Validation

Run `npm run release:check` after final source changes. Focused native acceptance for the changed paths: Claude directory readback and `[1m]` model readback against an installed authenticated CLI, Codex `model/list` service tiers against an installed CLI, and git preflight against real repositories. Mock tests do not certify native enforcement of permission directories.

Recorded on macOS arm64 (7 October 2026): `npm run release:check` passes with 854 runner tests and 3 opt-in native skips, 56 protocol tests, 264 conformance cases (124 valid, 140 invalid) and the packed independent consumers. `HCP_NATIVE_LIVE=1 HCP_LIVE_MODEL_TURN=1 node scripts/check-claude-directories-live.mjs` passes 5 checks against Claude Code 2.1.293: preflight of remote, root commit and clean worktree; native readback of the additional directory and 1M model before input; refusal of a different repository; refusal of network authority; and an authenticated turn writing in the additional directory under `auto_edits` without an approval prompt. Installed Codex 0.161.0 `model/list` advertises `serviceTier` (Standard, Fast/`priority`) on all 7 models, and the Claude catalog advertises `ultracode` and `contextWindow` per the rules above.

Consumer warm-session acceptance (8 October 2026, macOS arm64): `check-idle-transition-live.mjs` passes 8 checks each on Codex 0.161.0 and Claude Code 2.1.293 (writable and restricted policy transitions confirmed without a model turn, unchanged history, retained native context and ordinary resume). The Codex readback now also reports the default `approval_reviewer: "user"`; the script accepts it as the same policy. `check-claude-policy-control-live.mjs` passes its 8 in-place policy checks on Claude Code 2.1.293 when its 2.1.289 version pin is relaxed for the run; the pin itself is unchanged.
