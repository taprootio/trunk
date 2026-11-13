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
Until then, `help` and `validate` (unless `--site`) work fully offline, and `login` will print
its approval code and URL and then wait for an approval that cannot yet be
given, giving up when the approval window closes (about fifteen minutes) with
`login.timeout`. This note is removed when access opens.

## Install

```bash
npm install --global @taprootio/site-authoring
taproot-site --help
```

Or run the current release without installing it:

```bash
npx --yes @taprootio/site-authoring@latest --version
```

Always name `@latest` with `npx`: an unversioned `npx @taprootio/site-authoring`
reuses whatever copy npx cached, which is how a design pass ran an old release.
`--version` prints what is running; `status` reports the latest known release
as `cliRelease`, and every online verb refuses an outdated CLI (below).

Node 22 or later. The package has one runtime dependency,
`@taprootio/espalier`, pinned to an exact version: the CLI validates themes
against one Espalier theme contract, and a floating range would let an install
resolve a different contract than the CLI was tested against.

## Keeping the CLI current

Taproot accepts only the latest published release of this package. There is no
compatibility window: the contract moves with every release, and a CLI behind
the current one is refused at sign-in, at `sites`/`use` site listing, and at
every online verb that exchanges the sign-in for a site credential, before it
validates or writes anything.
`TAPROOT_SITE_KEY` runs perform no sign-in and no exchange, so they are not
version-gated and their `status` reports `cliRelease.latestKnown: false`; keep
an automation's CLI current yourself.

```bash
npm install -g @taprootio/site-authoring@latest
```

A refusal names the field `CliUpgradeRequired`, classifies as
`refusal: "cli_outdated"`, and carries both versions and that command. Nothing
is wrong with the credential, the request, or the site, and no retry of an
outdated version succeeds. The API puts the versions and remedy in both the
status message and the stable field detail. Legacy 0.2.0 ignores those messages
and prints only `CliUpgradeRequired`; if that is all you see, run the upgrade
command above. If the newer release is only minutes old, npm may not serve it
yet — wait a moment and run the upgrade again.

Each sign-in exchange also reports the latest published release. `status` shows
it as `cliRelease`, `whoami` reports what the last exchange recorded (dated with
that exchange), and once a newer release has been recorded the offline verbs —
`help`, `validate`, and `whoami` — refuse with the same message rather than
letting an agent keep authoring against a contract that has moved. With nothing
recorded they run, so a clean machine can still validate a fixture.
`taproot-site --version` and `--help` always answer.

Do not pin this package's version in a script. Every release retires the one
before it, so a pin is a scheduled outage.

**0.4.0 introduces this gate.** From the API deploy that ships with it, every
CLI older than the release that API was built with is refused with
`CliUpgradeRequired`. The release order is: merge to private `main`, then the
npm publish of 0.4.0, then the API deploy — publishing first is what keeps the
upgrade available to anyone the deploy refuses.

## First commands

`taproot-site --help` lists every verb and the configuration contract.
`taproot-site help` is the offline reference family agents read before
authoring: page types, composable design blueprints, components, navigation, media, previews, themes,
appearance, the footer, and the offline fixture contract, each with `--json`
for stable machine-readable output.

```bash
taproot-site help
taproot-site help designs
taproot-site help design professional-portfolio
taproot-site help page free-form
taproot-site help page recipe
taproot-site help component hero-section --json
```

Design help separates three choices that agents should make deliberately:
site purpose, visual language, and interaction intensity. The six blueprints
cover professional portfolios, bold consumer brands, editorial publications,
local services, cultural events, and community directories. Each describes a
content model, representative pages, navigation shape, theme direction,
component recipes, a motion ceiling, media guidance, integration boundaries,
and accessibility cautions. They are composable starting points—not templates
or permission to copy another site's protected assets or trade dress. Use
`--json` when an agent needs the stable recipe structure.

Before pushing appearance, use `taproot-site help appearance` and preview both
schemes. A light logo must remain distinct on the rendered light header and a
dark logo on the rendered dark header at desktop and compact/mobile widths;
transparent canvas pixels do not count as contrast. Supply separate
scheme-specific assets when one visible mark cannot satisfy both surfaces.

`taproot-site help settings` maps every pulled setting to the app control that
shows it, says what it does and where it renders, and names the verb that
writes it (`help appearance` prints the same text beside each writable field,
and the shipped help is the authority if this table drifts). The ones that are
easy to confuse:

| App control | Workspace field | Where it renders |
| --- | --- | --- |
| Brand & style > Page style > Background image | `lightTheme` / `darkTheme` `pageBackgroundImage` (with `pageBackgroundImageOpacity`) | One layer across the page box behind the content; the opaque header and footer cover it, so it shows behind the main content. |
| Brand & style > Page canvas > Canvas image | `lightCanvasImageId` / `darkCanvasImageId` in `taproot-styles.json` (with the two `...CanvasImageOpacity` fields) | Only the empty side margins of a page. Not on a standard site today, whose margins are 0 px wide. |
| Brand & style > Brand > Logo | `lightLogoId` / `darkLogoId` | The header brand, and the footer's brand once the footer is enabled. |
| Brand & style > Brand > Favicon | `brand.json` `faviconId` | The icon set in every page's head and `/favicon.ico`. |

Both background layers tile at the image's natural pixel size from the top-left;
neither sets a size, repeat or position.

`taproot-site validate` checks the pulled workspace `taproot-site.json` names,
with no credential, no network, and no write: every page source (metadata,
Markdown conversion, media references, content vocabulary, section contexts),
page paths and templates against the pages the pull recorded, navigation,
redirects, forms, and the complete theme, appearance, header, brand, and
footer. Navigation to a generated page (a section or folder page) resolves
against the pages the pull recorded. It reports every problem at once in
`error.problems`, each with its file, code, and field, instead of one per run.
Warnings never refuse: `linkWarnings` names a link whose address is only
`http(s)://` plus its own text (`content.link_autolinked`, left by older editor
autolinking), and `pages push` reports the same for the pages it sends.

`validate` also runs the site checks that need nothing but the workspace, from
the same rule catalogue the editor and the site-health page read. `findings`
lists each one as a rule id (`link.page_missing`, a link to a page the workspace
does not have), a severity, the file, and the value found (and a `detail` for
some); a warning never refuses. For a free-form page the rules also read its headings,
images and links the way the publisher does: `seo.h1_missing` when no `#` heading,
banner title or hero title is the page's `<h1>`; `seo.h1_demoted` when a `#` heading
publishes as an `<h2>` because the banner's overlay text, a hero title or an earlier
`#` heading already is the `<h1>` (`detail` says which); `seo.h1_multiple` for a hero
title after the `<h1>`; `seo.heading_renumbered` and `seo.heading_before_title` for
headings published at another level; and `a11y.link_text_empty`. Image-default
completeness (`a11y.image_default_missing`) needs the site's own image records,
so plain `validate` lists it in `siteChecks.skipped`, with `siteChecks.imageCheckReason`
(`not_requested`, or `directory_argument` for a directory). `validate --site` reads
those records and reports each undescribed image the workspace places in
`imageFindings` (`total`, `items`, `truncated`), with its affected pages and the exact
`media images describe` command for its fix, and the placed ids that are not in the
site's library (deleted, another site's, or owned media such as a copied video poster)
in `notInSiteLibrary`; `siteChecks.imageCheckReason` says `read_failed` or
`read_partly_failed` when the read did not complete. After staging, the stored
deployment report (`health --staging`) is the authority, using frozen image defaults.
Without `--describe-missing-images`, placement alt strings and decorative choices never fill a
missing reusable default: alt text only suggests the text for the command. Besides `media images describe` and the
app, `pages push --describe-missing-images` is the only path that fills one, and only when
the selected custom or unset placements agree on a single text; no other push or validate
path infers a default from placement alt. Known author-entered metadata receives missing, short and
long title/description advice, plus `seo.description_matches_title` when the description
repeats its title. The writing guidance is 15–70 characters for titles and 50–160 for
descriptions, counted as Unicode characters after outer trimming. These suggestions
never require padding or truncation and never refuse a save, push or deploy.
Generated custom values are checked locally. Generated defaults, home-page settings
and unknown fields defer to deployment in `siteChecks.deferredToDeployment`.
`siteChecks.checkedInEditor` names rules only the page editor evaluates, such as a selected cover. `siteChecks.checkedBySite` names the rules that need the site's own
records, such as referenced images and forms: `status` reads the stored deployment
report under `siteHealth` without scanning current drafts or compiling a new report;
`siteChecks.checkedAtDeploy` names the ones only a deploy applies. A redirect source the site would refuse also names its rule in
`error.problems[].rule`.

