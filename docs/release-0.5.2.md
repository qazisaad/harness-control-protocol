# 0.5.2

Protocol, SDK, and runner are released together at 0.5.2. The wire version remains
`hcp.v0`.

The runner negotiates optional demand-driven connection control with the owning
application. When supported, it keeps a small credential-scoped Convex demand
subscription and closes its control WebSocket after five idle minutes. Workflow,
workspace, and configuration demand reconnects it. Active turns, pending commands,
and unresolved reviews prevent idle disconnect; an unavailable demand channel
falls back to the connected transport. Warm cached sessions and heartbeat traffic
do not keep execution compute awake. The application owns Fly machine lifecycle.

This release also includes the repository identity and workspace preflight work,
provider model/options updates, Claude permitted-directory fixes, and runner
ownership checks prepared alongside this change. See the 0.5.1 notes and native
provider documentation for those contracts. Existing servers can omit the new
pairing demand fields, preserving the runner's connected behavior.

P2A consumers must pin the matching package versions and regenerate their protocol
artifacts through their existing generators. Existing runner processes need to be
restarted on the new package before demand-driven idle behavior takes effect.
