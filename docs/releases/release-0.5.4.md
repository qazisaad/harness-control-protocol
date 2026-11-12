# 0.5.4

Protocol, SDK and runner are released together at 0.5.4. The wire version remains `hcp.v0`. This release upgrades zod, which changes the generated JSON Schemas, so **`protocol_schema_sha256` changes**.

## Upgrade together

- `protocol_schema_sha256` is now `fa13e8e88b5a4aecf6ae0f3e6b042c32d154e98ffc20a8cd3df4596a715b4523`. A control plane that pins the digest admits only runners of the same schema, so move the control plane's pin and its runner install command to 0.5.4 in one release. Already paired runners keep their credentials; they only need to run the 0.5.4 runner.
- Timestamps must include seconds, for example `2026-01-01T00:00:00Z`. zod 4.4.3 also accepted `2026-01-01T00:00Z`. `Date.prototype.toISOString()` and Python's `datetime.isoformat()` already include seconds.
- Unions of plain JSON types are now written as `"type": [...]` instead of `anyOf`. They accept the same values.

## Security

- zod is upgraded from 4.4.3 to 4.6.7 in the protocol, runner and reference control plane. This fixes [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5): memory exhaustion while validating oversized constrained collections. `npm audit` reports no known vulnerabilities.
