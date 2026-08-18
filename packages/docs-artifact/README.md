# `@taprootio/docs-artifact`

The canonical, independently versioned contract between documentation producers
and Taproot Docs consumers. Version 1.1 adds a separate prebuilt contract without
changing or reinterpreting the released managed schema v1 contract. The public
npm package contains the authorities that must move together:

- `schema/taproot-docs-manifest.schema.json` for the structural v1 shape;
- the validator and deterministic serializer exported from the package root;
- the Node directory validator and `taproot-docs-validate` command;
- valid and adversarial fixtures exposed by `@taprootio/docs-artifact/conformance`.

Prebuilt mode has its own `schema/taproot-docs-prebuilt-manifest.schema.json`,
`@taprootio/docs-artifact/prebuilt` validator and serializer,
`@taprootio/docs-artifact/prebuilt/node` directory validator, and
`@taprootio/docs-artifact/prebuilt/archive` deterministic encoder, and
`@taprootio/docs-artifact/prebuilt/conformance` cases and golden vector.
Consumers select one entry point and one manifest filename explicitly; they
never infer a mode from fields or archive contents.

Each producer and consumer pins the exact package release for its selected
contract. Managed artifacts produced under `1.0.1` remain valid and unchanged;
prebuilt producers and consumers pin `1.1.0`. No repository copies the schema,
path rules, markup allow-list, limits, or fixture data.

## Prebuilt Docs contract

Prebuilt mode is a Docs publication mode for repository-built static output,
not a general static-hosting product. Its root is
`taproot-docs-prebuilt-manifest.json`, `schemaVersion` is `1`, `mode` is
`prebuilt`, and its required capability is
`taproot.docs.prebuilt.files.v1`. The closed manifest contains only immutable
GitHub source/build provenance, capabilities, `notFoundFile`, exact `files`,
stable `resources`, and direct `redirects`. It has no response headers, cache
directives, CSP fragments, routes table, origin allowlist, or executable hook.

Every payload file has one ASCII relative POSIX path, exact media type, byte
length, and `sha256:<64 lowercase hex>` digest. Paths use portable filename
segments whose first character is a letter, digit, `-`, or `_` and whose last
character is a letter or digit. They reject absolute paths, backslashes,
percent escapes, controls, empty or dot segments, Windows device aliases, and
the manifest name, and must fit both the 255-byte/64-directory envelope and
POSIX USTAR's 100-byte name plus 155-byte prefix fields. Exact and
ASCII-case-folded duplicates fail closed.
The complete directory is closed: every declared file must be a regular file,
and every other file, empty/unneeded directory, link, socket, FIFO, or device is
rejected.

The authenticated platform control route
`/__taproot/internal/published-site-routing` is matched first and is the only
reserved request route in the prebuilt file namespace. The edge then resolves
the exact host, site, environment, immutable output pointer, and publication
mode before applying public `/api/*` behavior. Managed mode retains the Taproot
API proxy. Prebuilt files and redirects own the complete remaining namespace,
including `/api/*`, and never fall through to that proxy.

Within the prebuilt namespace, the file tree is the request router.
`index.html` maps to `/`, `x/index.html` maps to `/x/`, and every other file
maps to its exact `/<path>`. Redirects resolve before file lookup, map one
canonical source directly to a stable resource key, and permit only status 301
or 308. A redirect source may not collide, including after ASCII case-folding,
with another redirect or a file route. `notFoundFile` is exactly `404.html` and
must be declared as `text/html; charset=utf-8`.

Resources contain exactly a durable `key`, one declared UTF-8 HTML `file`, and
its current display `title`. Two keys cannot claim one file, and the 404 cannot
be a successful-response resource. At publication, Taproot attaches the
resulting `SiteResource` id as origin object metadata for mapped HTML. Eligible
unmapped HTML is an explicit path-only analytics bucket. HTML 200 analytics stay
cookie-free and no browser analytics script is injected.