`taproot-site validate <fixture-directory>` checks a complete offline fixture
the same way: a directory laid out like a
pulled workspace — `pages/`, `nav.json`, `redirects.json`, and the four
`settings/` documents —
whose `manifest.fixture.json` binds deterministic page, resource, image, and
settings identities under a versioned `fixture` block. It proves structure,
page content and theme contexts, navigation references, the complete theme,
appearance, header, brand, and footer, and fixture-local image identities. It
does not prove authorization, site ownership, concurrency, server round trips,
or rendering; a real pull and an authorized preview do that.

The package ships one, so `validate` is runnable the moment the install
finishes. `taproot-site help fixture` states the manifest contract and prints
the shipped fixture's absolute path along with the exact command to validate
it:

```bash
taproot-site help fixture
taproot-site validate "$(npm root --global)/@taprootio/site-authoring/examples/riverbend-wellness"
```

The fixture is a fictional wellness studio — `example.test` hostnames, a
reserved `555-01xx` telephone number, an invented street and town — with two
free-form pages and one each of the article, recipe, album and place-review
templates, a three-item navigation tree, all four settings documents, and a
`.taproot-site-media.json` that maps its one media path to a fixture image id.
Nothing in it describes a real business. Copy the directory somewhere writable
before you edit it; `validate` never writes to the fixture it reads.

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

`sites` lists every standard and Docs site on the account with the authoring
verbs each accepts; `use <name or id>` records the choice as `siteId` in
`taproot-site.json`, together with the site's `authoringSurface`, creating
the file in the current directory when there is none. `whoami` answers from
local state alone: which Taproot, which account, which site and surface, what
the last exchange granted, and when the sign-in expires.

Which verbs apply depends on the site:

- A **standard** site takes every verb.
- A **managed Docs** site (`docs-presentation`) takes design and theming only:
  `pull` snapshots its four settings documents, `theme push`, `footer push`,
  and `media upload` author them, and `deploy` stages and promotes them.
  Its pages, navigation, and redirects come from the Docs artifact, so
  `pages push`, `nav push`, the `redirects`, `forms` and `marketing` verbs, `link build`,
  `approve`, and the `preview` verbs refuse with `surface.presentation_only` before any request.
- A **prebuilt Docs** site (`none`) serves its artifact unchanged and takes no
  verb; each refuses with `surface.none`.

The recorded surface is a convenience, not the authority: Taproot re-resolves
it on every write. After a Docs site becomes prebuilt, its sign-in exchange
answers Not found like any site the account can no longer author, and the
CLI adds a hint to run `use` again because the recording says the site was
authorable before.

`logout` discards only the stored account sign-in locally. Separately stored
site legal draft grants remain; select each site and use
`taproot-site --legal-drafts logout` to discard its grant. Logout revokes nothing; the
credential stays valid until an owner revokes it under Account → Settings →
API keys. The secret itself is never displayed, logged, or placed in any
result: credentials are named by id and display prefix only.

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
`whoami`, `env`, and `changelog` need no configuration and no site.

```json
{
  "configVersion": 1,
  "siteId": "11111111-1111-4111-8111-111111111111",
  "authoringSurface": "standard",
  "workspaceDir": "site"
}
```

| Field              | Rule                                                                                                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `configVersion`    | Must be `1`.                                                                                                                                                                                            |
| `siteId`           | Optional. The canonical lowercase UUID of the site the next command writes to. `use` writes it; a present but malformed value is refused.                                                               |
| `authoringSurface` | Optional. `standard`, `docs-presentation`, or `none`: the verbs the site accepts, as `use` recorded them. A present but unknown value is refused; Taproot re-resolves the surface on every write.        |
| `workspaceDir`     | Required. A relative POSIX path beneath the configuration directory that `pull` writes into. Every existing segment must be a real directory.                                                           |

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

## Design walkthrough

`taproot-site help walkthrough` is the self-contained version of this pass;
each step names the reference it relies on.

1. **Select a supported site.** `login`, then `sites` and
   `use <site-name-or-id>`. A standard site takes every verb; a managed Docs
   site takes presentation only (`pull`, `theme push`, `footer push`,
   `media upload`, `deploy`, `status`, and `health`, which answers
   `covered: false` there) because its pages, navigation and redirects come
   from the Docs artifact; a prebuilt Docs site takes no verb.
2. **Pull and keep the baseline.** `pull` writes both schemes' complete
   effective themes, the appearance files and the footer. Edit that pull;
   never build a theme from memory or an example.
3. **Edit both schemes and the appearance.** `help theme` lists every field,
   the role slots, how anchor references resolve and what wins when a pin and
   a role disagree; `help appearance` covers the default scheme, header, logos
   and favicon; `help fonts` lists the font families, by category, that the
   font fields can name.
4. **Prepare media locally.** Raster files only (PNG, JPEG, GIF, WebP),
   relative to the workspace root; make the transparent logo at the highest
   resolution you have (one file, not a 1x and `@2x` pair: the platform
   generates the sizes), a dark-scheme logo when needed and a square favicon
   with your own tools, upload them with `media upload`, then assign
   `lightLogoId`, `darkLogoId` and `brand.faviconId` from the returned ids. There
   is no recolor, crop or SVG upload command.
5. **Validate, preview, then push.** `validate` checks the whole workspace offline
   (`validate --site` also reads the site's image records, to report placed images with
   no default description);
   `theme resolve` prints, also offline, the colors Espalier compiles from the
   theme for each scheme and context with the contrast of every ink-on-surface
   pair and a flag for each one under WCAG AA (add `--json` for the stable
   result, `--scheme` and `--context` to narrow it, `--site` for the site's
   stored theme);
   `theme push --dry-run` reads the site and lists the JSON paths at which
   each settings file differs from it, and whether the baseline `pull`
   recorded is still current; `theme push` saves both themes, the appearance
   scalars and the ten footer scheme colours in one transaction fenced by
   that baseline. A concurrent change to any of those fields refuses the
   whole push (`theme.concurrent_modification`) and nothing is written: keep
   copies of the edited files, pull, re-apply, push again. A lost response is
   safe to retry: the save is recorded as pending before it is sent, running
   `theme push` again with the same files replays it under its original
   baseline, and the site answers `applied: false` when it already holds the
   change set. `pull` reads the four settings documents and the revision
   from one snapshot, and `footer push` advances the recorded revision only
   when its save replaced that same revision.
