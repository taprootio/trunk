# `@taprootio/site-authoring`

The command-line authoring surface for a Taproot site. `taproot-site` pulls a
site's pages, navigation, and settings into a local workspace, validates what
you author there against the same contracts the published site renders, and
pushes, previews, approves, and deploys the result — for a person at a
terminal or an agent acting on an owner's behalf.

The CLI is deliberately strict where the server is permissive. Taproot stores
a page body as it is sent and renders what it recognizes, so a malformed
document fails silently at render time. Every push therefore validates every
document it will send before sending any of them, and refuses anything the
renderer would drop.

## Availability, as of September 2026

Taproot cannot yet deliver sign-in email to people outside the team, so no
one outside it can create an account or approve a sign-in today. The package
is published ahead of that so it is installed and ready when access opens.
Until then, `help` and `validate` work fully offline, and `login` will print
its approval code and URL and then wait for an approval that cannot yet be
given, giving up when the approval window closes (about fifteen minutes) with
`login.timeout`. This note is removed when access opens.

## Install

```bash
npm install --global @taprootio/site-authoring
taproot-site --help
```

Node 22 or later. The package has one runtime dependency,
`@taprootio/espalier`, pinned to an exact version: the CLI validates themes
against one Espalier theme contract, and a floating range would let an install
resolve a different contract than the CLI was tested against.

## First commands

`taproot-site --help` lists every verb and the configuration contract.
`taproot-site help` is the offline reference family agents read before
authoring: page types, components, navigation, media, previews, themes,
appearance, and the footer, each with `--json` for stable machine-readable
output.

```bash
taproot-site help
taproot-site help page free-form
taproot-site help component hero-section --json
```

`taproot-site validate <fixture-directory>` checks a complete offline fixture
with no credential, no network, and no write: a directory laid out like a
pulled workspace — `pages/`, `nav.json`, and the four `settings/` documents —
whose `manifest.fixture.json` binds deterministic page, resource, image, and
settings identities under a versioned `fixture` block. It proves structure,
page content and theme contexts, navigation references, the complete theme,
appearance, header, brand, and footer, and fixture-local image identities. It
does not prove authorization, site ownership, concurrency, server round trips,
or rendering; a real pull and an authorized preview do that.

## Authorize

Sign in once. `login` starts a device-style authorization: it prints an
eight-character code and the approval URL on the Taproot origin it is
configured to talk to, and waits while an owner enters that code in a browser
already signed in to Taproot. Typing the code — rather than following a
prefilled link — is what proves the person approving can see the terminal
that asked, so the URL never carries the code and the page accepts none.

```bash
taproot-site login
taproot-site sites
taproot-site use "My Site"
taproot-site whoami
```

The issued sign-in is stored outside any repository at
`$XDG_CONFIG_HOME/taproot-site/credentials.json` (falling back to
`~/.config/taproot-site/`), directory `0700` and file `0600`, one per Taproot
origin. It authorizes nothing on any site. It can do exactly two things: list
the account's authorable sites, and exchange itself for a short-lived site
credential, which every authoring command mints for itself and holds only in
memory. Exchanged credentials expire within the hour and carry only the
capabilities the command needs — a content push never holds deploy. The
sign-in expires 24 hours after its last successful exchange, and never past
any expiry the approving owner chose.

`sites` lists what the sign-in may author; `use <name or id>` records the
choice as `siteId` in `taproot-site.json`, creating the file in the current
directory when there is none. `whoami` answers from local state alone: which
Taproot, which account, which site, what the last exchange granted, and when
the sign-in expires. `logout` discards the stored sign-in locally and revokes
nothing; the credential stays valid until an owner revokes it under
Account → Settings → API keys. The secret itself is never displayed, logged,
or placed in any result: credentials are named by id and display prefix only.

### `TAPROOT_SITE_KEY` overrides the sign-in

CI and non-interactive agents authenticate with a site-scoped site authoring
key issued under Account → Settings → API keys and supplied only through the
environment:

```bash
export TAPROOT_SITE_KEY='the one-time displayed site authoring key'
taproot-site status
```

When the variable is set it wins outright and the exchange is skipped, so
logging in on a machine never changes what existing automation does. Presence
is authoritative: an empty or malformed value is refused as `auth.key_invalid`
rather than falling through to a stored sign-in and running the command as a
different identity. There is no flag and no configuration field for either
credential, and no second environment variable.

## Configuration

Commands that act on a site read `taproot-site.json`, discovered by walking
upward from the current directory through a bounded number of parents.
Exactly one must be found: none is `config.not_found`, more than one is
`config.ambiguous`, and `--config <path>` placed before the verb selects one
explicitly and bypasses discovery. `login`, `logout`, `sites`, `use`,
`whoami`, and `env` need no configuration and no site.

```json
{
  "configVersion": 1,
  "siteId": "11111111-1111-4111-8111-111111111111",
  "workspaceDir": "site"
}
```

