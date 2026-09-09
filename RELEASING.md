# Trunk release operations

This runbook covers the private Taproot → public Trunk → public npm boundary.
The current packages are `@taprootio/docs-artifact`,
`@taprootio/docs-publisher`, and `@taprootio/site-authoring`. They have
independent identities, manifests, tag prefixes, tests, sync Environments,
npm Environments, and publish workflows. Every later integration must preserve
the same isolation.

## Release ordering

1. Merge the reviewed package version and its public allowlist to private
   Taproot `main`. A pull request that changes a package's allowlisted files
   without raising its version fails the private CI.
2. That merge starts the private release workflow for every already-released
   package whose `docs-artifact-v<version>`, `docs-publisher-v<version>`, or
   `site-authoring-v<version>` tag does not exist in this repository yet. A
   package's first release is still created by hand with a private tag on
   the exact `main` commit once its bootstrap below is complete; that manual
   tag remains available for every package and runs the same verification.
   The automated path creates no private tag, since the private tag rulesets
   reserve creation for maintainers; the public commit here names the private
   source commit instead.
3. The private workflow verifies that the commit belongs to `main` and that
   the release names the declared version and pins, tests the package (first
   waiting for every declared pin to be on npm, so a dependent released in
   the same run as its sibling does not race that sibling's publish), stages
   its allowlisted public tree, and mints a short-lived GitHub App
   installation token.
4. The sync replaces only the selected owned package subtree, commits it to
   Trunk `main`, then pushes the branch and identical package tag in one atomic
   ref transaction. An existing tag is accepted only when that package subtree
   and the reviewed release scaffold have identical bytes.
5. The matching public workflow verifies that the public tag belongs to `main`,
   reruns package tests, rejects a version older than anything already on npm,
   and publishes from a GitHub-hosted runner with npm provenance. Both dependent
   packages validate exact dependency versions through the shared release guard;
   the expected pins live in the private release manifests and the private
   identity guard enforces them before exporting any package bytes.

The public workflows call shared release scripts inside their existing jobs.
Registry lookup, release ordering, integrity comparison, verified provenance, and
publication therefore have one implementation. Each package still owns its
workflow filename, tag trigger, Environment, permissions, concurrency identity,
package directory, required dependency names, and test commands. The npm token
is exposed only to the publish step; registry and test steps do not receive it.

This deliberately preserves the npm trust coordinates. npm binds GitHub trust to
repository, workflow filename, and configured Environment; GitHub reusable jobs
add a separate `job_workflow_ref` claim. A child script stays in the existing job
and inherits its OIDC runtime without introducing a reusable workflow identity.
Keep `id-token: write` on each publishing job and the empty `NODE_AUTH_TOKEN`
mapping after removing the bootstrap secret. This inference follows the
[npm trusted-publisher contract](https://docs.npmjs.com/trusted-publishers/) and
[GitHub reusable-workflow OIDC contract](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-with-reusable-workflows)
(checked 2026-09-09). Local tests cannot prove a future live OIDC publish.


Never publish npm first. The public commit and tag are the inspectable release
record to which provenance points. Except for the preserved failed
`docs-artifact-v1.0.0` bootstrap attempt documented below, do not merge a
package's next version bump, or create its tag by hand, until its preceding
version has completed both the Trunk sync and npm publish. The private
release and sync workflows share one `trunk-main-sync` concurrency queue so
Trunk `main` updates serialize, and the release workflow runs its packages one
after another for the same reason, while each package keeps its own npm
publish queue; GitHub still does not guarantee semantic ordering among
rapidly dispatched tags.

Release workflows pin third-party Actions to immutable commit SHAs and the npm
CLI to one exact reviewed version. Upgrade either only through a coordinated
Taproot and Trunk change that verifies the upstream tag-to-commit mapping,
updates both reviewed workflow copies, and reruns the public release tests.
The exact npm version pin still trusts the registry response and the bundled
npm client's TLS and integrity verification during the global install; it does
not independently pin the npm tarball's sha512. That residual registry trust is
explicitly accepted until the bootstrap install gains a separately reviewed
tarball-integrity check.

## One-time GitHub setup

1. Create `taprootio/trunk` as a public repository with `main` as the default
   branch. Do not import or mirror Taproot history.
2. In private Taproot, run
   `node scripts/stage-trunk-release.mjs <empty-directory>`, initialize that
   staged directory as a new repository, and push its single bootstrap commit to
   Trunk `main` only after the staged files have been reviewed.
3. Add a `main` branch ruleset that requires reviewed pull requests and the
   public `Public integration packages` check. Add separate tag rulesets
   targeting `docs-artifact-v*`, `docs-publisher-v*`, and `site-authoring-v*`,
   each with **Restrict creations**, **Restrict updates**, and **Restrict
   deletions** enabled. Grant bypass only to the release App described below,
   so an ordinary Trunk writer cannot create a tag that invokes any npm trusted
   publisher. Do not grant the App administration, secrets, workflows, or other
   repository permissions.
4. Create a private GitHub App for the `taprootio` organization with only
   **Repository contents: Read and write**. Install it only on `taprootio/trunk`.
5. In private `taprootio/taproot`, keep `trunk-docs-artifact-sync` restricted to
   protected `docs-artifact-v*` tags, `trunk-docs-publisher-sync` restricted to
   protected `docs-publisher-v*` tags, and create `trunk-site-authoring-sync`
   restricted to protected `site-authoring-v*` tags; allow the protected
   `main` branch on all three as well. The release-on-merge workflow calls the
   sync from `main`, and GitHub checks an Environment's deployment rules
   against the calling run's ref, so a tag-only Environment turns that run
   away before it can read the key. Each Environment uses the Environment
   secret `TRUNK_RELEASE_APP_PRIVATE_KEY` containing the complete App
   private-key PEM; repository variable `TRUNK_RELEASE_APP_ID` holds the App
   id. Do not store the private key as a repository or organization secret:
   only a sync job running from a protected tag or from `main` may mint the
   App token. The workflow stores no installation token;
   `actions/create-github-app-token` mints one per run.
6. In private `taprootio/taproot`, add matching `docs-artifact-v*`,
   `docs-publisher-v*`, and `site-authoring-v*` tag rulesets with **Restrict
   creations**, **Restrict updates**, and **Restrict deletions** enabled. Grant
   bypass only to trusted release maintainers. This prevents arbitrary tags from
   unlocking a sync Environment and prevents delete-and-retag recovery against
   different source.
7. In public Trunk, keep `npm-docs-artifact-publish` restricted to protected
   `docs-artifact-v*` tags, `npm-docs-publisher-publish` restricted to protected
   `docs-publisher-v*` tags, and create `npm-site-authoring-publish` restricted
   to protected `site-authoring-v*` tags. Add required reviewers if release
   policy calls for a human deployment approval.

GitHub App contents permission is repository-scoped rather than path-scoped.
The audited sync implementation stages and commits only the package path
selected by the reviewed release manifest; the App is installed on Trunk alone,
and branch/tag rules provide the repository-side backstop. Do not reuse this
credential from a different source repository.

The sync also requires every root scaffold file to match the reviewed private
Taproot copy byte-for-byte before it creates a release tag. Change a workflow or
root release document as a coordinated, reviewed PR in both repositories and do
not release between the two merges. The package sync never rewrites those root
files and will fail closed while they differ.

## First npm publishes

npm cannot configure a trusted publisher until the package exists. Bootstrap
`@taprootio/docs-artifact@1.0.1` once, then remove the credential. The immutable
`docs-artifact-v1.0.0` tag records the first bootstrap attempt, which failed in
package tests before npm publish because npm 12 changed the shape of
`npm pack --json` output. Version `1.0.0` is therefore intentionally absent from
the registry:

1. Confirm the `@taprootio` npm organization owns the scope. Public scoped
   packages do not require a paid npm plan.
2. Create a granular npm token limited to package creation/publish under the
   `@taprootio` scope. Add it as `NPM_TOKEN` in Trunk's
   `npm-docs-artifact-publish` Environment—not in private Taproot.
3. Merge the Taproot release work, then create private tag
   `docs-artifact-v1.0.1`. The public workflow publishes from Trunk with
   `--provenance` and the one-time token.
4. In npm package settings, configure the GitHub Actions trusted publisher:
   organization `taprootio`, repository `trunk`, workflow
   `publish-docs-artifact.yml`, Environment `npm-docs-artifact-publish`, allowed
   action `npm publish`.
5. Delete `NPM_TOKEN` from the Trunk Environment and revoke the token at npm.
   Steady-state releases authenticate only through short-lived OIDC and retain
   public provenance.

Bootstrap `@taprootio/docs-publisher` independently using the version and
artifact dependency on the **reviewed private main commit**. Do not reuse an old
version or tag copied from a historical task. At the 2026-09-09 readiness check,
that identity was publisher `1.1.0`, artifact `1.1.0`, and
`docs-publisher-v1.1.0`; derive it again at rollout.

1. Recheck npm and Trunk read-only. Only an authoritative npm E404 means absent;
   authentication, network, rate-limit, malformed-response and server failures
   stop the release. If a public tag or npm version now exists, use Recovery
   instead of bootstrapping again. Confirm the exact artifact dependency is
   already public. The private planner deliberately skips never-released packages.
2. Configure the missing controls by copying the working site-authoring pattern,
   substituting only the package-specific names:

   | Location | Required configuration |
   | --- | --- |
   | Private Taproot Environment | `trunk-docs-publisher-sync`; custom deployment policies: branch `main`, tag `docs-publisher-v*`; Environment secret `TRUNK_RELEASE_APP_PRIVATE_KEY` |
   | Private Taproot repository | Existing variable `TRUNK_RELEASE_APP_ID`; existing release App installed only on Trunk with contents read/write |
   | Private Taproot tag ruleset | Active; include `refs/tags/docs-publisher-v*`; restrict creation, updates, deletion and non-fast-forward changes; bypass only trusted release maintainers |
   | Public Trunk Environment | `npm-docs-publisher-publish`; custom deployment policy: tag `docs-publisher-v*` only |
   | Public Trunk tag ruleset | Active; same tag pattern and restrictions; bypass only the existing release App |
   | Public Trunk main ruleset | Keep required reviewed PR/check policy and release App bypass; required check is `Public integration packages` |

   Read back both Environments' deployment policies and all ruleset conditions,
   rule types and bypass actors. The working site-authoring Environments have no
   required deployment reviewer; adding one changes release-on-merge to approval.
   Never grant workflow/admin permission to the sync App or broaden its install.
   An authorized operator installs the existing App key through a secure path;
   never retrieve or print its value to copy it.
3. Prepare and review the exact public scaffold from the private candidate:

   ```bash
   node scripts/stage-trunk-release.mjs <empty-directory> \
     release/trunk/docs-publisher-release-manifest.json
   ```

   The staged tree contains root scaffold **and** publisher bytes. The coordinated
   public PR copies only files named by `repositoryFiles` in that manifest; it
   must not copy the package subtree, other package trees, private history, or
   private task records. Include new scripts and their tests as well as all
   workflow/runbook changes. Compare every listed file byte-for-byte against the
   reviewed candidate. Public CI permits the publisher's initial absence and
   rejects later removal. Keep that bootstrap boundary unchanged.
4. Coordinate the merges: pause package version merges/tags, merge the reviewed
   public scaffold PR first, then merge the matching private release preparation.
   While either side differs, syncs intentionally fail closed. Verify every
   scaffold byte again against both merged heads before releasing. The public PR
   itself does not publish npm; this private scaffold-only merge does not bump an
   existing package, and the planner still skips the new publisher.
5. Under separate authorization, issue a short-lived granular npm bootstrap token
   with the minimum permission that can create/publish `@taprootio/docs-publisher`
   under the owned scope, including CI-compatible 2FA bypass if npm requires it.
   A package that does not yet exist may require scope-level creation authority;
   do not claim an unavailable package-specific restriction. Grant no organization
   administration or unrelated-package access beyond that necessary creation
   authority. Store it only as `NPM_TOKEN` in `npm-docs-publisher-publish`, never in
   private Taproot. Remove and revoke it immediately after the bootstrap proof.
6. In a clean private checkout of the reviewed merged `main` revision, derive and
   verify identity without creating a tag:

   ```bash
   source_commit="$(git rev-parse HEAD)"
   release_manifest=release/trunk/docs-publisher-release-manifest.json
   release_tag="$(node --input-type=module -e '
     import { readFileSync } from "node:fs";
     const m = JSON.parse(readFileSync(process.argv[1], "utf8"));
     const p = JSON.parse(readFileSync(`${m.packageSource}/package.json`, "utf8"));
     console.log(`${m.tagPrefix}${p.version}`);
   ' "$release_manifest")"
   git merge-base --is-ancestor "$source_commit" origin/main
   node scripts/verify-trunk-release-identity.mjs "$release_tag" "$release_manifest"
   node scripts/wait-for-npm-versions.mjs "$release_manifest"
   ```

   Verify `origin/main` is freshly fetched and `source_commit` is the agreed
   reviewed revision, not simply whichever local checkout happened to be active.
   Then, with explicit approval for that exact tag push:

   ```bash
   git tag "$release_tag" "$source_commit"
   git push origin "refs/tags/$release_tag"
   ```

   The private sync exports only `packages/docs-publisher/`; it verifies the
   complete scaffold and atomically publishes Trunk main plus the same tag.
   The public job installs the exact artifact dependency, tests, and publishes
   with provenance. Wait for both runs; a green sync alone is not an npm release.
7. Record first-release proof before configuring a Docs site's consumer workflow:
   private source SHA and sync run URL; public tag and peeled commit SHA on main;
   successful public publish run URL; npm package name/version and exact dependency;
   `dist.integrity` equal to a local `npm pack --ignore-scripts` from that public
   tag; and a successful npm 12.0.2 signature audit with included attestations.
   Run the shared `npm-release-guard.mjs provenance` command against that audit
   with `https://github.com/taprootio/trunk`,
   `.github/workflows/publish-docs-publisher.yml`, the exact tag ref, and public SHA.
   Install the exact package in an empty temporary directory with lifecycle
   scripts disabled and run `taproot --help` without any site publishing key.
   Record the registry attestation URL and non-secret command results.
8. In npm settings configure organization `taprootio`, repository `trunk`,
   workflow filename `publish-docs-publisher.yml`, Environment
   `npm-docs-publisher-publish`, and allow direct `npm publish`. Read back that
   configuration, delete the Environment `NPM_TOKEN`, and revoke the bootstrap
   token at npm; record both operations without values. A same-version retry
   verifies integrity/provenance and skips publish, so it does **not** prove OIDC
   authentication. Prove token-free publishing on the next separately reviewed,
   authorized version release, with an explicit follow-up until it occurs.

Local release preparation alone does not make the package available or provision
a Docs site. Record the completed external rollout before configuring consumers.

Bootstrap `@taprootio/site-authoring@0.1.0` the same way. Its one dependency,
`@taprootio/espalier`, is already public, so nothing else has to be released
first:

1. Create a new one-time granular npm token limited to creation/publish of
   `@taprootio/site-authoring`, and add it only as `NPM_TOKEN` in
   `npm-site-authoring-publish`.
2. Before tagging, merge the reviewed public scaffold additions into Trunk
   `main` — `publish-site-authoring.yml`, the CI bootstrap boundary, the
   workspace test script, and this document — generated from private Taproot
   with:

   ```bash
   node scripts/stage-trunk-release.mjs <empty-directory> \
     release/trunk/site-authoring-release-manifest.json
   ```

   As above, copy only the root scaffold diff. Public CI skips the
   not-yet-present site-authoring test during the bootstrap interval and
   rejects any later subtree removal.
3. Create private tag `site-authoring-v0.1.0`. The private sync verifies the
   exact Espalier pin against the release manifest and exports only
   `packages/site-authoring/`; the public workflow installs that pin, runs the
   package tests (the ones that compare against private monorepo sources skip
   by name there), and publishes with provenance.
4. Configure npm's trusted publisher for organization `taprootio`, repository
   `trunk`, workflow `publish-site-authoring.yml`, Environment
   `npm-site-authoring-publish`, allowed action `npm publish`.
5. Delete `NPM_TOKEN` from that Environment and revoke the one-time token.
   Record the non-secret public commit/tag, package version, and provenance URL.

Record only the App id, variable/secret names, Environment name, npm trusted
publisher coordinates, public commit/tag, package version, and provenance URL.
Never copy token or private-key values into an issue, task, log, or repository.

## Recovery

- **Scaffold mismatch:** do not weaken the byte comparison or let the sync edit
  root files. Finish/review the coordinated public PR, read back every allowlisted
  byte, then rerun only the failed private release after diagnosis and approval.
- **Environment refused/missing credentials:** inspect the calling ref and
  deployment policies first. Private sync needs both main and its tag pattern;
  public npm needs only its tag pattern. Correct the precise missing control,
  without broadening credentials or exposing values, then authorize one retry.
- **Dependency absent:** publish the exact dependency first, then retry the
  dependent. The bounded wait fails rather than installing a range or local copy.
- **Registry/audit failure or integrity/provenance mismatch:** stop; do not treat
  the version as absent, bypass verification, or republish it. Diagnose the
  registry/network/configuration issue and require the same immutable evidence
  on retry. Audit mismatch needs investigation, not an automatic version bump.

- **Atomic Trunk push rejected:** neither the branch nor tag advances. Correct
  the branch/ruleset/network failure and rerun the private workflow.
- **Trunk `main` already has the candidate version but different package
  bytes:** stop. Restore the reviewed version bytes or bump the version; the
  sync will not overwrite a same-version tree even when its tag is missing.
- **Public tag exists; npm failed:** while that version remains the newest
  release, rerun the public workflow for its tag. If npm already contains the
  version, the workflow compares registry and local package integrity,
  cryptographically verifies its npm attestation, and succeeds only when the
  signed provenance names the same Trunk workflow, tag, and commit. Reruns of a
  superseded version intentionally fail the release-order guard. If the failure
  requires different bytes, preserve the immutable tag and bump the package
  version before releasing the correction.
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
