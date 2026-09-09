# `@taprootio/docs-publisher`

The independently versioned command-line publisher for Taproot Docs. One
command validates a Docs artifact, creates or resolves its immutable source
release, uploads only missing bytes, waits for validation, stages the exact
release, promotes that exact staging output, and exits only after the production
pointer is acknowledged.

It publishes either of the two Docs publication modes. `managed` consumes the
semantic WTFM artifact that Taproot renders through its own shell. `prebuilt`
consumes a repository-built final site and preserves its declared bytes. The
mode is selected explicitly in the project configuration and is never inferred
from the artifact directory, the site, or a hostname.

This package is intentionally narrow. It is not part of
`@taprootio/docs-artifact`, does not contain a general Taproot API client, and
does not create a catch-all Trunk package.

## Install and invoke

First-party repositories pin the exact released CLI:

```bash
npm install --save-dev --save-exact @taprootio/docs-publisher@1.1.0
```

Then build the configured site and publish its exact artifact:

```bash
export TAPROOT_DOCS_PUBLISH_KEY='the one-time displayed site key'
npx --no-install taproot docs publish
```

`TAPROOT_DOCS_PUBLISH_KEY` must be an active `ExternalApiKey` whose product is
`taproot-docs-publish` and whose resource is the exact configured site. There is
no token flag, config field, browser login, or fallback credential lookup. In
GitHub Actions, put the value in the site-specific, `main`-restricted
Environment secret provisioned for the repository and pass it only to the
publish step.

```yaml
- name: Publish the exact Taproot Docs release
  run: npx --no-install taproot docs publish --quiet
  env:
    TAPROOT_DOCS_PUBLISH_KEY: ${{ secrets.TAPROOT_DOCS_PUBLISH_KEY }}
```

Keep `@taprootio/docs-publisher` in the repository lockfile at the exact
reviewed version and run the command only after that same job has built the
configured artifact directory. The command writes its structured result to the
runner-provided `GITHUB_OUTPUT` automatically.

## Project configuration

Commit `taproot-docs-publisher.json` at the repository root:

```json
{
  "configVersion": 1,
  "siteId": "11111111-1111-4111-8111-111111111111",
  "artifactDirectory": "_site"
}
```

`mode` is the optional publication-mode selector. It accepts exactly `"managed"`
or `"prebuilt"`; an absent field selects `"managed"`, and any other value fails
with `config.mode_invalid` before the key is attached to a request. A prebuilt
project sets it explicitly and points `artifactDirectory` at the built site:

```json
{
  "configVersion": 1,
  "siteId": "11111111-1111-4111-8111-111111111111",
  "artifactDirectory": "public",
  "mode": "prebuilt"
}
```

The artifact directory is relative to, and must resolve beneath, the real
configuration directory. Parent discovery is deliberately bounded and rejects
multiple matching configs; `--config path/to/taproot-docs-publisher.json`
selects one explicitly. Configs are small, closed JSON objects: unknown or
duplicate fields, links, traversal, unsupported versions, and noncanonical site
ids fail before the key is attached to a request.

Production defaults to `https://app.taproot.io/api`. Local development may add
`"apiBaseUrl": "https://app.taproot.test/api"`; explicit loopback `/api`
origins are also accepted. Arbitrary origins are rejected so a changed project
config cannot redirect the bearer key to another host.

## Compatibility contract

The v1 handshake is explicit and fail-closed:

| Surface                     | `mode: "managed"`                      | `mode: "prebuilt"`                       |
| --------------------------- | -------------------------------------- | ---------------------------------------- |
| Publisher package           | `@taprootio/docs-publisher@1.1.0`      | `@taprootio/docs-publisher@1.1.0`        |
| Publisher config            | `configVersion: 1`                     | `configVersion: 1`                       |
| Artifact package dependency | exact `@taprootio/docs-artifact@1.1.0` | exact `@taprootio/docs-artifact@1.1.0`   |
| Artifact manifest           | `taproot-docs-manifest.json`           | `taproot-docs-prebuilt-manifest.json`    |
| Artifact schema             | `schemaVersion: 1`                     | `schemaVersion: 1`                       |
| Upload archive              | `taproot-docs-tar-gzip-v1`             | `taproot-docs-prebuilt-tar-gzip-v1`      |
| Release `archiveFormat`     | `DOCS_ARCHIVE_FORMAT_TAPROOT_DOCS_TAR_GZIP_V1` | `DOCS_ARCHIVE_FORMAT_TAPROOT_DOCS_PREBUILT_TAR_GZIP_V1` |
| Release `mode`              | `DOCS_PUBLICATION_MODE_MANAGED`        | `DOCS_PUBLICATION_MODE_PREBUILT`         |

The two manifests, schemas, and containers are separate closed contracts. One is
never inferred from, or substituted for, the other: the selected mode and
archive format are both sent on the release intent, both are folded into the
release idempotency key, and both are re-checked against the server's echo. A
release echo that omits the mode is accepted only for managed, where the
omission is how a row or server that predates explicit mode identity reports
itself; a prebuilt release must always be stamped prebuilt.