6. **Review on staging in both schemes.** `staging review` (or
   `deploy --staging --handoff`) returns a single-use handoff in
   `stagingPreview.url`, on a managed Docs site too; open it once and use the
   site's theme toggle; the review session lasts five minutes (see
   [How long a staging review lasts](#staging-verification-and-deployment-evidence)).
   On a Standard site `deploy --staging` first waits until
   staging serves the new release (see `stagingServed`). No page draft is
   needed; `preview page` renders one draft and is a different tool.
7. **Promote only after review.** `deploy --production`.

## The authoring loop

```bash
taproot-site pull
# edit site/pages/about.md
taproot-site validate --site
taproot-site pages push about
taproot-site preview page about
taproot-site approve about
taproot-site deploy --staging
taproot-site health --staging
taproot-site deploy --production
```

After `deploy --staging`, `health --staging` reads the Site Health warnings the
staged release stored, and `deploy --staging` returns the same report as
`siteHealth`. Fix every warning marked `newSinceProduction` before handing the
release over, then stage again: the report belongs to a release, so a fix
changes it only after another `deploy --staging` (and `approve`, for a page
edit). See [Site Health from the CLI in 0.37.0](#site-health-from-the-cli-in-0370).

`pull` snapshots pages, navigation, redirects, and settings into the
workspace: `pages/`, `nav.json`, `redirects.json`, `settings/`, `media/`, and
two dot-prefixed manifests that carry site binding and page identity between
commands. Against a Taproot that does not serve the redirect map yet, `pull`
writes no `redirects.json` and records no redirect baseline, and
`redirects push` asks for a pull once the site has one. Every page path
has exactly one authoritative source — `pages/<name>.md` in the documented
Markdown subset with `title`, `path`, and `description` front matter, or
`pages/<name>.pm.json` as a ProseMirror document — and pull never writes a
generated `.pm.json` beside a tracked `.md`. For a page tracked as Markdown
the site's own document is kept as internal state under
`.taproot-site-state/`, which is never a page source and never pushed. A tracked
Markdown page conflicts, with a `pages.pull_conflict` refusal before anything under
`pages/` changes and both recovery paths named, when the site moved: its stored-state
revision moved, or its display date moved for a page type that has one. A `.pm.json`
page is refreshed when the site moved, and conflicts only when it also has unpushed
local edits (its body, or its title, path, description or author in the manifest). The
revision covers the stored body, title, path, short description and cover image. For
an authored page (Markdown or ProseMirror), approve, staging and production
publication never move it; a legal page's version stamp is written at publication and
does move it; a place review's effective category is applied only to the release, so
a category override does not move it. The `Differs at:` paths of a refusal explain it
and never decide it (an empty list can mean a change to the title, path, description,
cover image or display date).
Pull before creating a new JSON source. Once a new page is declared with a
file, title or path but has no server page ID, save it with `pages push` before
pulling again, or back up both the source and its manifest entry and move them
out of the workspace. Pull refuses these pending entries rather than dropping
their metadata. It also refuses an untracked legal or unreadable JSON source
that would be replaced by a new remote page.

Pages are not only free-form. A source chooses its template with `template:` in
its front matter — `article`, `recipe`, `album` or `place-review`; free-form is
the default — and `pull` writes the other four as a `.pm.json` wrapper
(`{ "template", "displayDate", "coverImageId", "data" }`) that `pages push`
sends back unchanged. Typed pages also carry `displayDate` (so an import keeps
its original publication date) and `coverImage`, which the site requires to be an
image the page itself uses (place it in the body too; `pages.cover_image_unused`). A page's template is fixed when
it is created: a source for another template is refused with
`pages.template_immutable`. `taproot-site help page <type>` gives each
template's fields and one worked example. Pull includes structured legal pages and their
bodies as `.pm.json` with the usual Content read permission. Create and update
legal drafts in JSON only; Markdown conversion is not supported. The document
key, role and path are immutable, and publication assigns the version, effective
date and superseded version. See `taproot-site help page legal` for the fields.

Select a standard site and run `taproot-site login --legal-drafts`; the owner
reviews and approves a site-specific grant in the app, valid for at most 24
hours. Ordinary account login stays separate. Use the global option before the
verb, for example `taproot-site --legal-drafts pages push`,
`taproot-site --legal-drafts plan`, or `taproot-site --legal-drafts apply`.
It also selects the grant for `pull`, although ordinary Content access can read
legal pages. Changed or new legal drafts require this grant before writes begin;
unchanged legal pages do not block ordinary work. `TAPROOT_SITE_KEY` still takes
precedence, and legal writes with an unclassified environment override are
refused: unset it and use the explicit site login. Saving a draft does not
approve it. Legal approval, deletion and deployment remain in the app. A bare
`taproot-site approve` skips legal drafts and stages other tracked drafts; explicitly
naming a legal page refuses the whole selection.
A privacy policy or other legal page that names Taproot should link the first
mention to <https://www.taproot.io>; `help page free-form` and `help page legal`
give a sample sentence.

A structured page prints its title as the page's `<h1>`, so its body starts at
`##`. A free-form page renders no automatic heading, so open its Markdown with
a `# Page title` line: the first level-1 heading becomes the `<h1>`. A
`hero-section` with a title, or a leading `image-banner` with overlay text,
claims the `<h1>` first, so do not also write a `#` line on a page with a
titled hero. A later `#` heading is rendered as an `<h2>`, never a second
`<h1>`, and the other headings are renumbered so none skips a level. The
Markdown subset accepts levels 1 to 4.

A `.pm.json` page's title, path, description and author live in the workspace
manifest rather than the file. `pages meta set <path> --title <text>
--description <text>` changes the title or description there (a Markdown page
keeps them in its front matter; `--author` is described under *Page authors*); `pull` keeps that edit until `pages push`
sends it, and a site edit to the same page conflicts only while that edit is unpushed
(`pages.pull_conflict`; see the pull rule above). A
description over 160 characters is a warning (`descriptionWarnings`), because
search results cut it off; over 1000 is refused with
`pages.description_too_long`, by the CLI and by Taproot.

#### Columns inside a section

Free-form pages can put two or three editable regions side by side inside a
section. The regions stack in source order when the section is too narrow.
`taproot-site help page free-form` describes the JSON vocabulary and limits.

```markdown
:::section {}
:::columns {"ratio":"40-60"}
:::column {}
## Start a conversation

Tell us about your project.
:::endcolumn
:::column {}
Your ordinary blocks or form component go here.
:::endcolumn
:::endcolumns
:::
```

The default is two equal columns; omit default `count` and `ratio`. Set
`count` to `3` for three equal regions. Two columns also accept `40-60` and
`60-40`. Each `:::column {}` needs at least one ordinary flow block. Layouts
belong directly in sections and cannot nest. Headers and closers must be
unindented, standalone lines; close each region and layout before closing the
section. Code fences keep marker text literal. Prefix a marker with a backslash
to write it as prose. Existing Markdown parsing budgets still apply across all
regions.

JSON uses `columns` with `column` children, and preserves component, image and
form references. `pull` writes JSON; Markdown conversion remains one way. The
existing 1 MiB response limit and 2 MiB workspace input limit remain in force:
a large hydrated page can be refused by the CLI even when it is valid on the
server. A refused response does not partially replace workspace files.

## Page authors

Pages are authorless by default: a page you create with the CLI publishes with
no byline unless you name an author, and `pages push` lists the pages it created
that way in `pages.authorless`, with how to credit them. An author is one of two
kinds of person, named by one string:

- a **site author without a Taproot account** — one of an imported blog's
  authors, say — named by handle (`jane-doe`: lowercase letters, digits and
  single hyphens, at most 64 characters, fixed when the author is created). A
  site author's name appears on the byline and in the page's structured data;
  there is no profile link or follow button, because there is no account;
- a **site member who can create pages**, named by email address.

`authors list` prints both and rewrites `authors.json` (`pull` writes it too).
`authors add jane-doe --name "Jane Doe" [--email jane@example.com]` creates a
site author; `--email` is kept private (never published, never listed) so the
person can be linked to a Taproot account later. Adding a handle the site
already has under the same name succeeds and reports `existing: true`, so a
script can repeat itself; a different name for a taken handle is refused
(`authors.handle_taken`), naming the one the site has. `authors.json` holds the
members' email addresses, so keep it out of a public repository.

A page names its author with `author: jane-doe` in its front matter (any
template), or, for a `.pm.json` page, `pages meta set <path> --author jane-doe`.
Only the CLI assigns authors, and only to a page that has none; people editing
in the app are never asked to name one. `authors.json` is as old as the last
`pull` or `authors list`, so a name missing from it is not proof the person does
not exist. `validate` and `pages meta set` run offline: they refuse text that
is neither a handle nor an address (`pages.author_invalid`) and otherwise only
warn (`pages.author_unverified`, in `authorWarnings`) about a name `authors.json`
lacks. `pages push` and `plan` settle it online: on a miss they read the site's
current list once (`pages push` rewrites `authors.json` with it) and refuse
(`pages.author_unknown`) only a name the site really lacks. A member who cannot
create pages is `pages.author_unknown` as well, with the same wording.

The CLI only fills a page that has no author: a page that already has a
different one is refused (`pages.author_conflict`), by the CLI from what the
last pull recorded and by Taproot, and naming the author a page already has
changes nothing. The refusal says how to settle it: for a `.pm.json` page,
`pages meta set <path> --author <the site's author>` matches the site, and
`pages meta set <path> --author ""` drops an author that was never sent (it
never asks the site to remove one, and is refused once the site holds an
author); for a Markdown page, fix the `author:` line. `pull` keeps a pending
author the site now disagrees with and says so. The author is recorded on the
page's manifest entry (`author`, and `baseline.author` for what the site
held), so a re-push never resends it. The site names a page's author in
listings only while that person can still be named: a former member's page, or
a member who can no longer create pages, reports none, and a push that names
someone else on it is refused as a conflict.

Pages Taproot generates from the site's content — the published archive, a
folder — are update-only sources. `pull` writes each as
`pages/<name>.pm.json` with `"template": "generated"`: `data` holds what the
page is (`kind`, which you leave as pulled) and the four things
that are yours to author: `customTitle`, `breadcrumbTitle`,
`customDescription` and `introductionBody`. An empty string means "use the
generated default"; the description then falls back to the introduction's first
paragraph, else the system default. The manifest keeps the title and description
the site reports, for reference. `pages meta set <path> --title/--description`
edits `customTitle` and `customDescription` in the source (an empty value
clears it), and `pages push` sends the page back as an unapproved draft. The
title and description the site stores are derived from `customTitle`,
`customDescription` and `introductionBody`, so what a push sends for them is
ignored. A push refuses to create a generated page (`pages.generated_create`),
move one (`pages.generated_move`) or change its kind or identity
(`pages.generated_identity`, also when the manifest has no record of what the
file was pulled as: run `pull`); there is no Markdown form
(`pages.generated_markdown`). A generated page you did not edit never blocks a
push of the whole workspace, even when Taproot changed it since the pull. If the
site no longer has the page (its folder is gone, or Taproot retired its kind),
a whole-workspace push reports the file under `pages.staleGeneratedSources` and
sends nothing for it, and `pull` says so; delete the file. Naming that path in
`pages push <page-path>` is refused with `pages.generated_create`. A description over 160 characters is warned about,
since search results cut it off, and one over 1000 is refused.

`pages push [page-path...]` validates and sends the selected pages, or every
workspace page when none is named; the homepage is addressed as `/`. Every
selected page is checked before anything is sent, and a refusal lists every
problem in `error.problems`. `pages push --dry-run` runs the same checks
against the live site, lists which pages would be created, updated, or left
unchanged, and sends nothing. It fails
closed with `pages.push_conflict` when a page's stored-state revision has
moved since this workspace last reconciled with it, naming both revisions;
`pull` first, or push after a refused pull has shown you the site's version.

`pages delete <page-path> [--dry-run]` deletes one tracked page and removes its
source file and manifest entry, so the next
`pull` or whole-workspace push does not bring it back. It runs the same
revision fence as `pages push` first (`pages.push_conflict`, nothing deleted),
and refuses a page that navigation, the footer or a form's after-submit page
still uses (`pages.delete_referenced`, naming each use): remove those first,
then delete. A redirect that lands on the page is listed in `redirectsToPage`
and does not stop the delete; links from other pages are checked afterwards by
`validate` (`link.page_missing`). A page the live site serves is not taken off
it by the delete: the site stages the removal (`effect: removalStaged`) and the
page stays live until a deployment promotes it, so run `deploy --staging`,
review the staging site, then `deploy`. A page never published is removed
outright. The home page, 404, generated, legal and integration-managed pages
are refused. `--dry-run` runs every check and sends nothing. A page the site
already deleted or staged for removal (an interrupted run) is only cleaned from
the workspace and reports `effect: alreadyDeleted` or `alreadyRemovalStaged`.
`effect` is the answer: `deleted` is true only when the page is gone from the site
now, so a staged removal reports `deleted: false` and `removalStaged: true`. A
staged removal can be undone only in the app, with Keep page on the Pages list.

`places search <name and city>` asks Google Places for the place a review
names and reports predictions with a session token; `places select
<googlePlaceId> <sessionToken>` records the match as a Taproot place and
reports the `placeId` a place review's front matter needs. An article or an
album can name its place the same way with `place:`. `places category set
<placeId> <category>` changes the category this site shows for a place.

`plan` checks the whole workspace against the live site — pages, the media
they reference and the images the settings name, the footer and the pages it
links, the theme, navigation — and orders what is left
to send: media upload, pages push, footer push (theme push refuses unsaved
footer content), theme push, nav push, each marked ready, blocked, or nothing
to do. Navigation is also checked against the revision `pull` recorded: a tree that moved is a blocked
step (`nav.concurrent_modification`), and an unchanged tree under a stale revision is listed ready with
`settlesLostPush` so `apply` settles a push whose answer was lost. It writes nothing and reports a `planHash`. `apply --plan <planHash>`
plans again, refuses with `apply.plan_stale` if the workspace or the site
moved, and otherwise runs the steps through the ordinary push verbs. While
they run, a workspace file read differently from the plan (or not read by it)
stops the step before it writes, naming the file, and so does a page revision
or the site's navigation that moved. Steps are
not atomic together: a failure reports in `error.completedWrites` which steps
completed, which failed, and which did not run, and the next `plan` shows
finished steps as nothing to do. Redirects, forms, approval, and deployment
stay separate commands.
Image defaults belong to the reusable image. Use the selected site's ordinary
library, without rewriting page bodies:

```bash
taproot-site media images list --missing-description --page-size 25 --json
taproot-site media images get <image-id> --json
taproot-site media images describe <image-id> --description 'A red bird on a branch.' --expected-revision 0 --if-missing --json
taproot-site media images describe <image-id> --clear --expected-revision 1 --json
```

List returns one page in `images.items`, `images.totalImages` for the filtered
library, and `images.nextPageToken`; pass a nonempty cursor unchanged with
`--page-token` to continue. `--page-size` accepts 1–100. Filtering happens on the
server before pagination, and reads make no per-image requests. If a page's
text and previews exceed the output bound, repeat the same cursor with a smaller
page size. No rows are silently omitted. Zero matches is a successful empty list.

Each image exposes `imageId`, `uploadedName`, nullable `defaultDescription`,
`descriptionRevision`, dimensions, processing state, `previewUrl` and
`responsivePreviewUrls`. Revisions are decimal strings so JavaScript cannot
round an int64 value; pass them unchanged as `--expected-revision`. Preview URLs
are validated HTTPS addresses for inspection, may expire, and stay out of
`GITHUB_OUTPUT`. No image metadata is written to a workspace file by these verbs.

Describe requires exactly one of `--description` and `--clear`. The server trims
outer whitespace, turns empty/whitespace input into null, and rejects text longer
than 1000 Unicode scalar values without truncation. Unicode and newlines are
preserved in JSON. `--if-missing` is checked atomically at the write and cannot
clear a default. A stale revision reports `media.image_description_conflict`; an
existing default under the condition reports `media.image_description_exists`.
Both exit 1 and leave the stored text alone. Read the current image, reconcile,
and use its revision for a new intentional save; mutations never retry
automatically. Invalid input exits 2. Permission and credential refusals keep the
ordinary API error codes. Every verb requires `site.media.manage`, and images
from another site, profile/account scope, or an installation remain inaccessible.

Defaults apply to inherited usages after the next selected deployment. Current
public output and in-flight releases retain their frozen text; custom overrides,
decorative choices and unrelated album captions remain independent. Missing
means the image's default is absent, even when a placement has contextual text.
These commands populate no production content automatically. `help media` has
the full read/write contract.

`media upload [path...]` uploads raster files and records each one in
`.taproot-site-media.json`; Markdown then names an image by its path (such as
`media/photo.webp`) everywhere an image goes, from body images to component and
section image fields. MP4, MOV, and WebM files are uploaded as videos. Taproot does not
encode: the command reads each file with mediabunny, rewrites an H.264 and AAC
file that is not an MP4 with its index first as one (copying the tracks, never
re-encoding), declares its codecs, and prints the server's one-line refusal as
it came for anything it will not accept (a non-H.264 or non-AAC file, one over
the licence's upload cap). A video is ready when its upload confirms; the CLI sets no poster (Node has no video decoder), so
choose one on the Videos page, where an upload made there gets one automatically, and set its
title and caption there too: the poster, caption and shape are the video's own and show wherever
it is placed. The command reports its `videoId`, title, caption and file name for a `video`
component (`help component video`), and
`pages push` refuses a page that places a video the site does not have. `nav.json` and the footer
document leave defaults out (no empty `externalUrl` or `children` on a navigation item, no `bold: false`
on a footer text run); `pull`, `nav push` and `footer push` all write that form and accept either, so a
pull after a push shows only changes you made. `nav push` is fenced by the navigation revision `pull` recorded
(`navigation.revision` in the manifest): a tree edited in the app since is refused with `nav.concurrent_modification`
and nothing is written, and a manifest without a revision is refused with `nav.pull_required`; keep a copy of
`nav.json`, run `pull`, re-apply the edits and push again. `nav push`, `theme push`, and `footer push` replace the whole
navigation tree, the complete light/dark theme pair with its appearance
settings, and the closed footer document. `pull` writes each scheme's
complete effective theme — the stored theme resolved over the same defaults
every consumer renders — so a fresh workspace validates as pulled, and it
keeps only authored `semanticMappings` pins (listed in
`explicitMappingTokens` at the root; a pin inside a context needs no marker)
because a pinned token shadows its role. Contrast and status-color warnings
name the nearest passing value the CLI found and checked.
`theme push` — and `theme push --dry-run`, which writes nothing — also runs
Espalier's fit report over the root and every context in both schemes and
prints each lint as a warning, such as a filled action that renders the
opposite way round from its swatches; a lint never stops the push.
`redirects pull` writes the site's
redirect map to `redirects.json` with a baseline, and `redirects push`
validates the file offline and replaces the whole map; `help redirects`
states the entry shape (`path`, `kind` redirect or gone, `target`, `status`
defaulting to 301), the normalization rule, and every refusal.

`forms pull` writes each live form to `forms/<key>.json` and records the
version it read; `forms push` validates every file, refuses a form the site
changed since (`forms.concurrent_modification`) and creates or updates the
rest, appending a version when the definition changed. `forms validate` checks
the files offline against the shared field schema with no credential. Both
verbs write one canonical key order, so a pulled file pushed back is unchanged.
Submissions are never pulled. `help forms` states the file shape and every
refusal, and placing a form on a page is the free-form `form`
component.

The optional top-level `notify_owner` boolean opts a form into hourly,
counts-only owner email. New forms default to false; omitting it on an
existing form preserves the site's preference. It is independent of the sink
and takes effect without publishing or a new form version. Delivery requires
Taproot's rollout and email provider readiness; opt-in does not enable either
or backfill earlier submissions. The CLI never pulls visitor answers.

### Campaigns, placements and tracked links

A campaign groups the links of one push, and a placement names the spot a
link appears, such as a newsletter footer. Both are bounded sets of public
keys the site's release admits, so a page view that carries a matching
`utm_campaign` or `utm_content` is counted under it. Each is one JSON file:
`marketing/campaigns.json` is `{ campaigns: [{ key, name, note?, starts_on?,
ends_on? }] }` and `marketing/placements.json` is `{ placements: [{ key, name
}] }`.

```bash
taproot-site marketing pull          # write both files, with a baseline
# edit marketing/campaigns.json and marketing/placements.json
taproot-site marketing push          # create, update and restore
taproot-site marketing push --archive  # also archive what the files leave out
taproot-site link build --path /recipes/spring-salad --source newsletter \
  --campaign spring-launch --placement nl-footer
```

`marketing pull` replaces both files with the site's live records, each with
the read-only `state` (live, publishing, goes_live_with_first_publish,
not_in_current_release) and `counted_from`, the day its key first went live.
Archived records are listed and not written. `marketing push` validates both
files, compares every record with the site, and then creates a key the site
lacks, updates the labels of an existing key, and restores an archived key a
file names. A key is public URL text and never changes or returns to use, so a
changed key is a new record; the old one is archived only when you pass
`--archive`, and only if this workspace pulled it. A record that changed on the
site since the pull is refused (`marketing.concurrent_modification`), as is a
key the site has that this workspace never pulled (`marketing.pull_required`).
Quota and key refusals are shown as Taproot words them. Like `forms push`, it
has no plan step: it reads the site, refuses a stale baseline, and writes.
Creating or restoring a key queues the silent release that starts counting it;
nothing is deployed or waited for.

`link build` prints one address and saves nothing. It uses the Marketing link
builder's own rules, compiled from the app: the source decides the medium
(`reader` is not offered), a `utm_source`, `utm_medium`, `utm_campaign` or `utm_content` already on the path is replaced (other `utm_` pairs are kept), and a
campaign or placement is checked against `marketing/*.json` when the workspace
has them, and otherwise against the live site. A key that is not live yet is
allowed, with a note that page views count under the source only until it is
(a note read from a file is as of the last `marketing pull` or push).
The host is the signed-in site's public address; pass `--domain <host>` when
only a site credential is available. The `delegation.content` capability
carries what these verbs need (`site.analytics.view`, plus the publish
permission to change anything); `whoami` reports whether the last exchange
held it. `help marketing` and `help link` state the contracts.

`preview page <page-path-or-id>` renders one persisted draft behind the
staging gate and mints a browser handoff URL, reported only in the final JSON
result. **Each handoff is single-use.** Opening the URL consumes it; a reused,
shared, or bookmarked preview URL answers `Not found`, which is the handoff
being spent rather than the preview being broken. Run `preview page` again
for another. The handoff also expires two minutes after it is minted;
`preview revoke <page-id> <snapshot-id>` releases a preview early. It
addresses the snapshot, so it still works after `approve` has consumed the
draft; revoking an already revoked snapshot succeeds again, and an unknown or
cleaned-up snapshot answers `preview.not_found`.

`approve [page-path...]` publishes drafts into the approved candidate pool.
It stages; nothing reaches an audience until `deploy --staging` publishes the
candidate and `deploy --production` promotes that completed staging
deployment. `status` reports the platform authoring switch, the CLI release,
deployments, readiness, image processing, and site health under Content
permission. `siteHealth` reads the last successful production deployment's stored
report, and `stagedSiteHealth` summarizes the staged release's (its status, counts,
deployment and check time, or `available: false` with the reason, or `covered: false`
on a managed Docs site); `health` has the findings and their fixes. `siteHealth`
includes the deployment and output identities, input hash, checked time,
rule version, coverage, assessed page count and status. Unpublished edits are
outside that report. Page findings identify the rule, severity, page and value;
image findings group each missing default description with its affected pages.
Known reports include `covered: true`, `errors`, `warnings`, `pages` and `findings`.
Only a complete report with zero findings establishes that the assessed candidate
has no warnings. Missing, unsupported and incomplete assessments are explicit.
Output is bounded to 100 page findings, with an explicit `findingsTruncated` flag, and
image findings are bounded by size with `imageFindingsTruncated`.
Preview URLs appear only in normal output and are omitted from GitHub output.
A denied, malformed or failed production read fails `status` instead of implying a clean site;
a failed staged read is reported as unavailable.

## Output contract

Human progress goes to stderr and `--quiet` silences it (except for `login`,
whose approval code and URL exist only as progress). While a deployment is
awaited, a terminal shows one in-place line (spinner, phase, elapsed time) that
starts a new line only when the phase changes; a pipe or CI log never receives
control characters, only one line per phase change plus a heartbeat at most
every 60 seconds. Stdout carries exactly
one JSON object per run, schema version `1`: `ok`, the CLI name and version,
the verb, and the verb's own result on success; a stable `error.code` with an
optional `field`, `status`, and classified `refusal` on failure. Exit codes are
`0` success, `1` failure, and `2` usage fault. The six refusal classes an
automation should branch on are `cli_outdated` (this package is behind the
latest published release, which is the only one Taproot accepts; upgrade it,
and see "Keeping the CLI current"), `platform_paused` (external authoring is
paused; retry later), `credential_rejected` (stop and re-issue),
`capability_missing` (the credential is valid and correctly scoped but was
not exchanged for a capability the request needs; the refusal carries
`field: "GrantedCapabilities"`, and the CLI's human progress names the
granted and required capabilities, so report the verb's declared set rather
than re-issuing the key), `plan_limit` (the plan's published-page allowance or
its pages-generated allowance, or the bandwidth pause on deploys,
surfaced at deploy; the allowance shows its reset time, while the bandwidth pause shows the earliest
time it can lift, since it lifts only after a month ends under the allowance or on upgrade), and `throttled` (back off).

When `GITHUB_OUTPUT` names the runner's existing output file, every
operational verb appends the same JSON under `taproot_site_result` through a
random delimiter block, plus `taproot_site_verb` on success. Credentials,
Authorization values, signed upload headers, preview handoffs outside the
final result, and page bodies never appear in progress, diagnostics, JSON, or
Actions output.

### Every write answers `platform_paused`

`pull` and `status` succeed, and every write is refused with
`refusal: "platform_paused"` and `field: "SiteAuthoringRollout"`. Nothing is
wrong with the credential, the request, or the site: Taproot has external site
authoring switched off platform-wide. A Taproot administrator turns it back on
with the platform setting `site_authoring.external_writes_enabled`, under
Admin → Platform settings → Site Authoring ("External site authoring writes
enabled"); nobody else can, and no amount of retrying or re-issuing changes it.

You do not have to discover this from a refusal. Each sign-in exchange reports
the switch's state, so `status` names it as `platform.externalWritesEnabled`
and every write verb prints one warning before it does any work when the last
exchange said the platform was paused. The warning is advisory and never a
gate — the switch is enforced inside each write's own transaction, so a run
that starts while it is off still succeeds if an operator turns it on
meanwhile. `whoami` stays offline and reports what the last exchange recorded,
dated with that exchange; `status` is where a current answer comes from.
`TAPROOT_SITE_KEY` runs perform no exchange, so their `status` reports
`platform.externalWritesKnown: false` rather than guessing.

## Public release

Private Taproot is the source authority. Merging a version bump to private
`main` releases this package: the release workflow verifies that the commit
belongs to `main`, that `site-authoring-v<version>` names the version
`package.json` declares, and that `@taprootio/espalier` is pinned to the exact
version the release manifest records, then allowlist-exports only
`packages/site-authoring/` to public
[`taprootio/trunk`](https://github.com/taprootio/trunk), whose commit and
`site-authoring-v<version>` tag are the release record and name the private
source commit. A pull request that changes this package's public files
without raising the version fails CI, so the bump is never an afterthought;
pushing a private `site-authoring-v<version>` tag by hand remains the manual
path and runs the same verification. Trunk's separate
`publish-site-authoring.yml` workflow tests and publishes those exact public
tag bytes with npm trusted-publishing provenance, under its own concurrency
group, GitHub Environment, tag prefix, and npm identity.

The package's tests run in both places. A few compare this package against
sources that live only in the private monorepo — the canonical renderer, the
shared section registry, the seeded default theme, and the API's contracts —
and those skip by name in the public tree rather than pretending to pass.

### Content corrections in 0.7.0

CTA buttons accept the same safe destinations as hero actions, including `tel:`,
`mailto:`, fragments, queries, and relative paths. New page content rejects empty
contact destinations and the `tel://`/`mailto://` authority forms, consistently
with navigation and footer validation. Previously stored page links retain their
rendering behavior.

Inline-fact values support LF/CRLF line breaks (including inside their link),
and reading order is value then label. Unicode spaces and tabs remain valid.
Other C0/C1 controls, U+2028/U+2029, U+FEFF, and literal `<br>` tags are rejected
with the exact fact field path. A label is optional and stays outside the value's link. See
`taproot-site help page free-form` and `taproot-site help component cta`.

### Staging serves the new release in 0.21.0

A deployment reports `completed` once Taproot has asked Cloudflare to switch the
host to the new release. The edge then needs up to about two minutes to follow:
the route propagates, and the Worker keeps it cached for up to a minute more. A
cache-busting query cannot help, because the release comes from the route and not
the URL. `deploy --staging` on a Standard site now reads the release staging
serves before it deploys, and after the deployment completes waits (up to three
minutes, one read every three seconds) until a different release answers twice in
a row. The result carries `stagingServed`: `served` with `servedAfterSeconds`,
`propagating` when staging still showed the previous release at the bound, or
`unverified` when the change cannot be attributed to this deployment (no readable
baseline, another deployment under way or just completed, or a request that joined
one already running; it carries `expectedBy`, or `waitedSeconds` when the last read at the bound
did not name the previous release), and a managed Docs site always reports `unverified`. The check reads from the machine running the CLI, so a reviewer in another
region can still see the previous release until the two-minute ceiling. The
deployment itself is never failed by this wait. The redirect note no longer says there is no propagation delay.

### Forms by id in 0.20.0

A page stores the form it places by the form's id, so renaming a form never
breaks a page, but a workspace still names a form by its key: `forms/<key>.json`
and the `formKey` of a `component:form` block are unchanged, and the same files
still push to a fresh site whose ids all differ. `pages push` looks each key up
on the site, sends the form's id, and refuses a key the site does not have
(`pages.form_unknown`) or has archived (`pages.form_archived`) before it writes
anything; `plan` reports the same. `pages pull` writes the key back. An id the
site no longer has stays an id in the pulled file, and a push of it is refused
until you choose a form. Form names are now unique on a site, ignoring case. `validate`
checks the same keys offline against the workspace's own form files: when the
workspace has a `forms/` directory, a `formKey` no `forms/<key>.json` in it names is refused
(`pages.form_unknown`, rule `form.key_unknown`) naming the file it expected. A workspace
with no `forms/` directory is not checked, because its forms may live only on the site.
The deploy that introduces this rewrites the stored page bodies, which changes the
body revision of every page that places a form, so the first `pages pull` after it
can report `pages.pull_conflict` for such a Markdown page even though its content
is the same. Run `taproot-site pages push <path>` for that page, or delete the file
and pull again. `forms validate` and `forms push` also refuse two forms with the
same name (`forms.name_duplicate`, `forms.name_taken`).

### Place categories in 0.18.0

A place has one category for every site, taken from Google's types, and a place
that Taproot could not classify is filed under `Other`. A site can file a place
under a category of its own:

```
taproot-site places category list
taproot-site places category set <placeId> park
taproot-site places category clear <placeId>
```

`list` prints the closed list `set` accepts; a name outside it is refused, and
capitalization is ignored. The category is the site's alone and applies to every
review of that place on the site: the place itself and other sites do not
change. Place-review bylines use it from the site's next deployment, including
reviews nobody has edited. `clear` removes it.
Both need the same page-editing permission as `places select`.

### Pages generated in 0.18.0

A site's licence allows a number of pages generated per billing period, and
`deploy --staging` is charged by the pages it generates, not by the deployment.
The deploy asks Taproot to plan the candidate first and reports the plan before
it sends anything: `This will generate 74 pages · 940 of 1,000 left this period
(resets 2026-11-01T00:00:00.000Z)`. The same figures are in `readiness.pageEstimate`
(`plannedPageCount`, `pagesGeneratedLimit`, `pagesGeneratedRemaining`, `periodEnd`
and `exceedsAllowance`; a limit and what remains are `null` on an unlimited
licence). The number shown is the number charged. Promoting a staged release to
production generates nothing and costs no pages.

A candidate that does not fit stops with `deploy.page_allowance_exceeded`, naming
the pages it needs, the pages left, and the reset. A deploy refused by the server
for the same reason, or for the bandwidth pause, reports `plan_limit` with the
time it can lift (and `requested_pages` and `remaining_pages` for the allowance):
the allowance's reset, or for the bandwidth pause the earliest month end that can
clear it (an upgrade clears it at once).

### Deployment allowances in 0.18.0

A deploy refused for the bandwidth pause reports `plan_limit` with the time it
can lift: the earliest month end that can clear it (an upgrade clears it at
once).

### Authoring feedback in 0.16.0

- `pages meta set <path> --title/--description/--author` edits a `.pm.json`
  page's title, description or author; `pull` keeps the edit until `pages push`
  sends it. Descriptions are warned about over 160 characters and refused over
  1000, here and by Taproot.
- Generated pages (the published archive, the map, folders) pull as update-only sources
  whose custom title, breadcrumb, description and introduction you can edit.
- Pages are authorless by default. `authors list`, `authors add` and
  `authors.json` name a member who can create pages or a site author without a
  Taproot account; `author:` front matter or `pages meta set --author` credits
  one on a page that has none, and an author is never replaced from the CLI.
- `redirects check` and `deploy --staging` report `routeCheck`, `redirects` and
  `stagingPreview` at the top level; result paths spell the home page `/`;
  `approve` skips a page with nothing to approve instead of failing the batch.
- `validate` checks a real pulled workspace offline (`validate --init` keeps the
  generated pages navigation links to), and `validate` and `pages push` warn on
  links that look made by autolinking (`content.link_autolinked`).

### Link rel in 0.15.0

A link publishes followed unless its author chooses otherwise. A link mark's
`rel` takes space-separated link types (`nofollow`, `sponsored`, `ugc`, `me`,
and the other standard types except `opener`), on any link; `target: "_blank"`
opens a new tab with `noopener noreferrer` added. In Markdown, write
`[Shop](https://shop.example){rel="sponsored nofollow" target="_blank"}`
(either attribute alone works). Other tokens and
targets are refused (`content.link_rel`, `content.link_target`). The editor's
old default, `noopener noreferrer nofollow`, reads as no choice. See
`taproot-site help page free-form`.

### External links open in a new tab in 0.32.0

A link to another site opens in a new tab with nothing to set. On the next
render of a page, every absolute `http:` or `https:` address whose host is not
one of the site's own hosts publishes `target="_blank"` with `noopener
noreferrer` added after any `rel` tokens the link already carries. This covers
link marks in page text and tables, and component links: feature-grid,
image-row, card-grid, product-grid, hero-section, cta, image-banner and
social-links, plus the footer and header navigation. Each of these links also
says "(opens in a new tab)" to a screen reader, with no change on screen.
`mailto:`, `tel:`, relative paths, fragments,
queries and the site's own addresses stay in the same tab. A subdomain of the
site is another host, so it opens in a new tab; `www.` is ignored. To keep a
link mark in the same tab, write `target="_self"` after it in Markdown or set
`attrs.target` to `"_self"` in `.pm.json`. Component links have no setting for
this. Existing pages change when a publish renders the whole site, such as a
settings or navigation change; pages an incremental publish copies forward keep
their old links until then.

### Navigation groups expand in 0.35.0

An item with children is a dropdown header with no address of its own. Its label
opens and closes the group; put each destination in a child item. `nav push` and
the app refuse an address on a parent with children and explain how to repair it.
See `taproot-site help nav` for the file shape.

Pull preserves an old linked parent's address as a first child with the same
title. The parent keeps its ID and title, and existing children keep their IDs
and order. Push the pulled tree normally to persist that form. Published pages
change on regeneration and deployment: the group is a button without a new-tab
announcement, while its child links retain their destinations and link behavior.
The workspace accepts up to 2,000 navigation items in a 2 MiB navigation file.

### Header end links in 0.35.0

In Site settings → Header & navigation, edit a top-level page or external link
and set **Show in** to **Header end** to place it before the header controls.
For CLI authoring, set `"position": "NAV_ITEM_POSITION_HEADER_END"` on that item
in `nav.json`. Omit `position` for Menu; explicit `NAV_ITEM_POSITION_MENU` and
`NAV_ITEM_POSITION_UNSPECIFIED` mean the same thing and disappear on pull.
Dropdown headers and nested items stay in Menu. An unsupported position is
refused at its exact item `.position` path before saving.

Auto headers show these links beside their controls while everything fits,
then put every item in the same collapsed menu in original order on phones.
Drawer mode always combines them, and the minimal layout uses the drawer.
The existing auto and drawer display choices stay the same. Destinations
and external-link behavior stay the same. Pull, edit and `nav push` as usual;
the next whole-site render applies the change. Help reference version 55 covers
the new rule and file shape in `taproot-site help nav`.

### Navigation button links in 0.36.0

Set **Display as** to **Button** on a page or external link in the navigation
item dialog, or add `"appearance": "NAV_ITEM_APPEARANCE_BUTTON"` to that item in
`nav.json`. Button styling works at any depth, in Menu and wherever Header end
is available. Dropdown headers cannot use it. Changing a link to a dropdown
resets Display as to Link.

Omit `appearance` for Link. Explicit `NAV_ITEM_APPEARANCE_UNSPECIFIED` and
`NAV_ITEM_APPEARANCE_LINK` are equivalent and disappear on pull; Button survives
pull, validation and `nav push`. Invalid appearance values and Button on a
dropdown are refused at the exact item `.appearance` path before saving.

Button links retain their destinations, external-link behavior and styling in
the collapsed menu. The current page keeps Button styling without becoming an
interactive link. The next whole-site render applies the change. Help reference
version 56 covers the file shape in `taproot-site help nav`. Upgrade to 0.36.0
before sign-in or token exchange; older clients cannot safely replace this
whole tree because they do not preserve appearance.

### Header height and compact logos in 0.36.0

Edit the existing pulled `settings/site-header.json`: set `settings.headerPosition`
to `"fixed"` and `settings.headerHeightMultiplier` to a string such as `"1.8"`.
The range is `"1.0"` through `"5.0"` in 0.1 steps. Omitted, empty, `"1"` and
`"1.0"` mean standard height and disappear on pull; `"2"` normalizes to `"2.0"`.
JSON numbers, scientific notation, whitespace and off-grid values are refused
at `site-header.headerHeightMultiplier`. Preserve the file's envelope and other
settings, then use `validate` and `theme push` as usual.

The multiplier changes the primary bar. Extra menu rows, navigation text and
header controls retain their size. Fixed headers above 1.0 shrink with scroll
distance to their minimum height and expand back at the top. Normal and Sticky retain their
configured height; Fixed at 1.0 keeps the regular logo.

From 0.36.2, `settings.headerMinHeightMultiplier` uses the same string range and
0.1 steps, with omitted/empty/`"1"`/`"1.0"` meaning 1.0. For example, set the
expanded height to `"3.8"` and the minimum to `"1.9"` to stop shrinking at 1.9×.
The effective minimum is capped at expanded height, while pull retains the saved
minimum if the expanded height is temporarily lower. Normal and Sticky ignore
the minimum. Equal or oversized minima keep the regular logo and avoid unused
compact imagery. A final minimum above 1.0 keeps the tall header's quiet icon
controls and active-item treatment.

To use alternate artwork after shrinking, upload it with `media upload` and set
`settings.lightCompactLogoId` and/or `settings.darkCompactLogoId` in the existing
`settings/taproot-styles.json`. The app exposes **Compact logo** for Fixed above
1.0 in **Settings → Header & navigation**. Each compact scheme falls back to the
other compact scheme, then the regular resolved logo. Without alternate artwork,
the regular logo resizes. A compact choice needs a regular header logo and cannot
create a brand by itself. Saved choices survive other header modes; their URLs
are read-only server projections. Preview light/dark and desktop/390-wide, then
stage and deploy the settings for the published site. `help appearance` and
`help settings` describe both files.

### Site Health from the CLI in 0.37.0

Site Health is compiled when a release is generated, so it can only be read
after `deploy --staging`. `taproot-site health --staging` (or `--production`)
reads the report the release stored and never recomputes it; drafts and
approvals made since are outside it (`unpublishedChangesAssessed: false`). It
exits 0 whenever it reads the report, whatever the findings.

- `findings` are page findings: `rule`, `severity`, `path`, `title`, `file` (the
  workspace source, when the workspace tracks the page), `subject`, `detail` and
  a `fix` for the rule. `imageFindings` are one for each image with no default
  description: `imageId`, `name`, up to ten `affectedPages` (with
  `affectedPageCount` for the total), and a `fix`.
- An image `fix` is the exact command, with the description revision read from
  the site and the alt text the workspace's own pages place:
  `taproot-site media images describe <id> --description='<alt>' --expected-revision <n> --if-missing`.
  The text is single-quoted for a POSIX shell. When no placement gives a usable
  description (none, over 1000 characters, or with control characters), the
  finding says `needsDescription: true` and its `fix` is a sentence; write the
  description yourself. An image the site has since described says
  `currentlyDescribed: true`, and one the site no longer has says
  `imageAvailable: false`.
- With `--staging`, each finding says `newSinceProduction`, and `comparison`
  says whether production had a complete, untruncated report to compare with.
  Without one, every finding is listed as not compared.
- Findings are bounded by size (`findingsTotal`, `imageFindingsTotal`,
  `findingsTruncated`, `imageFindingsTruncated`). A site with no stored report
  returns `available: false` with the reason. A managed Docs site returns
  `covered: false`.

The same image check runs before staging, from what the workspace places.
`validate --site` (run from the workspace; it needs a sign-in, so it is no longer
offline) and `pages push`, with or without `--dry-run`, read the site's records of
the images the pages place, in one read, and report each one with no default
description with the same `fix`. `validate --site` adds `imageFindings` and
`notInSiteLibrary` (each `total`, `items`, `truncated`) and sets `offline: false`;
`pages push` adds `siteHealthPrecheck` with `status` (`checked`, `partial` or
`not_checked`), `checkedPages`, `imageFindings`, `notInSiteLibrary`, `skipped`
and, when the read did not complete, a `reason` code. A warning never refuses, a
failed read never fails the push, and `apply` makes no check. The check misses images
an integration places and a video poster a push copies; the stored report after
staging covers them.

`pages push --describe-missing-images` (also with `--dry-run`, which writes nothing)
goes one step further for the images in that check: after the pages are saved it sets
each image's missing default description from the one alt text its selected placements
agree on, with the revision the read returned and a condition that it never overwrites a
description. Only custom or unset placements count, so a stale inherited alt never
restores a default, and alts differing only by surrounding whitespace are one text. The
result gains `describedImages`, present only with the flag: `set` and `skipped`, each
`{ total, items, truncated }` (a set item is `{ imageId, description }`, a skipped one
`{ imageId, reason }`), and `reason` (the read's code) when the image read did not
complete. The skip reasons are `alts_disagree`, `no_alt`, `unusable_alt`,
`revision_moved`, `invalid_description`, `write_failed`, `write_unknown` (the write may
have committed), `write_denied`, `not_read` and `already_described`. A rejected credential,
an outdated CLI or a paused platform fails the command after the pages were saved, with
`completedWrites` naming what was written; throttling or a denied write stops further
writes and exits 0. After images are set, `nextStep` is `approve` while any selected page
holds a draft, and `deploy --staging` otherwise.

### Attributed quotes in 0.36.2

Ordinary `>` Markdown stays unchanged, including a final quoted paragraph used
for attribution. To put attribution and a source in a caption outside the quote
panel, use this envelope with ordinary Markdown inside:

```markdown
:::blockquote {"attribution":"Aldous Huxley","sourceTitle":"Brave New World","cite":"https://www.huxley.net/bnw/four.html"}
Words can be like X-rays.
:::endblockquote
```

The same ProseMirror node is:

```json
{
  "type": "blockquote",
  "attrs": {
    "attribution": "Aldous Huxley",
    "sourceTitle": "Brave New World",
    "cite": "https://www.huxley.net/bnw/four.html"
  },
  "content": [
    { "type": "paragraph", "content": [{ "type": "text", "text": "Words can be like X-rays." }] }
  ]
}
```

All three attrs are optional; absent or null means omitted. Attribution is the
person or organization, without introductory punctuation. Source title names the
work. Each accepts nonblank single-line plain text up to 200 Unicode characters.
The source URL accepts an explicit HTTP(S) address or a root-relative path up to
2048 characters. Protocol-relative, mailto, tel, script/data URLs, control
characters and backslashes are refused. Unknown attrs and malformed, orphan or
unclosed markers produce path or line diagnostics. Fenced-code markers stay
code. The envelope keeps ordinary quote nesting and placement limits, including
inside sections and columns; tables and sections cannot be nested inside quotes.

Pull writes `.pm.json` with the metadata. An unchanged push makes no write.
A tracked `.md` stays byte-identical on push and pull, with metadata retained in
remote JSON and the internal baseline. A browser metadata edit raises the usual
tracked-Markdown conflict, and a stale push is refused. There is no reverse
Markdown exporter. See `taproot-site help page free-form` for the closed attrs
reference and examples.

### What changed between releases

Taproot accepts only the latest CLI, so an upgrade can be forced at any time.
After one, run `taproot-site changelog --since <the version you upgraded from>`:
it prints each release's note, the behavior it changed, and the help topics
(`taproot-site help <topic>`) to read again, newest first, offline and without a
sign-in. With no `--since` it prints the installed release's entry; `complete:
false` means `--since` starts before the oldest release the record covers.
`status` reports the installed release's note in `cliRelease.whatsNew`. An
outdated-CLI refusal carries `latestVersion` and `changelogCommand` as their own
fields beside the message, so the command to run after upgrading is in the
refusal itself. Every release's notes live in one file, `src/changelog.json`,
and a package test fails when the installed version has no entry there.

### Staging verification and deployment evidence

`deploy --staging` selects the same changed pages, settings groups and navigation
as the Deployments page. It reports no review URL by default, because the URL is
a live single-use credential and this JSON is often saved to logs:
`stagingPreview.reason` is `staging.handoff_not_requested` and
`stagingPreview.recovery` names `taproot-site staging review`. Run that command
for a single-use review handoff (on a managed Docs site too, where deploy stages
settings only), or pass `--handoff` to `deploy --staging` to get it in
`stagingPreview.url` straight away; `--no-handoff` states the default
explicitly. Open the URL once, then use the site's theme toggle to review both
schemes before promoting. `staging review --path about` (or
`deploy --staging --handoff --review-path about`) opens the review on that page
instead of the home page; a page path as `pull` records it works, with or
without the leading slash, and a query is allowed. When a requested handoff cannot be minted,
`stagingPreview.reason` and `stagingPreview.recovery` say why and what to do
next; `staging review` mints another on any surface. `status` checks that exact current candidate, so a
completed CLI stage counts as successful until that candidate changes.

A retained failed preview of selected page content refuses deployment as
`deploy.preview_failed`, naming the page and snapshot. Render a new successful
preview or change the content; `--allow-failed-preview` is the explicit override.
Pending retries do not erase known failure. Previews remain optional. Expired
snapshots removed by normal cleanup and legacy snapshots without a candidate
fingerprint supply no gating evidence. Typed preview failure diagnostics contain
only error class and known page/node/attribute labels, never renderer messages.

Staging deploys check the current redirect map through the real staging edge.
Run `taproot-site redirects check` to repeat once the deployment has completed; a redirect is a file inside the release, so it is live exactly when its release is served.
The Node CLI consumes a separate handoff, retains its short staging cookie in
memory, and requests each map path without following redirects. Both
`redirects check` and `deploy --staging` report `routeCheck` and `redirects` at
the top level of their result: `redirects.items` lists each path, HTTP status
and Location, and `redirects.verified` requires all entries to match and the
map revision to remain unchanged. A mismatch is evidence to investigate, not a
failed deployment. Checks describe the current map, not a historical release.
Requests have a 90-second deadline with eight concurrent requests; large JSON
lists have explicit truncation, prioritizing failures. Progress output reports
each entry. A gate/transport failure never counts as verified.

With `--handoff`, `stagingPreview.url` is a fresh single-use two-minute handoff
minted **after** checks; without it the check still authenticates with its own
handoff and reports none. Opening it consumes it and establishes a five-minute staging cookie.
Minting again replaces the same authority's previous handoff and cookie. Current
site, host and credential permission are rechecked; key revocation stops access.

Treat the URL as secret: it is returned only in final JSON, omitted from progress
and `GITHUB_OUTPUT`. The same Actions exclusion applies to `preview page` URLs.

**How long a staging review lasts.** The handoff works once and expires two
minutes after it is minted. Opening it starts a five-minute review session in
that browser, and the session never renews. When it ends, the staging site
redirects to the Taproot sign-in. A reviewer whose Taproot account can preview
the site signs in and is sent straight back to the page with a fresh session; a
reviewer without one needs a fresh link from `taproot-site staging review`,
because a link minted with a key has no Taproot session behind it. Minting another handoff with the same
key for the same site, which `staging review`, `deploy --staging` (on a Standard
site, or with `--handoff`), `redirects check` and `delivery check --staging` do,
ends the earlier link and any session opened from it. That browser then shows "Staging preview
unavailable" rather than the sign-in redirect, so mint the link last, just
before the reviewer opens it. The staging site does not show a separate "link expired"
page for a missing cookie: the staging host cannot tell an expired link from a first visit, or see
whether the visitor is signed in to Taproot, and the sign-in redirect is what
renews a signed-in owner's review.

Deployment results carry `phaseTimings`. New deployments retain up to 32 durable
server-observed phase transitions, including repeated phases on retry. Durations
are calculated only between recorded transitions. `truncated` marks missing
older history; `known: false` marks legacy rows. CLI polling never invents phase
timestamps. Progress reports the same recorded timestamps and durations.

### Verify what visitors receive

A completed deployment job is not a verified delivery. `delivery check
(--staging | --production --url https://<published-domain>/)` reads the target
the way a visitor does and reports each dimension separately: the latest
completed deployment for the target, HTTP delivery of the authored routes and
the favicon, images, module preloads and site bundle they declare (status and
content type, no redirects followed), internal link targets, accidental
local-only references, and the pinned runtime — the version the page names,
its entry module and the capability modules the page declares (a page that
pins no runtime version and entry fails the runtime check). The
browser dimension (a fresh and a returning load
compared against the page's pinned entry, every document request in the browser,
popups included, held to the site origin before it is sent, and cache reuse
on the returning load observed rather than assumed)
runs only when Playwright resolves from the CLI's own install (install
`@taprootio/site-authoring` and `playwright` together globally and run the
installed `taproot-site` command; a copy run through `npx` cannot see a
global Playwright) and is reported as `unchecked` with that recovery
otherwise. `--wait <seconds>` re-checks
failures once for edge propagation; `--no-browser` skips the browser; `--url`
is a production option, since staging always checks the acknowledged host
with an authorized preview session. Only same-origin assets and the declared
runtime are fetched, and the check is read-only and bounded; `help delivery`
states the limits and verdicts.

### Export a pulled workspace as an offline fixture

From a pulled workspace (or its configured project), run:

```bash
taproot-site validate --init ../authoring-fixture
taproot-site validate ../authoring-fixture
```

The destination must be new, outside the source workspace, and its parent must exist. Use
`taproot-site --config path/to/taproot-site.json validate --init ../authoring-fixture`
to select another source configuration. Initialization needs no credential or
network. It exports editable pages of every template as workspace documents with navigation,
redirects, settings, and version-7 appearance/footer metadata, validates the
result, and leaves the source unchanged. A metadata-only page that navigation,
the footer or a page links to, such as a generated section page, is kept as a
metadata-only entry (`initialized.linkedPages`); other metadata-only pages are
left out (`initialized.skippedPages`).

Exported UUIDs and HTTP(S) origins are deterministic fixture values under
`example.test`; URL credentials, query strings and fragments are removed.
Configuration, credential files, internal state and deployment receipts are
excluded. Authored prose remains. Exports are bounded to 64 MiB, and a failed
validation removes the new output directory.

Required settings omissions are collected in `error.details` with field paths
and the `taproot-site pull` remedy. Present-but-invalid settings keep their
value errors. Pull reports `pages.revisionsRecordedWithoutBodyComparison` and a
human notice when it adopts first revisions without a completed body comparison.
The count excludes new downloads, established revisions and compared bodies;
it is not a claim that an adopted Markdown source matches the site.