| Field           | Rule                                                                                                                                            |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `configVersion` | Must be `1`.                                                                                                                                    |
| `siteId`        | Optional. The canonical lowercase UUID of the site the next command writes to. `use` writes it; a present but malformed value is refused.       |
| `workspaceDir`  | Required. A relative POSIX path beneath the configuration directory that `pull` writes into. Every existing segment must be a real directory.   |

The file is a small, closed JSON object. Unknown fields, duplicate keys, links
in the path, and unsupported versions are refused before any credential is
attached to a request. `apiBaseUrl` is not a field and is refused by name:
which Taproot the CLI talks to is a property of the machine, not the project.

### Which Taproot the CLI talks to

```bash
taproot-site env               # report
taproot-site env local         # https://app.taproot.test/api
taproot-site env production    # https://app.taproot.io/api, the default
```

The choice is remembered per machine in `settings.json` beside the
credential, because it has to be known before any `taproot-site.json` exists.
Only a reviewed origin set is accepted: `app.taproot.io`, `app.taproot.test`
for a local Tilt stack, or an explicit loopback host such as
`http://localhost:8080/api` for development. Taproot is not a self-hostable
distribution, and every other host is refused before a bearer can be built.
Sign-ins are stored per origin, so switching away and back finds the one that
was already there.

## The authoring loop

```bash
taproot-site pull
# edit site/pages/about.md
taproot-site pages push about
taproot-site preview page about
taproot-site approve about
taproot-site deploy --staging
taproot-site deploy --production
```

`pull` snapshots pages, navigation, and settings into the workspace:
`pages/`, `nav.json`, `settings/`, `media/`, and two dot-prefixed manifests
that carry site binding and page identity between commands. Every page path
has exactly one authoritative source — `pages/<name>.md` in the documented
Markdown subset with `title`, `path`, and `description` front matter, or
`pages/<name>.pm.json` as a ProseMirror document — and pull never writes a
generated `.pm.json` beside a tracked `.md`. For a page tracked as Markdown
the site's own document is kept as internal state under
`.taproot-site-state/`, which is never a page source and never pushed. A page
edited on the site since the last pull is a `pages.pull_conflict` refusal
before anything under `pages/` changes, with both recovery paths named.

`pages push [page-path...]` validates and sends the selected pages, or every
workspace page when none is named; the homepage is addressed as `/`.
`media upload [path...]` uploads raster files and records component-ready
delivery fields. `nav push`, `theme push`, and `footer push` replace the whole
navigation tree, the complete light/dark theme pair with its appearance
settings, and the closed footer document.

`preview page <page-path-or-id>` renders one persisted draft behind the
staging gate and mints a browser handoff URL, reported only in the final JSON
result. **Each handoff is single-use.** Opening the URL consumes it; a reused,
shared, or bookmarked preview URL answers `Not found`, which is the handoff
being spent rather than the preview being broken. Run `preview page` again
for another. The handoff also expires two minutes after it is minted;
`preview revoke <page-id> <snapshot-id>` releases a preview early.

`approve [page-path...]` publishes drafts into the approved candidate pool.
It stages; nothing reaches an audience until `deploy --staging` publishes the
candidate and `deploy --production` promotes that completed staging
deployment. `status` reports deployments, readiness, and image processing.

## Output contract

Human progress goes to stderr and `--quiet` silences it (except for `login`,
whose approval code and URL exist only as progress). Stdout carries exactly
one JSON object per run, schema version `1`: `ok`, the CLI name and version,
the verb, and the verb's own result on success; a stable `error.code` with an
optional `field`, `status`, and classified `refusal` on failure. Exit codes are
`0` success, `1` failure, and `2` usage fault. The four refusal classes an
automation should branch on are `platform_paused` (external authoring is
paused; retry later), `credential_rejected` (stop and re-issue),
`plan_limit` (the plan's published-page allowance, surfaced at deploy), and
`throttled` (back off).

When `GITHUB_OUTPUT` names the runner's existing output file, every
operational verb appends the same JSON under `taproot_site_result` through a
random delimiter block, plus `taproot_site_verb` on success. Credentials,
Authorization values, signed upload headers, preview handoffs outside the
final result, and page bodies never appear in progress, diagnostics, JSON, or
Actions output.

## Public release

Private Taproot is the source authority. A private `site-authoring-v<version>`
tag verifies this package — the release commit must belong to `main`, the tag
must name the version `package.json` declares, and `@taprootio/espalier` must
be pinned to the exact version the release manifest records — then
allowlist-exports only `packages/site-authoring/` to public
[`taprootio/trunk`](https://github.com/taprootio/trunk). Trunk's separate
`publish-site-authoring.yml` workflow tests and publishes those exact public
tag bytes with npm trusted-publishing provenance, under its own concurrency
group, GitHub Environment, tag prefix, and npm identity.

The package's tests run in both places. A few compare this package against
sources that live only in the private monorepo — the canonical renderer, the
shared section registry, the seeded default theme, and the API's contracts —
and those skip by name in the public tree rather than pretending to pass.