In managed mode the publisher first invokes the exact package's hardened
directory validator. It then reads the canonical manifest and only its declared
managed files through bounded, no-follow file descriptors, checks path/file
identity after every read, and validates those exact snapshot bytes again.
Upload packaging never reopens the live artifact directory.

The managed archive contains only root `taproot-docs-manifest.json` plus
declared files below `taproot-docs/`. It uses sorted POSIX USTAR regular-file
entries, mode `0644`, zero uid/gid/mtime, exactly two terminating zero blocks,
and one gzip member with a fixed header, deterministic stored DEFLATE blocks,
CRC32, and no trailing data. The release SHA-256 and length cover those exact
compressed bytes. Paths that the closed USTAR name/prefix fields cannot
represent fail locally with `archive.path_unrepresentable`; PAX and GNU metadata
are never emitted.

In prebuilt mode the publisher delegates the whole read to the package's
prebuilt directory validator and the whole container to the package's
deterministic prebuilt archive writer, then applies Taproot's own 256 MiB
compressed-upload bound. Validation enumerates, reads, and re-verifies the
declared tree; it never imports a module, evaluates a script, renders a page, or
runs a build hook. Undeclared files, unsafe or ambiguous paths, size or hash
drift, and filesystem races fail locally before any release intent is sent. The
publisher never computes or sends a prebuilt manifest digest — Taproot's
validation worker records that itself.

## Idempotency and recovery

The CLI derives three separate, versioned idempotency keys:

- release identity from the site, the selected mode/archive-format pair, and the
  exact manifest source/build provenance;
- staging identity from the exact validated release;
- promotion identity from the exact completed staging deployment.

Consequently, two source builds with identical artifact bytes still create or
resolve their distinct source releases; only the redundant byte upload is
skipped. A managed and a prebuilt attempt for one source build can never share
a release intent. Retries after lost create, completion, stage, or promotion responses,
including unreadable or malformed successful response bodies, send the same
immutable intent. A whole-object PUT may be replayed, and
completion is authoritative after an ambiguous PUT response. The CLI replaces
an upload intent only after the server rejects replay through the stable
`RestartUploadIntentId` field (or its signed expiry is already reached). That
compare-and-swap restart names the exact current intent, and each CAS request is
sent once without generic retries. A committed lost response or concurrent
winner adopts the authoritative current intent; if reconciliation proves the
old intent still current, the same CAS may be attempted again within the
existing intent budget. Request counts, response bytes, upload intents, poll
intervals, and validation/deployment durations are all bounded. A validation or
deployment deadline also caps every in-flight poll request, its retries, and
its backoff rather than only the delay between reads.

Release control flow uses the public status enums, not human wording. A
`REJECTED`, failed deployment, response-contract mismatch, or timeout exits
nonzero. Success requires all of these exact identities to be terminal:

1. source release `VALIDATED` (or a later deployable `RETAINED` replay carrying
   its original `validatedAt` provenance);
2. staging deployment `COMPLETED` with an acknowledged `AVAILABLE` immutable
   output and pointer timestamp (an in-progress staging deployment may expose
   its `RESERVED` output);
3. production deployment `COMPLETED`, promoted from that staging deployment,
   pointing at the same immutable output sourced by that staging deployment,
   with its production pointer timestamp acknowledged.

## Output contract

Human progress goes to stderr. Stdout contains exactly one compact JSON object.
Successful output is schema version 1 and includes publisher/artifact
compatibility versions, the resolved publication `mode`, site id, artifact
hash/length and upload/reuse flags, the immutable release id, both deployment
ids, the shared output release id, and staging/production pointer versions.
`compatibility.archiveFormat` names the container that mode actually uploaded.
Failure output is also schema version 1 and contains a stable error code plus an
optional stable field/status; the process exits nonzero.

When `GITHUB_OUTPUT` names the existing Actions output file, the command appends
the same JSON through a random delimiter block named `taproot_docs_result` and
these scalar outputs:

| Output                                    | Value                                     |
| ----------------------------------------- | ----------------------------------------- |
| `taproot_docs_publication_mode`           | `managed` or `prebuilt`                   |
| `taproot_docs_release_id`                 | immutable source release id               |
| `taproot_docs_staging_deployment_id`      | staging deployment id                     |
| `taproot_docs_production_deployment_id`   | production deployment id                  |
| `taproot_docs_output_release_id`          | shared immutable output release id        |
| `taproot_docs_production_pointer_version` | acknowledged production pointer version   |

Tokens, Authorization values, signed upload URLs/headers, artifact contents, and
unrelated environment variables are never included in progress, diagnostics,
JSON, or Actions output. API response bodies are bounded, and server prose is
not used for retry decisions or emitted as a failure contract.

## Public release

Private Taproot is the source authority. A private
`docs-publisher-v<version>` tag verifies this package and its exact artifact
dependency, then allowlist-exports only `packages/docs-publisher/` to public
[`taprootio/trunk`](https://github.com/taprootio/trunk). Trunk's separate
`publish-docs-publisher.yml` workflow tests and publishes those exact public tag
bytes with npm trusted-publishing provenance. It has its own concurrency group,
GitHub Environment, tag prefix, npm identity, and immutable recovery checks;
it does not gain authority over the Docs artifact package.
