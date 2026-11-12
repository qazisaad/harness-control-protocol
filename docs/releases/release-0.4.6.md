# HCP 0.4.6

Session stop uses the same lifecycle queue as session startup. If stop arrives while an MCP client connects or the harness adapter starts, cleanup waits for startup to finish and then closes the registered resources. This prevents a premature missing-session error from losing cleanup evidence.

The protocol schema is unchanged. All three packages retain matching versions for reproducible installation.

Validation: the full workspace build/tests and clean packaged-consumer checks pass, including startup cleanup failures, durable replay, MCP approval/resume, and terminal session exit. This release does not resolve historical unknown invocations without retained cleanup evidence.