Taproot preserves every declared payload byte and publisher path. It owns and
may attach `Content-Type`, cache policy, CSP, framing, MIME-sniffing, referrer,
permissions, staging authorization/noindex, range, and content-encoding
behavior; publisher fields cannot override them. Every prebuilt response gets
this exact v1 policy, including HTML, the canonical 404, redirects, JavaScript
and worker scripts, WebAssembly, directly navigated SVG documents, and all
other assets:

```text
default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; form-action 'self'; worker-src 'self'; manifest-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'
```

`'wasm-unsafe-eval'` permits the accepted same-origin Pagefind Wasm runtime
without permitting string evaluation through `'unsafe-eval'`. V1 has no
publisher-supplied origin allowlist or per-response relaxation.

The archive identifier is the distinct
`taproot-docs-prebuilt-tar-gzip-v1`. Its deterministic bytes contain the
canonical manifest first and the exact payload snapshots in lexicographic path
order. Each entry is a regular POSIX USTAR record with paths of at most 100
bytes stored entirely in the name field; longer paths split at the rightmost
slash that fits the 155-byte prefix and 100-byte name fields. Records use mode
`0000644`; zero uid/gid/mtime/devmajor/devminor numeric fields; typeflag `0`;
magic `ustar\0`; version `00`; empty owner/group names; six-octal-digit,
NUL-space checksum; zero content padding; and exactly two zero terminator
blocks. One gzip member
uses header bytes `1f 8b 08 00 00 00 00 00 00 ff`; every non-final stored
DEFLATE block is exactly 65,535 bytes and the final block holds the remaining
1–65,535 bytes. The trailer contains the tar CRC-32 and low 32 bits of its byte
length. The committed representative archive and its byte length/SHA-256 are
the compatibility vector; platform `tar` or `gzip` output is not a substitute.
The separate platform upload ceiling remains 256 MiB compressed; conformance
under the artifact contract does not imply that an upload fits that independent
limit.

Public prebuilt ceilings are 8 MiB canonical manifest bytes, 25,000 files,
512 MiB declared/actual uncompressed bytes, 64 MiB per file, 25,000 resources,
10,000 redirects, 255 path bytes, and 64 directory levels. Object inputs retain
the package's bounded 250,000-value/64-level work envelope, and diagnostics use
the same stable bounded/sorted error contract as managed mode. Filesystem walks
retain the existing 40,000-entry work ceiling. The Node validator opens files
once with nonblocking/no-follow semantics, verifies the
descriptor and every path component before and after reads, repeats the closed
tree walk, and rejects identity, size, type, or ancestor races. Validation never
executes or parses customer HTML, CSS, JavaScript, WebAssembly, Pagefind data,
or SVG.

Ordinary prebuilt output may execute only on separately verified customer
production and staging hostnames. The only first-party platform-host exception
is the closed Espalier tuple: hosts `espalier.taproot.io` and
`espalier.taproot.test`, GitHub repository id `934883082` with locator
`taprootio/taproot-controls`, and `refs/heads/main`. Product ingestion must
enforce that complete tuple before serving executable prebuilt bytes beneath
`taproot.io` or `taproot.test`. WTFM remains managed.

## Artifact layout and portability

The remainder of this document describes the unchanged managed schema-v1
contract.

The producer writes this additive payload into its ordinary static output:

```text
_site/
├── index.html                         ordinary portable static site
├── ...                                ordinary CSS, JS, pages, and assets
├── taproot-docs-manifest.json         semantic contract entry point
└── taproot-docs/
    ├── fragments/                     manifest-listed semantic HTML only
    └── assets/                        manifest-listed safe raster images only
```

Taproot packages and validates the manifest plus exactly the files it lists. It
does not ingest, scrape, or execute the ordinary final HTML, CSS, or JavaScript.
`validateArtifactDirectory()` deliberately ignores unlisted files outside the
semantic payload, so the complete build remains deployable to any normal static
host. It enumerates the entire `taproot-docs/` subtree and rejects undeclared
files, symbolic links, and unsupported filesystem entry types there. A publisher
creating the Taproot upload must include only the manifest and listed semantic
files; `validateArtifact()` likewise rejects unexpected entries in that managed
subset.

