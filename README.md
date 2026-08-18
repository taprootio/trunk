# Taproot Trunk

Trunk is Taproot's public release monorepo for the independently versioned
packages and automation people use to integrate with the Taproot platform.
Its first two integrations are `@taprootio/docs-artifact` and the deliberately
narrow `@taprootio/docs-publisher` CLI. Future CI and development-environment
integrations join as separate packages with their own names, versions, tags,
tests, and release workflows.

There is intentionally no catch-all `@taprootio/trunk` package. “Trunk” names
the public release surface, not one dependency that couples unrelated tools.

## Packages

| Package | Purpose | Release tag |
| --- | --- | --- |
| `@taprootio/docs-artifact` | Canonical Taproot Docs schema, validator, serializer, fixtures, and conformance contract | `docs-artifact-v<version>` |
| `@taprootio/docs-publisher` | Site-scoped release validation, upload, staging, and production-promotion CLI | `docs-publisher-v<version>` |

## Source and release boundary

Taproot's private repository remains the source authority. Its release workflow
copies one explicit, reviewed package allowlist into its independently owned
`packages/docs-artifact/` or `packages/docs-publisher/` subtree using a
short-lived GitHub App installation token. One package release never replaces
the other package. The export never mirrors private git history, unrelated
source, secrets, dependency directories, or build output.

The public commit and immutable package tag exist before this repository's
workflow publishes to npm. npm provenance therefore names the public Trunk
repository and the exact public release commit rather than claiming that a
private source repository is publicly inspectable.

Each package contains its own license. No repository-wide license grants rights
to every current or future package merely because its release artifacts live in
Trunk.

See [RELEASING.md](./RELEASING.md) for provisioning, release, recovery, and the
rules for adding another integration.
