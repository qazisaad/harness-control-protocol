# Workspace management

HCP can manage registered folders over the existing authenticated control-plane WebSocket. A registration gives a folder a stable workspace id and an optional display name. It never creates, clones, or deletes files.

## Enable on the machine

Stop the runner, then set the parent folders your organization may register in `runner.json`:

```json
{
  "workspace_management": {
    "allowed_roots": ["/absolute/path/to/projects"]
  }
}
```

Merge that field into the existing configuration, using real absolute paths on the runner machine. Restart with `hcp-runner run --config runner.json`. An absent policy or empty list disables remote writes. Root policy and provider authentication stay local; remote calls cannot broaden the roots. Stop the runner before editing the file manually. Routine workspace changes through HCP need no restart.

## Calls

Capabilities include `workspace_management: {revision, allowed_roots}`. Send `host.workspaces.request` with an envelope id and payload:

```json
{
  "expected_revision": "revision-from-latest-snapshot",
  "expires_at": "2026-09-11T12:00:30Z",
  "operation": {"kind": "add", "path": "/absolute/path/to/projects/repo", "display_name": "My repo"}
}
```

Choose an expiry in the near future. Other operations are `{"kind":"list"}`, `{"kind":"rename","id":"workspace-id","display_name":"New name"}`, and `{"kind":"remove","id":"workspace-id"}`. List is available when writes are disabled. Rename preserves the id and path. A different path requires a new registration and updating workflows that used the old id.

The runner returns `host.workspaces.result` with the originating `request_id`, an `outcome` of `{kind:"success"}` or `{kind:"error",message}`, `management`, and a **complete** `workspaces` snapshot. Only this complete result authorizes deletion of omitted registrations in a projection. Errors also contain the current snapshot. Capabilities are republished after handling the call.

The runner checks existing directories, resolves symlinks against allowed roots, rejects duplicate paths, and compares revisions before committing. Configuration updates and session starts share a serialization boundary. Updates are rejected while a session is active. Saved configuration uses atomic replacement and survives runner restart.

Control planes must restrict management to authorized administrators, bind dispatch and results to the authenticated connection, and expire queued requests. Send mutations once. If the connection drops or a result is lost, the outcome is uncertain: issue a fresh list request before deciding whether another mutation is needed. Do not blindly retry an add. Revisions change on every committed edit, and new registrations receive fresh ids.
