# HCP 0.4.7

Managed MCP operations preserve result metadata through SDK decoding and persisted input rounds. Concurrent responses cannot inherit another operation's metadata or deadline.

Delegated child review stays within the original retained parent operation. The reviewed child subject is bound into the approval action, while the parent's grant remains unchanged on the outer request. Decisions persist before continuation, and conflicting or duplicate decisions cannot dispatch another child call. The control plane must implement child authority and effect admission before emitting delegated review requests.

Modern and legacy URL elicitation use the pending request-map key without synthesizing protocol fields. The runner presents an HTTP/HTTPS URL and resumes accept, decline or cancel with no form values. Local HTTP SDK/native-bridge scenarios reach terminal output for all three decisions.

The optional delegated subject extends the review action contract; existing nondelegated actions and the `hcp.v0` wire envelope remain unchanged. All three packages use matching versions. Publication and application rollout are tracked separately from local validation.
