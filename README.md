# Taproot Trunk

Trunk is Taproot's public release monorepo for the independently versioned
packages and automation people use to integrate with the Taproot platform.
Its integrations are `@taprootio/docs-artifact`, the deliberately narrow
`@taprootio/docs-publisher` CLI, the `@taprootio/site-authoring` CLI, and
`@taprootio/integration-sdk`. The versioned reference template is published at
`templates/integration-reference/`; it is source to copy and deploy, never an
npm package. Future integrations join as separately owned release trees with
their own names, versions, tags, tests, and release workflows where npm is in
scope.

There is intentionally no catch-all `@taprootio/trunk` package. “Trunk” names
the public release surface, not one dependency that couples unrelated tools.

## Packages

| Package | Purpose | Release tag |
| --- | --- | --- |
| `@taprootio/docs-artifact` | Canonical Taproot Docs schema, validator, serializer, fixtures, and conformance contract | `docs-artifact-v<version>` |
| `@taprootio/docs-publisher` | Site-scoped release validation, upload, staging, and production-promotion CLI | `docs-publisher-v<version>` |
| `@taprootio/site-authoring` | Browser-authorized site authoring CLI: pull, validate, push, preview, approve, and deploy one site | `site-authoring-v<version>` |
| `@taprootio/integration-sdk` | Typed integration manifest, webhook, handoff, content-client, and fragment helper contract | `integration-sdk-v<version>` |

## Reference template

`templates/integration-reference/` is a versioned, independently owned public
tree for a deployable integration service. Its release tag is
`integration-reference-v<version>`. It consumes an exact released SDK from
npm, and it never imports Taproot's private source, cluster, fixture controls,
or credentials. The template's tag proves the source bytes; it has no npm
publish workflow or trusted-publisher identity.

## Source and release boundary

Taproot's private repository remains the source authority. Its release workflow
copies one explicit, reviewed allowlist into its independently owned package or
template subtree using a short-lived GitHub App installation token. A package
release never replaces another package, and the reference-template release
never replaces a package tree. The export never mirrors private git history,
unrelated source, secrets, dependency directories, or build output.

For npm packages, the public commit and immutable package tag exist before this
repository's workflow publishes to npm. npm provenance therefore names the
public Trunk repository and the exact public release commit rather than
claiming that a private source repository is publicly inspectable.

Each package contains its own license. No repository-wide license grants rights
to every current or future package merely because its release artifacts live in
Trunk.

See [RELEASING.md](./RELEASING.md) for provisioning, release, recovery, and the
rules for adding another integration.
