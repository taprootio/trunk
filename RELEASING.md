# Trunk release operations

This runbook covers the private Taproot → public Trunk → public npm boundary.
The initial package is `@taprootio/docs-artifact`; every later integration keeps
an independent package identity and must add its own reviewed path manifest,
tag prefix, tests, and publish workflow.

## Release ordering

1. Merge the reviewed package version and public allowlist to private Taproot
   `main`.
2. Create `docs-artifact-v<version>` on that exact private `main` commit.
3. Taproot's `sync-docs-artifact-to-trunk.yml` verifies the tag, tests the
   package, stages the allowlisted public tree, and mints a short-lived GitHub
   App installation token.
4. The sync replaces only `packages/docs-artifact/`, commits it to Trunk `main`,
   then pushes the branch and identical `docs-artifact-v<version>` public tag in
   one atomic ref transaction. An existing tag is accepted only when that
   package subtree and the reviewed release scaffold have identical bytes.
5. Trunk's `publish-docs-artifact.yml` verifies that the public tag belongs to
   `main`, reruns tests and conformance, rejects a version older than anything
   already on npm, and publishes from a GitHub-hosted runner with npm
   provenance.

Never publish npm first. The public commit and tag are the inspectable release
record to which provenance points. Do not create the next private release tag
until the preceding version has completed both the Trunk sync and npm publish;
GitHub's concurrency queue prevents overlap but does not guarantee that rapidly
dispatched tags begin waiting in semantic-version order.

Release workflows pin third-party Actions to immutable commit SHAs and the npm
CLI to one exact reviewed version. Upgrade either only through a coordinated
Taproot and Trunk change that verifies the upstream tag-to-commit mapping,
updates both reviewed workflow copies, and reruns the public release tests.

## One-time GitHub setup

1. Create `taprootio/trunk` as a public repository with `main` as the default
   branch. Do not import or mirror Taproot history.
2. In private Taproot, run
   `node scripts/stage-trunk-release.mjs <empty-directory>`, initialize that
   staged directory as a new repository, and push its single bootstrap commit to
   Trunk `main` only after the staged files have been reviewed.
3. Add a `main` branch ruleset that requires reviewed pull requests and the
   public `Docs artifact` check. Add a separate tag ruleset targeting
   `docs-artifact-v*` with **Restrict creations**, **Restrict updates**, and
   **Restrict deletions** enabled. Grant bypass on both rulesets only to the
   release App described below, so an ordinary Trunk writer cannot create a tag
   that invokes npm's trusted publisher. Do not grant the App administration,
   secrets, workflows, or other repository permissions.
4. Create a private GitHub App for the `taprootio` organization with only
   **Repository contents: Read and write**. Install it only on `taprootio/trunk`.
5. In private `taprootio/taproot`, create the
   `trunk-docs-artifact-sync` Environment. Restrict it to protected
   `docs-artifact-v*` tags, set Environment secret
   `TRUNK_RELEASE_APP_PRIVATE_KEY` to the complete private-key PEM, and set
   repository variable `TRUNK_RELEASE_APP_ID` to the App ID. Do not store the
   private key as a repository or organization secret: only the protected-tag
   sync job may mint the App token. The workflow stores no installation token;
   `actions/create-github-app-token` mints one per run.
6. In private `taprootio/taproot`, add a tag ruleset targeting
   `docs-artifact-v*` with **Restrict creations**, **Restrict updates**, and
   **Restrict deletions** enabled. Grant bypass only to the trusted maintainers
   authorized to create releases. This prevents an arbitrary writer from
   creating a tag that unlocks the sync Environment, and prevents
   delete-and-retag from entering the release retry paths with a different
   source commit.
7. In public Trunk, create the `npm-docs-artifact-publish` Environment. Restrict
   it to protected `docs-artifact-v*` tags and add required reviewers if release
   policy calls for a human deployment approval.

GitHub App contents permission is repository-scoped rather than path-scoped.
The audited sync implementation stages and commits only
`packages/docs-artifact/`; the App is installed on Trunk alone, and branch/tag
rules provide the repository-side backstop. Do not reuse this credential from a
different source repository.

The sync also requires every root scaffold file to match the reviewed private
Taproot copy byte-for-byte before it creates a release tag. Change a workflow or
root release document as a coordinated, reviewed PR in both repositories and do
not release between the two merges. The package sync never rewrites those root
files and will fail closed while they differ.

## First npm publish

npm cannot configure a trusted publisher until the package exists. Bootstrap
`@taprootio/docs-artifact@1.0.0` once, then remove the credential:

1. Confirm the `@taprootio` npm organization owns the scope. Public scoped
   packages do not require a paid npm plan.
2. Create a granular npm token limited to package creation/publish under the
   `@taprootio` scope. Add it as `NPM_TOKEN` in Trunk's
   `npm-docs-artifact-publish` Environment—not in private Taproot.
3. Merge the Taproot release work, then create private tag
   `docs-artifact-v1.0.0`. The public workflow publishes from Trunk with
   `--provenance` and the one-time token.
4. In npm package settings, configure the GitHub Actions trusted publisher:
   organization `taprootio`, repository `trunk`, workflow
   `publish-docs-artifact.yml`, Environment `npm-docs-artifact-publish`, allowed
   action `npm publish`.
5. Delete `NPM_TOKEN` from the Trunk Environment and revoke the token at npm.
   Steady-state releases authenticate only through short-lived OIDC and retain
   public provenance.

Record only the App id, variable/secret names, Environment name, npm trusted
publisher coordinates, public commit/tag, package version, and provenance URL.
Never copy token or private-key values into an issue, task, log, or repository.

## Recovery

- **Atomic Trunk push rejected:** neither the branch nor tag advances. Correct
  the branch/ruleset/network failure and rerun the private workflow.
- **Trunk `main` already has the candidate version but different package
  bytes:** stop. Restore the reviewed version bytes or bump the version; the
  sync will not overwrite a same-version tree even when its tag is missing.
- **Public tag exists; npm failed:** rerun the public workflow for that tag. If
  npm already contains the version, the workflow compares registry and local
  package integrity, cryptographically verifies its npm attestation, and
  succeeds only when the signed provenance names the same Trunk workflow, tag,
  and commit.
- **Existing public tag has different package bytes:** stop and bump the package
  version. Tags and npm versions are immutable.
- **Public package path changed without a version bump:** reject the release;
  restore the released bytes or choose a new version.
- **App key compromise:** revoke the key, generate a replacement, update only
  `TRUNK_RELEASE_APP_PRIVATE_KEY`, and audit Trunk branch/tag history before the
  next release.

## Adding an integration

Add a new package directory instead of widening an existing package. Define its
owned public path, explicit file allowlist, unique tag prefix, package-level
license, tests, and a publish workflow with its own npm Environment/trusted
publisher entry. Extend the private exporter so one release stages and commits
only that package path. Do not create an `@taprootio/trunk` umbrella package and
do not let a package release replace the whole public working tree.