## Identity and document model

`resources[].key` is the durable, locale-independent document identity. It is a
producer-assigned lowercase logical key such as `guide:getting-started` or
`reference:esp-button`. It must not be derived again from `route`, `title`, or
array position. A route or title can change while the key remains fixed, which
lets Taproot preserve analytics and future feedback identity.

Each resource has:

- semantic kind, audience, and tags;
- one or more locale variants, including the declared default locale;
- a canonical route, title, description, ordered heading inventory, and source
  location for each locale;
- one body fragment plus optional example or aside fragments, all carrying
  exact UTF-8 byte counts and SHA-256 hashes.

Navigation is localized and references resource keys rather than routes.
Redirects map a canonical old route directly to a resource key and locale, so
the target is always a current resource variant rather than another redirect.
This excludes redirect chains and loops by construction. Assets have their own
stable keys, paths, exact byte counts, hashes, media types, and dimensions.

Repository provenance uses GitHub's stable repository id as authority and keeps
the owner/name locator for humans. The exact revision, ref, producer/version,
configuration hash, and `sourceDateEpoch` make build inputs inspectable without
introducing a wall-clock value that changes identical output.

## Compatibility policy

The manifest `schemaVersion` is the wire-format major and v1 consumers accept
only `1`. Unknown schema versions fail closed. Within v1:

- additive behavior is advertised through `capabilities`;
- an unknown required capability fails validation;
- an unknown optional capability may be ignored, but it does not authorize
  unknown fields, markup, media, or files—the closed v1 schema still applies;
- `taproot.docs.fragments.html.v1` is required by every v1 artifact.

The npm package uses semantic versioning independently of `schemaVersion`:

- a package major changes the JavaScript API, compatibility policy, or supported
  manifest major;
- a package minor adds a backward-compatible validator entry point, understood
  optional capability, or conformance case for an already supported manifest
  major;
- a package patch fixes implementation, diagnostics, or documented security
  enforcement. A patch may reject an input that never conformed to the stated
  fail-closed rules.

Producer and consumer release PRs coordinate each selected contract's exact
dependency pin. The
private Taproot `docs-artifact-v<package-version>` tag does not publish npm
directly. It verifies and copies the reviewed package allowlist into
`packages/docs-artifact/` in public
[`taprootio/trunk`](https://github.com/taprootio/trunk), commits it, and creates
the matching public tag. Trunk's `publish-docs-artifact.yml` then requires that
tag to equal `package.json` and belong to public `main` before publishing from a
GitHub-hosted runner. npm provenance therefore resolves to the exact public
Trunk release rather than to private Taproot.

The public publish job binds the `npm-docs-artifact-publish` GitHub Environment.
The first registry publish is `1.0.1` and uses a one-time granular `NPM_TOKEN`
because npm cannot configure a trusted publisher before a package exists. The
immutable `1.0.0` Trunk tag records a bootstrap attempt that failed in package
tests before npm publish, so that version is intentionally absent from the
registry. Administrators then
configure the trusted publisher for `taprootio/trunk`, workflow
`publish-docs-artifact.yml`, and that Environment, and delete the bootstrap
token. Steady-state releases use short-lived OIDC only. The complete setup and
recovery procedure lives in Trunk's `RELEASING.md`; the private scaffold is
maintained under `release/trunk/public-repo/`.

## Determinism

`serializeManifest()` validates first, recursively sorts object keys, emits two-
space JSON, and adds one final newline. Producers also must use these deterministic
array orders, which validation enforces:

- capabilities, locales, resources, resource locale variants, semantic audience
  and tag lists, navigation locale sets, redirects, and assets are sorted by
  JavaScript UTF-16 code-unit order (the locale-independent ordering used by
  string relational comparison and `Array.prototype.sort()` without a
  comparator);
- headings, fragments, and navigation nodes preserve their semantic document
  order.

Paths are NFC-normalized, lowercase, relative POSIX paths. Percent escapes,
backslashes, controls, leading slashes, empty segments, and dot segments are
rejected rather than normalized silently. Every managed path segment also
rejects Windows device aliases (`con`, `prn`, `aux`, `nul`, `com1`–`com9`, and
`lpt1`–`lpt9`), including aliases followed by a file extension. The same
portable device-name rule applies to every route segment. Routes are lowercase
root-relative directory URLs with one trailing slash. Taproot shell path
prefixes including `/.well-known/`, `/_taproot/`, `/api/`, `/assets/`,
`/bust/`, `/pagefind/`, `/public/`, and `/taproot-docs/` are reserved. The
exact `/404/` route is also reserved. Root file routes
(`/404.html/`, `/favicon.ico/`, `/index.html/`, `/manifest.webmanifest/`,
`/robots.txt/`, `/sitemap.xml/`, and
`/taproot-docs-manifest.json/`) reserve their complete first-segment subtree so
a route cannot turn a published root file into a directory.

Manifest string bounds count Unicode scalar values, matching JSON Schema
`minLength` and `maxLength`; astral characters count once rather than as two
UTF-16 code units. The 2 MiB manifest ceiling applies both to supplied JSON bytes
and to the canonical UTF-8 serialization of an object input. A manifest that
cannot be serialized within that bound is not v1-conforming. Raw string input is
rejected first by a conservative UTF-16 length bound, then by an exact bounded
UTF-8 count, before the validator allocates its encoded bytes. Object input is
preflighted with cycle, depth, and traversal-work bounds; repeated references
count every serialized occurrence without retraversing the shared object. That
same traversal reads each own JSON property once and materializes a
null-prototype snapshot. Schema validation, canonical measurement,
serialization, artifact validation, and returned values use only that snapshot,
so accessors and Proxies cannot change a manifest between validation stages.
Uint8Array manifests and binary file entries are measured and copied through
their built-in internal slots; shadowed `byteLength` properties and caller
iterators are never treated as byte authority. ArrayBuffer and Uint8Array byte
lengths are checked against the manifest ceiling before a private snapshot is
allocated. Genuine Uint8Array and ArrayBuffer values from another JavaScript
realm are accepted; proxies, `Symbol.toStringTag` lookalikes, detached buffers,
and shared buffers fail closed.

`build.producerVersion` is SemVer 2.0. Numeric prerelease identifiers do not
permit leading zeroes (`1.0.0-0` and `1.0.0-alpha.1` are valid;
`1.0.0-01` is not). Numeric build identifiers may retain leading zeroes.

Duplicate resource keys, locale variants, routes, redirect sources, asset keys,
heading ids, fragment keys, declared file paths, navigation references, JSON
object keys, and supplied file entries fail deterministically. Diagnostics are
sorted by path, code, and message using locale-independent string ordering.
Diagnostic paths and messages are NFC-normalized, escape C0/C1 and bidirectional
formatting controls, and are bounded by exported scalar and UTF-8 byte ceilings
before they are returned or included in a thrown validation error.

All manifest string values and all decoded markup attribute values reject C0,
C1, and bidirectional formatting/override controls. These checks use the same
pinned code-point ranges in both validators, including when an allowed HTML
entity decodes into the inspected attribute value.

Docs v1 also pins a deterministic, registry-independent BCP 47 subset instead
of asking the host's ICU database to decide locale validity. A supported tag
contains a lowercase two- or three-letter language, an optional title-case
four-letter Script subtag, and an optional uppercase two-letter or three-digit
region subtag: for example `en`, `en-US`, `fr-FR`, `zh-Hant`, `es-419`, or
`abc-Latn-419`. Variants, extensions, private-use tags, grandfathered tags, and
other casing are outside v1. The JSON Schema uses this same grammar and length
ceiling as the runtime manifest and markup `lang` validators.

## Content and resource bounds

The exported `LIMITS` object is the v1 ceiling. Important bounds are:

| Input                                        |                          Maximum |
| -------------------------------------------- | -------------------------------: |
| Manifest                                     |                            2 MiB |
| Object-manifest traversal / nesting depth    |              250,000 values / 64 |
| Managed semantic bytes                       |                          256 MiB |
| Listed semantic files                        |                           20,000 |
| Managed filesystem entries                   |                           40,000 |
| Managed directory depth                      |                               32 |
| Managed relative path                        |                   512 characters |
| Resources                                    |                           10,000 |
| Locale variants                              |                           20,000 |
| Fragments                                    |                           20,000 |
| Assets                                       |                           10,000 |
| Redirects                                    |                           10,000 |
| Navigation nodes / depth                     |                      20,000 / 12 |
| Markup elements / nesting depth per fragment |                    100,000 / 128 |
| One fragment                                 |                            2 MiB |
| One asset                                    |                           25 MiB |
| Decoded image canvas                         |                67,108,864 pixels |
| Cumulative decoded animated frames           |                67,108,864 pixels |
| Animated image frames                        |                            1,000 |
| Consumer-supported capabilities              | 100 entries, 200 characters each |

Navigation depth counts each top-level item as level one. A leaf at level 12 is
valid; a child node at level 13 is rejected, while the global node ceiling still
counts nodes across every locale and nested array.

In-memory artifact validation charges every inspected declared entry's actual
UTF-8 or binary length to the aggregate budget before per-file size-drift
handling. String content is checked for well-formed UTF-16 while its UTF-8 bytes
are counted in the same bounded pass; scanning stops as soon as the remaining
aggregate budget is exceeded. File iteration and all later hashing or media
parsing stop at that point.

Consumers may impose smaller product or license limits but may not reinterpret a
larger input as v1-conforming. Archive compression expansion, entry type, and
physical-storage quotas remain additional ingestion-boundary checks; the Node
directory validator already rejects symbolic links and non-regular entries
anywhere below the managed subtree. It collects only the remaining entry budget
plus one, then walks entries in canonical name order; an over-budget tree returns
only its deterministic limit diagnostic. Managed files are opened once in
nonblocking mode without following a final symbolic link, checked by `stat`
against the descriptor's exact declared byte count before allocation, and read
through that handle under one cumulative 256 MiB budget. Nonblocking opens make
an enumerated-file-to-FIFO race fail type validation instead of waiting for a
writer. Files are rejected if their identity or size changes during the read.
After each read, the validator re-lstats every path component,
re-resolves the final path beneath the artifact root's original real path, and
requires the resolved regular file to retain the opened handle's device and
inode. Replacing either the file or one of its ancestors with a symbolic link is
therefore rejected even if it races the handle read. Before success, the same
bounded managed-subtree enumeration is repeated and its relative path/type set
must match the original walk.

The Node directory API snapshots `supportedCapabilities` once, with the
exported entry ceiling, before reading the artifact. Arrays, sets, and one-shot
generator objects are safe to pass and are not revisited by the manifest and
artifact validation phases; a scalar string is not a capability collection.
Every supplied value must be a primitive canonical capability/resource-key
string no longer than 200 Unicode scalar values. Invalid collections, values,
and iterator failures produce bounded generic diagnostics.

## Supported semantic HTML

Fragments are exact `text/html; charset=utf-8` bytes and use a small semantic
allow-list: headings `h2`–`h6`, paragraphs, lists, tables, figures, details,
code/preformatted text, common inline semantics, links, and images. The validator
rejects comments, declarations, custom elements, forms, scripts, styles, iframes,
event attributes, inline styles, classes, unquoted attributes, malformed nesting,
browser-reparenting content models, raw whitespace before tag names, and unknown
markup. HTML syntax recognizes only tab, line feed, form feed, carriage return,
and space as whitespace; other Unicode whitespace remains content or is rejected
where browsers do not treat it as syntax whitespace.

Entities are deliberately narrower than the full browser named-entity table.
Only semicolon-terminated `amp`, `apos`, `colon`, `gt`, `lt`, and `quot` named
references plus scalar numeric references are accepted. Raw or semicolonless
ampersands, unknown names, and numeric references that browsers replace or map
through control-character rules fail closed. Literal U+0000 text fails with
`markup.invalid_null`, matching the fail-closed handling of nulls in attributes
and numeric references. Element count and open-element
nesting stop immediately at the exported v1 ceilings above.

Internal links use `data-resource-key` plus optional `data-heading-id`; same-page
links may use `href="#heading-id"`; external links are credential-free HTTPS.
Images use `data-asset-key` and required `alt` text rather than `src`. Only GIF,
JPEG, PNG, and WebP assets are accepted, and bytes must match the declared
complete container structure, dimensions, size, and SHA-256. Validation walks
bounded container records and framing but does not decode pixels. GIF, JPEG,
PNG/APNG, and WebP canvas headers must remain within the decoded-pixel ceiling;
declared asset width multiplied by height is subject to the same runtime
ceiling. JSON Schema mirrors each dimension's maximum and documents this
cross-field product, which JSON Schema cannot express exactly. GIF, APNG, and
animated WebP frame records must remain within the animation-frame ceiling.
The sum of decoded frame rectangles in one GIF, APNG, or animated WebP must
also remain within the cumulative decoded-animation-pixel ceiling.
GIF frames require a valid global or local color table. Graphic Control,
Application, Plain Text, and Comment extensions follow their label-specific
block grammar; unknown extension labels and reserved packed-field bits fail
closed. PNG chunk types contain only ASCII letters with an uppercase reserved
third byte, and every IDAT chunk (including an empty one) belongs to one
contiguous run. PNG palette presence, entry count, and placement follow the
IHDR color type and bit depth. APNG frame controls and data use one gapless
sequence, valid dispose/blend operations, correct IDAT/fdAT ownership, and a
completed-frame count matching acTL. JPEG assets are complete baseline Huffman
interchange streams from SOI through EOI: referenced quantization and Huffman
tables, frame and scan component declarations, and entropy/restart framing are
validated. A referenced quantization table may appear before or after SOF0 but
must be defined before its component's SOS is accepted. Complete baseline
sequential images may use one interleaved scan or multiple scans; every frame
component must appear exactly once across them. DQT, DHT, DRI, COM, and APP
metadata may appear between scans, and each scan independently validates table
references, sequential spectral fields, restart cardinality, and entropy
framing. Baseline quantization tables contain 64 nonzero 8-bit coefficients;
Huffman tables have at most 256 baseline-valid symbols and never exhaust prefix
space, leaving the forbidden all-ones terminal code unused. Component sampling
products total at most 10. Entropy byte stuffing is exactly `FF 00`; repeated
`FF` bytes are fill only before a nonzero marker. A DRI scan contains exactly
`floor((MCUs - 1) / interval)` ordered restart markers, and every marker
separates nonempty entropy partitions. Progressive, arithmetic-coded, and
otherwise non-baseline streams fail closed.
Animated WebP frame rectangles use the format's doubled x/y units, must stay
within the VP8X canvas, must leave reserved flag bits clear, and must match the
dimensions of their embedded VP8 or VP8L image. WebP chunks with odd payload
lengths require a present zero pad byte. VP8X is first and unique for extended
files. Its ICC, alpha, Exif, XMP, and animation feature bits must exactly match
the chunks and decoded VP8L alpha-used headers observed in the container. The
canonical extended order is VP8X, optional unique ICCP, one still reconstruction
(ALPH immediately followed by VP8, or VP8L) or one animation reconstruction
(ANIM followed by a contiguous ANMF run), then optional unique EXIF and XMP
chunks in that order. Still and animated reconstruction are exclusive. An ANMF
payload is exactly one VP8L chunk or an optional ALPH followed by one VP8 chunk;
nested alpha observations are accumulated across all frames. VP8 keyframe tags
must describe a displayed, non-experimental frame with a bounded nonempty first
partition; VP8L requires bytes beyond its five-byte header. ALPH headers accept
only defined compression, filter, and preprocessing fields, and uncompressed
alpha must contain exactly one byte per frame pixel. Unrecognized top-level and
nested WebP chunks fail closed. These bounds fail before any consumer decodes
image payloads. SVG, HTML, CSS, JavaScript, fonts, and arbitrary downloads are
not managed Docs v1 assets.

## API

```js
import {
  assertValidArtifact,
  serializeManifest,
  validateArtifact,
  validateManifest,
} from "@taprootio/docs-artifact";
import { loadConformanceCases } from "@taprootio/docs-artifact/conformance";
import { validateArtifactDirectory } from "@taprootio/docs-artifact/node";

const manifestResult = validateManifest(manifestBytes);
const artifactResult = await validateArtifact(manifestBytes, semanticFiles);
const directoryResult = await validateArtifactDirectory("_site");
const canonicalBytes = serializeManifest(manifestObject);
const sharedCases = await loadConformanceCases();
```

The root also exports additive `validateManagedManifest`,
`assertValidManagedManifest`, `serializeManagedManifest`,
`validateManagedArtifact`, and `assertValidManagedArtifact` aliases plus
`MANAGED_*` identity constants. `@taprootio/docs-artifact/node` likewise exports
`validateManagedArtifactDirectory`. The legacy managed names above remain
unchanged.

Prebuilt consumers use the separate, explicit surface:

```js
import {
  PREBUILT_ARCHIVE_FORMAT,
  serializePrebuiltManifest,
  validatePrebuiltArtifact,
  validatePrebuiltManifest,
} from "@taprootio/docs-artifact/prebuilt";
import { createDeterministicPrebuiltArchive } from "@taprootio/docs-artifact/prebuilt/archive";
import {
  loadPrebuiltConformanceCases,
  validatePrebuiltConformanceCase,
} from "@taprootio/docs-artifact/prebuilt/conformance";
import { validatePrebuiltArtifactDirectory } from "@taprootio/docs-artifact/prebuilt/node";

const manifestResult = validatePrebuiltManifest(manifestBytes);
const artifactResult = await validatePrebuiltArtifact(
  manifestBytes,
  exactFiles,
);
const directoryResult = await validatePrebuiltArtifactDirectory("_site");
const canonicalBytes = serializePrebuiltManifest(manifestObject);
const sharedCases = await loadPrebuiltConformanceCases();
const sharedResults = await Promise.all(
  sharedCases.map(validatePrebuiltConformanceCase),
);
const archive = createDeterministicPrebuiltArchive(directoryResult.value);
const representativeVector = sharedCases.find((fixture) =>
  fixture.expectedArchive
)?.expectedArchive;
```

`createDeterministicPrebuiltArchive()` accepts only the isolated snapshot
returned by a successful prebuilt artifact or directory validation. It verifies
the snapshot's declared sizes and hashes again against the bytes it archives,
then returns `{ format, bytes, byteLength, contentHash }`. The representative
conformance case exposes its committed `expectedArchive` bytes, `byteLength`,
and `sha256` for independent producer and consumer byte-identity checks.
`validatePrebuiltConformanceCase()` runs ordinary cases against the in-memory
validator and safely materializes the published non-regular-file race case in a
disposable directory for the Node boundary.

The assertion variants throw `DocsArtifactValidationError` with the same stable
`errors` array. The CLI prints `code path: message` diagnostics and exits nonzero:

```bash
npx --package=@taprootio/docs-artifact@1.1.0 taproot-docs-validate ./_site
npx --package=@taprootio/docs-artifact@1.1.0 taproot-docs-validate --mode prebuilt ./_site
```

Consumers should assert error `code` and `path`, not human-readable wording.
The package test suite also runs `npm pack --dry-run --json --ignore-scripts`
and requires the exact reviewed tarball inventory, including the ISC
`LICENSE`, so a publishable file cannot appear or disappear silently.
