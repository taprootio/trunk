import { CAPABILITY_CONTENT, CAPABILITY_DEPLOYMENTS, CAPABILITY_DESIGN } from "./capabilities.js";
import { capabilitiesForSurface } from "./surface.js";
import {
  CLI_BINARY_NAME,
  CLI_NAME,
  CLI_UPGRADE_COMMAND,
  CLI_VERSION,
  DEFAULT_LOGIN_KEY_NAME,
  DEPLOY_TARGET_PRODUCTION,
  DEPLOY_TARGET_STAGING,
  LIMITS,
  LOGIN_KEY_NAME_MAXIMUM,
  PLAN_HASH,
  PUBLISH_KEY_ENVIRONMENT_VARIABLE,
  RESULT_SCHEMA_VERSION,
  SURFACE_DOCS_PRESENTATION,
  SURFACE_STANDARD,
  VERB_APPLY,
  VERB_APPROVE,
  VERB_AUTHORS_ADD,
  VERB_AUTHORS_LIST,
  VERB_DELIVERY_CHECK,
  VERB_DEPLOY,
  VERB_STAGING_REVIEW,
  VERB_ENV,
  VERB_FOOTER_PUSH,
  VERB_FORMS_PULL,
  VERB_FORMS_PUSH,
  VERB_FORMS_VALIDATE,
  VERB_HELP,
  VERB_LOGIN,
  VERB_LOGOUT,
  VERB_MEDIA_UPLOAD,
  VERB_NAV_PUSH,
  VERB_PAGES_META_SET,
  VERB_PAGES_PUSH,
  VERB_PLACES_CATEGORY_CLEAR,
  VERB_PLACES_CATEGORY_LIST,
  VERB_PLACES_CATEGORY_SET,
  VERB_PLACES_SEARCH,
  VERB_PLACES_SELECT,
  VERB_PLAN,
  VERB_PREVIEW_PAGE,
  VERB_PREVIEW_REVOKE,
  VERB_PULL,
  VERB_REDIRECTS_CHECK,
  VERB_REDIRECTS_PULL,
  VERB_REDIRECTS_PUSH,
  VERB_SITES,
  VERB_STATUS,
  VERB_THEME_PUSH,
  VERB_USE,
  VERB_VALIDATE,
  VERB_WHOAMI,
} from "./constants.js";
import {
  asSiteAuthoringError,
  hasAsciiControl,
  isCanonicalUuid,
  normalizePreviewRecovery,
  SiteAuthoringError,
} from "./errors.js";
import { failureResult, humanFailure, serializeResult, writeGithubActionsOutput } from "./output.js";
import { createProgressReporter } from "./progress.js";
import {
  formatReferenceResult,
  getAppearanceReference,
  getComponentReference,
  getDesignBlueprint,
  getFooterReference,
  getPageTypeReference,
  getThemeReference,
  getWorkflowReference,
  listComponentTypeReferences,
  listDesignBlueprints,
  listPageTypeReferences,
  DESIGN_TYPES,
  PAGE_TYPES,
  REFERENCE_TOPICS,
  REFERENCE_VERSION,
} from "./reference-help.js";
import { FONT_CATEGORIES, getFontCatalogReference } from "./font-catalog.js";
import { assertCliCurrent } from "./session.js";
import { VERB_HANDLERS } from "./verbs/index.js";

/**
 * The verbs the local version gate applies to (TR00703).
 *
 * Exactly the ones that make no request. Every other verb reaches Taproot,
 * whose own refusal is authoritative and better informed than this recording,
 * so gating them here would only duplicate an answer — and gating `login`,
 * `logout`, or `env` would take away the commands an operator needs while they
 * are outdated. `--help` and `--version` are outside it for the same reason:
 * they are how someone finds out what they have.
 */
const VERSION_GATED_OFFLINE_VERBS = Object.freeze([VERB_HELP, VERB_VALIDATE, VERB_FORMS_VALIDATE, VERB_WHOAMI]);

// One entry per verb, in help order. `tokens` is the exact leading positional
// sequence; matching prefers the longest sequence, so a two-token family can
// never be shadowed by a one-token verb.
const VERBS = Object.freeze([
  {
    name: VERB_HELP,
    tokens: ["help"],
    summary: "Show offline authoring reference help for agents.",
  },
  {
    name: VERB_VALIDATE,
    tokens: ["validate"],
    summary: "Check a whole workspace or offline fixture at once, or initialize a fixture with --init.",
    positionals: "fixturePath",
    offline: true,
    note:
      "With no directory, checks the pulled workspace taproot-site.json names; with one, checks that directory, which "
      + "is either an offline fixture (manifest.fixture.json) or a pulled workspace. Every page source, the theme, "
      + "appearance, header, brand, footer, navigation, redirects, and forms are checked with the validators the "
      + "pushes use, and every problem is reported at once in error.problems (each with its file, code, and field) "
      + "rather than one per run. A pulled workspace is checked offline against the pages (generated ones included, "
      + "so navigation to a section or tag page resolves), images, and baselines its manifests recorded at the pull. "
      + "A link whose address is only http(s):// plus its own text (left by older editor autolinking) is reported in "
      + "linkWarnings without refusing; pages push reports the same for the pages it sends. This proves local structure and semantics only. It does not prove "
      + "authorization, live site ownership, concurrency, persisted round trips, or rendering: 'plan' checks a "
      + "workspace against the live site, and 'pages push --dry-run' does that for pages alone. "
      + `See '${CLI_BINARY_NAME} help fixture' for the fixture manifest contract and for the path of the complete `
      + "example fixture this package ships, which needs no credential and no pulled site. "
      + "With --init, the directory is a new destination; the current pulled workspace or --config supplies the source.",
  },
  {
    name: VERB_LOGIN,
    tokens: ["login"],
    summary: "Authorize this CLI against a Taproot account through a browser approval.",
    credentialFree: true,
    configFree: true,
    keyName: true,
    note: "Starts a device-authorization exchange, prints the approval URL and an eight-character code, and waits for "
      + "an owner to enter that code and approve in a browser they are already signed in to. Typing the code — rather "
      + "than following a prefilled link — is what proves the approver can see this terminal. "
      + "It needs no site and no taproot-site.json: what it authorizes is the account, so it works in any directory "
      + "immediately after install. Choose a site afterwards with 'sites' and 'use'. "
      + "The approval URL is composed from the reviewed API origin and is never taken from a response. "
      + "The issued sign-in is written to credentials.json under $XDG_CONFIG_HOME/taproot-site/ (falling back to "
      + "~/.config/taproot-site/), directory 0700 and file 0600, one per API origin, replacing any sign-in already "
      + "stored for that origin. The secret itself is never displayed, logged, or placed in the JSON result: the "
      + "result names the credential by id and display prefix only. "
      + "The sign-in authorizes nothing on any site — it lists the account's sites and exchanges itself for "
      + "short-lived site credentials. It expires after 24 hours without a successful exchange, and any "
      + "expiry the approver chose bounds that: using the CLI keeps it alive, but never past their date. "
      + `${PUBLISH_KEY_ENVIRONMENT_VARIABLE} always takes precedence over the stored sign-in and skips the exchange `
      + "entirely, so existing automation is unaffected by logging in. "
      + "--quiet is rejected for this verb: the approval URL and code reach the operator only as progress, before "
      + "any JSON result exists, so silencing them would make the approval impossible to complete. "
      + "A denied, expired, or timed-out approval stores nothing. If Taproot reports the authorization was already "
      + "claimed, a credential was issued that this command never received: revoke it under Account -> Settings -> "
      + "API keys.",
  },
  {
    name: VERB_LOGOUT,
    tokens: ["logout"],
    summary: "Discard the stored Taproot sign-in.",
    credentialFree: true,
    configFree: true,
    note: "Removes the stored sign-in for this API origin and reports whether one was there. This is a local discard "
      + "only: it does not revoke anything, and the credential stays valid until an owner revokes it under "
      + "Account -> Settings -> API keys. Logging out with nothing stored is a success.",
  },
  {
    name: VERB_SITES,
    tokens: ["sites"],
    summary: "List this account's sites and the authoring verbs each accepts.",
    configFree: true,
    note: "Runs on the stored sign-in rather than a site credential, and is one of exactly two things that credential "
      + "can do. Every standard and Docs site on the account is listed with its kind and authoring surface: a "
      + "standard site takes every verb; a managed Docs site takes design and theming only (pull, theme push, "
      + "footer push, media upload, deploy, status), because its pages, navigation, and redirects come from the "
      + "Docs artifact; a prebuilt Docs site takes no verb at all. 'use' can select any of them.",
  },
  {
    name: VERB_USE,
    tokens: ["use"],
    summary: "Choose the site the next command writes to.",
    configFree: true,
    positionals: "siteSelector",
    note: "Accepts a site id, an exact name, or an unambiguous case-insensitive name, and records the choice as "
      + "siteId in taproot-site.json — creating that file in the current directory when there is not one yet — "
      + "together with the site's authoringSurface, which is what lets a later verb refuse offline when the site "
      + "cannot take it. Two sites sharing a name is refused rather than guessed: pass the site id instead.",
  },
  {
    name: VERB_WHOAMI,
    tokens: ["whoami"],
    summary: "Report the Taproot, account, site, and sign-in expiry in effect.",
    credentialFree: true,
    configFree: true,
    offline: true,
    // Offline but not self-contained: it reads both the store and the
    // configuration, so it accepts --config and must not claim otherwise.
    readsLocalState: true,
    note: "Answers entirely from local state — the stored sign-in and the configuration — so it still works when the "
      + `network or the credential does not. Reports whether ${PUBLISH_KEY_ENVIRONMENT_VARIABLE} is set, but never `
      + "its value. The sign-in secret is never printed; the credential is named by id and display prefix, which are "
      + "what an owner needs to revoke it.",
  },
  {
    name: VERB_ENV,
    tokens: ["env"],
    summary: "Show or switch which Taproot the CLI talks to.",
    credentialFree: true,
    configFree: true,
    offline: true,
    // Offline, but it reads the stored endpoint and the credential store to
    // report whether you are signed in where you just switched to.
    readsLocalState: true,
    positionals: "environmentSelector",
    note: "With no argument it reports the current Taproot and whether this machine is signed in to it; with "
      + "'production' or 'local' it switches. The choice is remembered per machine, beside the credential, because "
      + "it has to be known before any taproot-site.json exists — 'login', 'sites', and 'use' all run before the "
      + "file 'use' writes. Sign-ins are stored per origin, so switching away and back finds the one that was "
      + "already there. An explicit loopback URL ending in '/api' is accepted for development; nothing else is.",
  },
  {
    name: VERB_PULL,
    surface: SURFACE_DOCS_PRESENTATION,
    // Pages and the four settings groups, and every one of those gates on
    // site.theme.manage — so a read-only snapshot still needs Design.
    capabilities: [CAPABILITY_CONTENT, CAPABILITY_DESIGN],
    tokens: ["pull"],
    summary: "Snapshot pages, navigation, and settings into the local workspace.",
    note: "Every page path keeps exactly one authoritative source. A page whose manifest entry names a source that is "
      + "still on disk keeps that file, so pull never writes a '.pm.json' beside a tracked '.md'. "
      + "For a page tracked as Markdown the site's own document is kept as internal state under "
      + "'.taproot-site-state/' instead; it is never a page source and is never pushed. "
      + "To change a page's source format, remove the tracked source and author the other format beside it — two "
      + "editable sources for one path is a refusal, not a guess. "
      + "Markdown is deliberately one-way, so a page edited on the site since the last pull cannot be rewritten as "
      + "Markdown: pull refuses with pages.pull_conflict before changing anything under 'pages/', preserves the "
      + "site's version under '.taproot-site-state/', and leaves you to either push the local source or delete it "
      + "and pull again. A locally edited '.pm.json' is kept rather than overwritten for the same reason. "
      + "First revisions adopted without a completed body comparison are counted in pages.revisionsRecordedWithoutBodyComparison "
      + "and announced on the human channel. New downloads and compared bodies are excluded. "
      + "A page Taproot generates (a tag, an archive, a place, a folder) is pulled as an update-only '.pm.json' "
      + "(template 'generated'): you edit its custom title, breadcrumb title, custom description and introduction, "
      + "and the manifest keeps the title and description the site reports.",
  },
  {
    name: VERB_PAGES_META_SET,
    tokens: ["pages", "meta", "set"],
    offline: true,
    // Offline, but it reads taproot-site.json and edits the workspace manifest.
    readsLocalState: true,
    writesWorkspace: true,
    metaOptions: true,
    positionals: "metaPagePath",
    summary: "Set a tracked page's title, description or author in the workspace; 'pages push' sends it.",
    note: "Names one page by its path ('/' for the homepage) and sets --title, --description, --author, or any of "
      + "them, in the workspace's record of that page. A .pm.json page keeps its title, description and author "
      + "there, so this is the supported way to change them; a Markdown page keeps them in its front matter, which "
      + "is edited instead. --author names a site author by handle or a member by email address (see 'authors "
      + "list'); it only fills a page that has no author, and a page that already has a different one is refused "
      + "(pages.author_conflict). A name missing from authors.json is only warned about (authors.json can be older "
      + "than the site's list); 'pages push' checks it against the site. --author \"\" drops an author that has not "
      + "been sent; it never removes the site's. "
      + "A generated page keeps its own in its source (data.customTitle and data.customDescription), which this "
      + "edits; an empty --title or --description there clears the custom value so the page uses its generated one. "
      + "A description longer than 160 characters is warned about (search results cut it off) and one longer than "
      + "1000 is refused. Nothing is sent: run 'pages push', then 'approve'.",
  },
  {
    name: VERB_AUTHORS_LIST,
    surface: SURFACE_STANDARD,
    // Naming an author is part of writing a page, and the site gates both the
    // list and the creation on the permission that creates pages (TR01196).
    capabilities: [CAPABILITY_CONTENT],
    tokens: ["authors", "list"],
    summary: "List the site authors and the members a page can be credited to; refreshes authors.json.",
    note: "A page's author is a site author without a Taproot account (named by handle, such as jane-doe) or a site "
      + "member who can create pages (named by email address). Pages are authorless unless a source names one, and "
      + "an author already on a page is never replaced. The result lists authors { handle, displayName, hasEmail } "
      + "and members { email, displayName }, and rewrites authors.json, which the offline checks ('validate', "
      + "'pages meta set') read to warn about a name it lacks. authors.json holds members' email addresses: keep it "
      + "out of a public repository. "
      + "A site author's own address is private and is never listed or written.",
  },
  {
    name: VERB_AUTHORS_ADD,
    surface: SURFACE_STANDARD,
    capabilities: [CAPABILITY_CONTENT],
    tokens: ["authors", "add"],
    positionals: "authorHandle",
    authorOptions: true,
    summary: "Create a site author, someone a page can be credited to who has no Taproot account.",
    note: "Give the handle (lowercase letters, digits and single hyphens, at most 64 characters; it never changes) "
      + "and --name, the name readers see on the byline. --email is optional: it is kept private, never published, "
      + "and lets the person be linked to a Taproot account later. Then credit pages to the author with "
      + "'author: <handle>' in a page's front matter or 'pages meta set <path> --author <handle>'. A handle the site "
      + "already has under another name is refused (authors.handle_taken); under the same name it succeeds with "
      + "existing: true. authors.json is updated with the new author.",
  },
  {
    name: VERB_PAGES_PUSH,
    surface: SURFACE_STANDARD,
    capabilities: [CAPABILITY_CONTENT],
    tokens: ["pages", "push"],
    dryRun: true,
    summary: "Create and update pages from the local workspace.",
    positionals: "pagePaths",
    note:
      "Positional page paths narrow the push to those pages; with none, every workspace page is validated and sent. "
      + "A link in a page being sent whose address is only http(s):// plus its own text is reported in linkWarnings "
      + "(content.link_autolinked) without refusing. "
      + "A page is created without an author unless its source names one ('author:' in the front matter, or 'pages "
      + "meta set --author'); the pages created that way are listed in pages.authorless with how to credit them. "
      + "The homepage is recorded with an empty path, so address it as '/'. "
      + "A selected path resolves to its one authoritative source from metadata alone, and that page is then validated "
      + "exactly as a whole push would validate it — site binding, manifest integrity, live create-or-update "
      + "resolution, system-page rules, path uniqueness against the live site, media ownership, a live page whose "
      + "stored-state revision moved since this workspace last reconciled with it (pages.push_conflict), and two "
      + "workspace files claiming one path all still fail closed. What a selection does not do is convert or validate the "
      + "documents of pages it is not sending: an unrelated page left on an obsolete contract is reported by the "
      + "whole-workspace push, not used to block this one. The result states the selection and how many sources were "
      + "discovered and validated. "
      + "Every selected page is checked before anything is sent, and a refusal lists every problem found in "
      + "error.problems with its file, code, and field. --dry-run does all of that against the live site, reports "
      + "which pages would be created, updated, or left unchanged, and sends nothing; it exits 1 when there are "
      + "problems. "
      + "A generated page's source is update-only: a push refuses to create one (pages.generated_create), move it "
      + "(pages.generated_move), or change what it is (pages.generated_identity). A generated page you did not edit "
      + "never blocks a whole-workspace push, and one the site no longer has is reported as pages.staleGeneratedSources "
      + "and skipped (naming its path refuses with pages.generated_create). "
      + "See 'taproot-site help page free-form' for the stable manifest and error contract.",
  },
  {
    name: VERB_PLACES_SEARCH,
    surface: SURFACE_STANDARD,
    // A key finds the places for the place reviews it writes, so page editing
    // is what it needs; each search is a billed Google Places request.
    capabilities: [CAPABILITY_CONTENT],
    tokens: ["places", "search"],
    positionals: "placeQuery",
    summary: "Search Google Places for the place a review names; reports predictions and a session token.",
    note: "Give the place's name and city, such as 'places search Blue Bottle Coffee Oakland'. Each prediction "
      + "carries a googlePlaceId; pass the one that matches, with the reported sessionToken, to 'places select' to "
      + "get the Taproot placeId a place review's front matter needs. Searches and the select that follows them are "
      + "one billed session, so search with a precise query rather than many broad ones.",
  },
  {
    name: VERB_PLACES_SELECT,
    surface: SURFACE_STANDARD,
    capabilities: [CAPABILITY_CONTENT],
    tokens: ["places", "select"],
    positionals: "placeSelection",
    summary: "Record a places search prediction as a Taproot place and report its placeId.",
    note: "Takes the googlePlaceId from 'places search', then that search's sessionToken. The place is recorded "
      + "once for every site, so selecting it again returns the same placeId. Use it as placeId in a place review, "
      + "or as place in an article or album.",
  },
  {
    name: VERB_PLACES_CATEGORY_SET,
    surface: SURFACE_STANDARD,
    // Changes what the site's place reviews publish, so it needs page editing.
    capabilities: [CAPABILITY_CONTENT],
    tokens: ["places", "category", "set"],
    positionals: "placeCategory",
    summary: "Set this site's category for a place, from the closed category list.",
    note: "Takes the placeId from 'places select' (or a page's front matter), then one category from "
      + "'places category list', which prints the closed list; a name outside it is refused, and capitalization is "
      + "ignored. Use it when Google's own category for a place is not the one this site wants, such as a park filed "
      + "under Other. The category is this site's alone and applies to every review of that place here: the place "
      + "itself and other sites do not change. Place-review bylines and the /places/<category> pages use it from the "
      + "next deployment, which a changed category alone is enough to start. Undo it with 'places category clear'.",
  },
  {
    name: VERB_PLACES_CATEGORY_CLEAR,
    surface: SURFACE_STANDARD,
    capabilities: [CAPABILITY_CONTENT],
    tokens: ["places", "category", "clear"],
    positionals: "placeId",
    summary: "Remove this site's category for a place, so the place's own category applies again.",
    note: "Takes the placeId. Clearing a place this site never set succeeds and changes nothing. Pages use the "
      + "place's own category from the next deployment.",
  },
  {
    name: VERB_PLACES_CATEGORY_LIST,
    surface: SURFACE_STANDARD,
    capabilities: [CAPABILITY_CONTENT],
    tokens: ["places", "category", "list"],
    summary: "List the place categories 'places category set' accepts.",
    note: "The list is closed: a category outside it is refused.",
  },
  {
    name: VERB_PLAN,
    surface: SURFACE_STANDARD,
    // Pages, media and navigation reads are Content; the presentation read and
    // the footer draft are Design. The same set apply writes with.
    capabilities: [CAPABILITY_CONTENT, CAPABILITY_DESIGN],
    tokens: ["plan"],
    summary: "Check the whole workspace against the live site and order what is left to send. Writes nothing.",
    note: "Runs every check the pushes run — each page against the site's pages, revisions and videos; media that "
      + "pages reference and media upload has not sent; the theme, appearance and footer colors against the site's "
      + "presentation revision; the footer against its draft; navigation against the live page list — and lists "
      + "every problem with its area, file, code and field. It then orders the steps that remain: media upload, "
      + "pages push, footer push (theme push refuses unsaved footer content), theme push, nav push, each marked "
      + "ready, blocked, or nothing to do with the reason for its place. The result's planHash covers what each "
      + "step would send and the live state it would meet; pass it to 'apply'. Redirects and forms are not "
      + "covered: push them on their own. Approval and deployment stay separate.",
  },
  {
    name: VERB_APPLY,
    surface: SURFACE_STANDARD,
    capabilities: [CAPABILITY_CONTENT, CAPABILITY_DESIGN],
    tokens: ["apply"],
    planHash: true,
    summary: "Run the steps a plan listed, in order, through the ordinary push verbs.",
    note: "Plans again first and refuses with apply.plan_stale when the workspace or the site moved since the plan "
      + "you read, and with the plan's problems when it has any; nothing is written either way. While the steps "
      + "run, any workspace file read differently from the plan, or not read by the plan at all, stops the step "
      + "before it writes (apply.plan_stale, naming the file); so does a page revision or the site's navigation "
      + "that moved, and the theme and footer saves are refused by the site when it moved. Steps are not "
      + "atomic together: when one fails, the error's completedWrites lists the steps that completed, the one that "
      + "failed, and those that did not run. Run 'plan' again — finished steps read as nothing to do, and a step "
      + "whose answer was lost is reconciled by its own verb, never repeated blindly. Pages land as drafts; "
      + "'approve' and 'deploy' remain separate.",
  },
  {
    name: VERB_NAV_PUSH,
    surface: SURFACE_STANDARD,
    // Content is for the read, not the write: every PAGE nav item is checked
    // against the live page list before the tree is replaced, and that list is
    // gated on site.pages.edit_any (TR00691).
    capabilities: [CAPABILITY_CONTENT, CAPABILITY_DESIGN],
    tokens: ["nav", "push"],
    summary: "Replace the whole navigation tree from the local workspace.",
  },
  {
    name: VERB_REDIRECTS_CHECK,
    surface: SURFACE_STANDARD,
    capabilities: [CAPABILITY_CONTENT, CAPABILITY_DEPLOYMENTS],
    tokens: ["redirects", "check"],
    summary: "Check the current redirect map through the authenticated staging edge.",
    note: "Reports each entry's path, HTTP status and Location in redirects.items, and redirects.verified, without "
      + "following redirects. A redirect is live only with the release that carries it, so this reads the staged release. "
      + "The result includes a fresh single-use staging handoff in stagingPreview.url; keep it private.",
  },
  {
    name: VERB_REDIRECTS_PULL,
    surface: SURFACE_STANDARD,
    // A redirect is a content path, and both halves of the map — read and
    // replace — are gated on site.pages.edit_any, which only Content carries.
    capabilities: [CAPABILITY_CONTENT],
    tokens: ["redirects", "pull"],
    summary: "Snapshot the site's whole redirect map into redirects.json.",
    note: "Also part of 'pull'. Run it on its own to re-read the map after a page rename, or after a push was "
      + "refused as a conflict, without re-pulling every page. It records the map's revision in the pull "
      + "manifest; 'redirects push' sends that revision so a stale replace is refused rather than deleting an "
      + "entry a rename recorded. See 'taproot-site help redirects'.",
  },
  {
    name: VERB_REDIRECTS_PUSH,
    surface: SURFACE_STANDARD,
    capabilities: [CAPABILITY_CONTENT],
    tokens: ["redirects", "push"],
    summary: "Validate redirects.json and replace the whole redirect map.",
    note: "Run 'redirects pull' first. The whole file is validated locally by entry index — path normalization, "
      + "targets, statuses, duplicates, chains, and loops — before anything is sent, and the site refuses a "
      + "source a live page occupies or a file the site generates. An entry is a file inside the next release, so it "
      + "goes live with that deploy: staging first, production when promoted. "
      + "See 'taproot-site help redirects'.",
  },
  {
    name: VERB_FORMS_PULL,
    surface: SURFACE_STANDARD,
    // Forms are authored with the pages that place them, so they ride the
    // content capability; the site's forms permissions decide what it may do.
    capabilities: [CAPABILITY_CONTENT],
    tokens: ["forms", "pull"],
    summary: "Write each live form to forms/<key>.json and record the versions read.",
    note: "Needs a pulled workspace ('pull' first). It replaces a form's file with the site's copy and records the "
      + "version, which 'forms push' uses to refuse a change made on the site since. An archived form is listed "
      + "and not written. Submissions are never pulled: they are visitors' personal data and stay on the site. "
      + "See 'taproot-site help forms'.",
  },
  {
    name: VERB_FORMS_PUSH,
    surface: SURFACE_STANDARD,
    capabilities: [CAPABILITY_CONTENT],
    tokens: ["forms", "push"],
    positionals: "formKeys",
    summary: "Validate forms/<key>.json and create or update each form on the site.",
    note: "Every file is validated and compared with the site before anything is written. A form whose site "
      + "version moved since the last pull is refused (forms.concurrent_modification), and a form the site has "
      + "that this workspace never pulled is refused (forms.pull_required). Editing a definition appends a version; "
      + "a page keeps the version it was published with until the next deploy. An after_submit page_path is looked "
      + "up on the site, and a path that names no page is refused (forms.page_not_found), as is a generated, 404, legal, profile or integration page (forms.page_not_allowed). Name form keys to narrow "
      + "the push. See 'taproot-site help forms'.",
  },
  {
    name: VERB_FORMS_VALIDATE,
    tokens: ["forms", "validate"],
    offline: true,
    // Offline, but it reads taproot-site.json to find the workspace.
    readsLocalState: true,
    positionals: "formKeys",
    summary: "Validate the workspace's form files offline, against the shared field schema.",
    note: "Reads forms/<key>.json and checks the file contract and every field definition with the same validator "
      + "'forms push' and the published form use. Name form keys to narrow it; with none, every file under forms/ "
      + "is checked. It cannot prove that the site accepts the key, that an after_submit page_path names a page, or "
      + "that the caller may write forms. "
      + "See 'taproot-site help forms'.",
  },
  {
    name: VERB_THEME_PUSH,
    surface: SURFACE_DOCS_PRESENTATION,
    capabilities: [CAPABILITY_DESIGN],
    tokens: ["theme", "push"],
    dryRun: true,
    summary: "Validate and push the workspace's complete theme and appearance settings in one atomic save.",
    note: "Run pull first. Theme JSON stays decoded in the workspace; this command validates the complete light/dark"
      + " pair and encodes it only at the API boundary. Image settings reference site-owned image IDs from media upload. "
      + "The complete change set — both themes, the appearance scalars, and the ten footer scheme colors — is saved in "
      + "one transaction fenced by the presentation revision pull recorded: a concurrent change to any of those "
      + "fields refuses the whole push (theme.concurrent_modification) and nothing is written. A save whose response "
      + "was lost is replayed safely; the site answers applied=false when it already holds the change set. "
      + "--dry-run reads the site, reports the JSON paths at which each settings file differs from it and whether "
      + "the recorded baseline is still current, and writes nothing. "
      + "Validation includes Espalier's fit report over the root and every context in both schemes; each lint prints "
      + "as a warning naming 'fit lint <id>' and does not stop the push, so read them in a --dry-run first. "
      + "pull writes each scheme's complete effective theme — the stored theme resolved over the same defaults every "
      + "consumer renders — so a fresh workspace validates as pulled. semanticMappings holds only authored pins, listed "
      + "in explicitMappingTokens at the root (a context's pins need no marker); every other token compiles from roles "
      + "at render time, so never copy default mappings into a theme: a pinned token shadows its role. Contrast and "
      + "status-color warnings name the nearest passing value the CLI found and checked.",
  },
  {
    name: VERB_FOOTER_PUSH,
    surface: SURFACE_DOCS_PRESENTATION,
    capabilities: [CAPABILITY_DESIGN],
    tokens: ["footer", "push"],
    summary: "Validate and replace the workspace's complete footer document.",
    note: "Run pull first. The command validates the whole closed footer locally, uses the pulled draft hash,"
      + " and refuses a concurrent remote edit with re-pull guidance.",
  },
  {
    name: VERB_MEDIA_UPLOAD,
    surface: SURFACE_DOCS_PRESENTATION,
    capabilities: [CAPABILITY_CONTENT],
    // On a managed Docs site Content is not on offer, and narrowing the
    // request above by intersection would leave nothing — which the exchange
    // reads as "the whole surface envelope", Deployments included. Design
    // carries site.media.manage too, so that is what this verb asks for there
    // (TR00790).
    surfaceCapabilities: { [SURFACE_DOCS_PRESENTATION]: [CAPABILITY_DESIGN] },
    tokens: ["media", "upload"],
    summary: "Upload images and videos; images are waited on until processed, and a video is ready when it confirms.",
    positionals: "paths",
    note: "Positional arguments name the files or directories to upload;"
      + " with none, the workspace's media/ directory is walked.",
  },
  {
    name: VERB_APPROVE,
    surface: SURFACE_STANDARD,
    capabilities: [CAPABILITY_CONTENT],
    tokens: ["approve"],
    summary: "Publish drafts. This stages the site; it does not deploy it.",
    positionals: "pagePaths",
    note: "Positional arguments narrow the selection to those page paths;"
      + " with none, every draft the workspace manifest tracks is staged."
      + " The homepage is recorded with an empty path, so address it as '/'."
      + " A named page with no pending draft (already approved, or published with no new draft) is listed in"
      + " skipped { total, items: [{ pageId, path, status, reason }] } and the rest are approved; a path that names"
      + " no page this workspace tracks refuses the whole call.",
  },
  {
    name: VERB_DEPLOY,
    surface: SURFACE_DOCS_PRESENTATION,
    // Deployments is the only capability this verb *writes* with; the other two
    // are for reads and re-reads the server makes on its behalf (TR00691).
    // Content: staging redirect checks read the current redirect map;
    // production also re-authorizes the stored candidate's pages.
    // Design: --production promotes a completed staging deployment, and the
    // pipeline re-authorizes that deployment's *stored* candidate — every
    // selected settings group and its navigation — against site.theme.manage,
    // which only Design carries. Every candidate this CLI stages from a pulled
    // workspace carries settings, navigation, or both, so a promotion without
    // Design is refused.
    capabilities: [CAPABILITY_CONTENT, CAPABILITY_DESIGN, CAPABILITY_DEPLOYMENTS],
    tokens: ["deploy"],
    summary: "Deploy to staging, or promote staging to production.",
    target: true,
    note: "deploy --staging returns a single-use review handoff in stagingPreview.url, on a managed Docs site too, "
      + "where it stages settings only: open the URL once, then switch the site's theme toggle to review both "
      + "schemes before deploy --production. If no handoff could be minted, stagingPreview.reason names why and "
      + "stagingPreview.recovery the next step; 'staging review' mints another. On a Standard site the result also "
      + "carries the automatic redirect check: routeCheck and redirects (see 'help redirects').",
  },
  {
    name: VERB_PREVIEW_PAGE,
    surface: SURFACE_STANDARD,
    capabilities: [CAPABILITY_CONTENT],
    tokens: ["preview", "page"],
    summary: "Render one persisted draft and mint a short-lived staging handoff.",
    positionals: "pageSelector",
    json: true,
    note: "Select the persisted draft by page path (as recorded by pull) or canonical lowercase UUID. "
      + "The homepage is recorded with an empty path, so address it as '/'. "
      + "Preview before approving: approve consumes the draft, so a page that has been approved has no draft "
      + "left to render and answers preview.no_draft. Review it on staging after a deploy instead. A preview "
      + "captured before approval stays revocable afterwards: preview revoke addresses the snapshot itself. "
      + "The handoff URL in the result is single-use and expires two minutes after it is minted: opening it "
      + "consumes it, and a reused, shared, or bookmarked preview URL answers Not found. Run preview page again "
      + "for another. "
      + "--json is accepted"
      + " explicitly for agent invocations, though every operational success and failure is already JSON.",
  },
  {
    name: VERB_PREVIEW_REVOKE,
    surface: SURFACE_STANDARD,
    capabilities: [CAPABILITY_CONTENT],
    tokens: ["preview", "revoke"],
    summary: "Revoke an active authoring preview and schedule its artifacts for cleanup.",
    positionals: "previewIds",
    json: true,
    note: "Supply the canonical lowercase page UUID followed by the snapshot UUID returned by preview page.",
  },
  {
    name: VERB_DELIVERY_CHECK,
    surface: SURFACE_DOCS_PRESENTATION,
    // Deployments reads the deployment log and mints the staging handoff the
    // check consumes; the public target itself needs no credential.
    capabilities: [CAPABILITY_DEPLOYMENTS],
    tokens: ["delivery", "check"],
    summary: "Verify what a visitor receives after a deployment completed: routes, assets, runtime, browser.",
    target: true,
    deliveryOptions: true,
    note: "A completed deployment job is not a verified delivery. This read-only check reads the target the way a "
      + "visitor does and reports each dimension separately: the latest completed deployment for the target, HTTP "
      + "delivery of the authored routes (from the workspace manifest, bounded), the favicon, images, module "
      + "preloads and site bundle they reference, internal link targets, accidental local-only references, and the "
      + "pinned runtime (its version, entry module and capability modules), plus a browser "
      + "dimension that runs only when Playwright is installed and is reported as unchecked otherwise. --staging "
      + "resolves the acknowledged staging host and authorizes one preview session for the run (--url is refused "
      + "there); --production needs --url https://<published-domain>/ because a site-authoring key cannot read "
      + "hosting configuration. Only assets on the site's own origin and the runtime the page declares are "
      + "fetched. --wait "
      + "<seconds> (at most 120) observes everything once more after that pause for edge propagation. --no-browser skips "
      + "the browser dimension. Nothing is purged, republished or rolled back.",
  },
  {
    name: VERB_STAGING_REVIEW,
    surface: SURFACE_DOCS_PRESENTATION,
    capabilities: [CAPABILITY_DEPLOYMENTS],
    tokens: ["staging", "review"],
    summary: "Mint a fresh single-use review handoff for the site's staging host.",
    note: "The handoff URL is reported only in the final JSON as stagingPreview.url, is single-use, and expires two "
      + "minutes after it is minted; keep it private. Open it once, then use the site's theme toggle to review both "
      + "schemes. This is the recovery when deploy --staging could not mint a handoff, on a managed Docs site too.",
  },
  {
    name: VERB_STATUS,
    surface: SURFACE_DOCS_PRESENTATION,
    // Readiness and the deployment log are Deployments; the image list is
    // Content, as is the broken-reference report.
    capabilities: [CAPABILITY_CONTENT, CAPABILITY_DEPLOYMENTS],
    tokens: ["status"],
    summary:
      "Report the platform authoring switch, CLI release, deployments, readiness, image processing, and broken references.",
    note: "Broken references list pages with missing image IDs or page paths in their latest editable body."
      + " Content permission is required; a refused or failed read fails status rather than reporting a clean site.",
  },
]);

/**
 * The shipped verb table's capability declarations, keyed by verb name.
 *
 * Exported so the tests enforce the table rather than restate it. The claim
 * each entry makes — "this is the smallest set this verb's requests need" —
 * went four releases without anything checking it, and it was wrong twice:
 * `nav push` and `deploy` were each short of a read they make on every run, and
 * `deploy` was short again of the promotion re-authorization the server runs on
 * state the request only names (TR00691). A verb with no entry needs no site
 * credential at all.
 */
export const VERB_CAPABILITIES = Object.freeze(Object.fromEntries(
  VERBS
    .filter((verb) => verb.capabilities !== undefined)
    .map((verb) => [verb.name, Object.freeze([...verb.capabilities])]),
));

/**
 * The shipped verb table's surface declarations, keyed by verb name (TR00790):
 * `standard` for verbs only a STANDARD site takes, `docs-presentation` for
 * verbs a managed Docs site takes too. A verb with no entry is not a site verb.
 */
export const VERB_SURFACES = Object.freeze(Object.fromEntries(
  VERBS
    .filter((verb) => verb.surface !== undefined)
    .map((verb) => [verb.name, verb.surface]),
));

/**
 * The capabilities each site verb's exchange asks for on a given surface
 * (TR00790): the verb's declared set narrowed to what the surface offers, or
 * the verb's own per-surface declaration where narrowing alone would be wrong.
 * Exported so the tests can pin that no verb ever asks for nothing — an empty
 * request means "everything the surface offers" on the wire.
 */
export function verbCapabilitiesForSurface(verbName, surface) {
  const verb = VERBS.find((candidate) => candidate.name === verbName);
  if (verb?.capabilities === undefined) return undefined;
  return verb.surfaceCapabilities?.[surface] ?? capabilitiesForSurface(surface, verb.capabilities);
}

const COMMON_OPTIONS = `Options:
  --config <path>  Place before a config-reading verb; bypass parent discovery.
  --quiet          Suppress human progress. The JSON result is unchanged.
  --help           Show this help.
  --version        Show the package version.`;

const HELP = `Usage: ${CLI_BINARY_NAME} [--config <path>] <verb> [options]

Authoring verbs drive one Taproot site through the authoring surface. Start with
login, then sites and use to choose which site those verbs write to. Commands
talk to production unless 'env local' says otherwise; that choice is remembered
per machine, not per project.

The site credential is taken from ${PUBLISH_KEY_ENVIRONMENT_VARIABLE} when it is
set; otherwise it is minted for each run by exchanging the account sign-in that
login stores outside the repository. There is no flag for either. The sign-in
authorizes nothing on any site: it lists sites and buys short-lived site
credentials, and it expires 24 hours after it is issued.

Verbs write one JSON result to stdout and human progress to stderr. validate,
help, whoami, and env are offline and read-only. login, logout, sites, use,
whoami, and env need no configuration and no site. The offline help family is
human-readable by default; add --json for stable reference data. Exit codes: 0
success, 1 failure, 2 usage fault.

Install globally (npm install --global @taprootio/site-authoring) or run the
current release without installing: npx --yes @taprootio/site-authoring@latest
<verb>. An unversioned npx keeps whatever copy it cached, so always name
@latest; check what is running with --version, and compare it with the
release status reports as cliRelease.

Troubleshooting: a command that fails with field=CliUpgradeRequired (or
refusal=cli_outdated) means this CLI is behind the latest published release,
which is the only release Taproot accepts. Nothing is wrong with the
credential, the request, or the site, and no retry of this version succeeds.
Run '${CLI_UPGRADE_COMMAND}' and try again; if the
release is minutes old, npm may not serve it yet, so wait and retry the
upgrade. Once a run has recorded a newer release, help, validate, and whoami
refuse the same way offline. --version and --help always answer.

Verbs:
${VERBS.map((verb) => `  ${verb.tokens.join(" ").padEnd(20)} ${verb.summary}`).join("\n")}

Configuration:
  Site verbs read taproot-site.json, found by walking up from the current
  directory through a bounded number of parents. Exactly one must be found, or
  pass --config <path> before the verb. It is a closed JSON object:
    configVersion  must be 1
    siteId         optional; the canonical lowercase site UUID that 'use' writes
    authoringSurface  optional; 'standard', 'docs-presentation', or 'none' — the
                   verbs the site accepts, as 'use' recorded them. A verb the
                   surface cannot take is refused before any request
                   (surface.presentation_only, surface.none); Taproot re-checks
                   on every write, so run 'use' again after a Docs site changes
                   publication mode.
    workspaceDir   a relative POSIX path beneath the configuration directory
                   that pull writes into; every existing segment must be a real
                   directory
  Unknown or duplicate fields are refused. apiBaseUrl is not a field: which
  Taproot to talk to is machine state, set with 'env' and limited to
  app.taproot.io (the default), app.taproot.test, or an explicit loopback URL
  ending in /api. Sign-ins are stored per origin.

${COMMON_OPTIONS}
`;

function verbHelp(verb) {
  const targetUsage = verb.target ? " (--staging | --production)" : "";
  const positionalUsage = verb.positionals === "fixturePath"
    ? " [<directory>]"
    : verb.positionals === "pageSelector"
    ? " <page-path-or-id>"
    : verb.positionals === "previewIds"
    ? " <page-id> <snapshot-id>"
    : verb.positionals === "environmentSelector"
    ? " [production | local | <url>]"
    : verb.positionals === "siteSelector"
    ? " <site-name-or-id>"
    : verb.positionals === "formKeys"
    ? " [form-key...]"
    : verb.positionals === "placeQuery"
    ? " <query...>"
    : verb.positionals === "placeSelection"
    ? " <google-place-id> <session-token>"
    : verb.positionals === "placeCategory"
    ? " <place-id> <category>"
    : verb.positionals === "placeId"
    ? " <place-id>"
    : verb.positionals === "metaPagePath"
    ? " <page-path> [--title <text>] [--description <text>] [--author <handle-or-email>]"
    : verb.positionals === "authorHandle"
    ? " <handle> --name <display-name> [--email <address>]"
    : verb.positionals
    ? ` [${verb.positionals === "paths" ? "path" : "page-path"}...]`
    : "";
  const deliveryOptions = verb.deliveryOptions
    ? `\n  --url <origin>   The https origin to check; required for --production, refused for --staging.
  --wait <seconds> Re-check failures once after this pause (0-120) for edge propagation.
  --no-browser     Skip the browser dimension even when Playwright is installed.`
    : "";
  const targetOption = verb.target && !verb.deliveryOptions
    ? `\n  --staging        Deploy the staged site to staging.
  --production     Promote the completed staging deployment to production.
  --allow-failed-preview  Explicitly override the matching candidate's failed preview.`
    : "";
  const metaOptions = verb.metaOptions
    ? `\n  --title <text>       The page's title.
  --description <text> The page's description for search results and link previews; '' clears it.
  --author <ref>       Credit a page that has no author: a site author's handle or a member's email address.`
    : "";
  const authorOptions = verb.authorOptions
    ? `\n  --name <text>        The name readers see on the byline (required).
  --email <address>    A private address, kept to link the person to an account later (optional).`
    : "";
  const jsonOption = verb.json
    ? "\n  --json           Emit the stable JSON contract (operational output is always JSON)."
    : "";
  const dryRunOption = verb.dryRun
    ? "\n  --dry-run        Read the site and report what a push would change, without writing."
    : "";
  const planOption = verb.planHash
    ? "\n  --plan <hash>    The planHash 'plan' reported; required."
    : "";
  const nameOption = verb.keyName
    ? `\n  --name <text>    Name recorded on the issued key (default "${DEFAULT_LOGIN_KEY_NAME}",\n`
      + `                   1-${LOGIN_KEY_NAME_MAXIMUM} characters). The approval screen shows it.`
    : "";
  const note = verb.note ? `\n\n${verb.note}` : "";
  // `offline` means "makes no network request", and until TR00645 it also
  // implied "reads no configuration or credential". whoami is the first verb
  // where those diverge — offline, but it reads both — so `readsLocalState` is
  // the opt-out rather than a second positive flag every existing offline verb
  // would have had to gain.
  const selfContained = verb.offline && !verb.readsLocalState;
  const prefix = selfContained ? CLI_BINARY_NAME : `${CLI_BINARY_NAME} [--config <path>]`;
  // The offline boundary states the version gate too (TR00703). It is the one
  // thing these verbs read that is not their own input, and a boundary sentence
  // that omitted it would be describing a verb that no longer exists.
  // `env` is offline too and deliberately outside the gate — switching Taproots
  // is one of the things an outdated CLI must still be able to do — so the
  // sentence is attached per verb rather than to offline-ness.
  const upgradeGate = VERSION_GATED_OFFLINE_VERBS.includes(verb.name)
    ? " It refuses only when a previous sign-in exchange recorded a newer published release than this CLI, because "
      + "Taproot accepts only the latest; with nothing recorded it runs."
    : "";
  const boundary = verb.name === VERB_VALIDATE
    ? "Validation uses no credential, network or write; it reads the configuration only to find the workspace when "
      + "no directory is given. With --init it reads the pulled workspace or selected configuration and writes a new "
      + `fixture directory, still without credentials or network.${upgradeGate}`
    : selfContained
    ? "This offline verb uses no credential and reads no configuration, and performs no network request and no "
      + `write.${upgradeGate}`
    : verb.writesWorkspace
    ? "This verb edits only the local workspace: it reads the configuration, uses no credential, and makes no "
      + "network request."
    : verb.offline
    ? "This verb answers entirely from local state — the stored sign-in and the configuration — and makes no "
      + `network request and no write.${upgradeGate}`
    : verb.credentialFree
    ? `This verb reads the configuration but requires no existing credential. `
      + `${PUBLISH_KEY_ENVIRONMENT_VARIABLE} always takes precedence over the stored credential, so setting it leaves `
      + `existing automation unaffected by login and logout.`
    : `The site-scoped credential is taken from ${PUBLISH_KEY_ENVIRONMENT_VARIABLE} when it is set, and otherwise `
      + `from the credential '${CLI_BINARY_NAME} ${VERB_LOGIN}' stores outside the repository.`;
  const options = verb.name === VERB_VALIDATE
    ? `Options:
  --init           Export a pulled workspace into the new fixture directory.
  --config <path>  Before the verb; the configuration naming the workspace (no
                   directory) or the --init source.
  --quiet          Suppress human progress. The JSON result is unchanged.
  --help           Show this help.
  --version        Show the package version.`
    : selfContained
    ? `Options:
  --quiet          Suppress human progress. The JSON result is unchanged.
  --help           Show this help.
  --version        Show the package version.`
    : verb.name === VERB_LOGIN
    // Login's option block must not advertise --quiet: the verb rejects it
    // (the approval URL exists only as progress), and an Options list that
    // contradicts the note two paragraphs below it is worse than either alone.
    ? `Options:
  --config <path>  Place before the verb; bypass parent discovery.
  --help           Show this help.
  --version        Show the package version.`
    : COMMON_OPTIONS;
  const deliveryTargetOption = verb.deliveryOptions
    ? `\n  --staging        Check the staging target.
  --production     Check the production target.${deliveryOptions}`
    : "";
  return `Usage: ${prefix} ${verb.tokens.join(" ")}${positionalUsage}${targetUsage} [options]

${verb.summary}
${boundary}

${options}${targetOption}${deliveryTargetOption}${metaOptions}${authorOptions}${jsonOption}${dryRunOption}${planOption}${nameOption}${note}
`;
}

function matchVerb(arguments_) {
  let matched;
  for (const verb of VERBS) {
    if (
      verb.tokens.every((token, index) => arguments_[index] === token)
      && (matched === undefined || verb.tokens.length > matched.tokens.length)
    ) {
      matched = verb;
    }
  }
  return matched;
}

function usageError(code, message, options = {}) {
  return new SiteAuthoringError(code, message, { ...options, exitCode: 2 });
}

function parseReferenceArguments(arguments_) {
  if (arguments_.length === 1 && arguments_[0] === "--version") return { mode: "version" };
  if (arguments_.length === 1 && arguments_[0] === "--help") {
    return { mode: "reference", topic: "topics", json: false };
  }

  let json = false;
  const terms = [];
  for (const argument of arguments_) {
    if (argument === "--json") {
      if (json) throw usageError("help.usage", "--json may be supplied only once.");
      json = true;
      continue;
    }
    if (argument.startsWith("-")) {
      throw usageError("help.usage", "Reference help accepts only --json after its topic.");
    }
    terms.push(argument);
  }

  if (terms.length === 0) return { mode: "reference", topic: "topics", json };
  const [topic, subject, ...extra] = terms;
  const topicNames = REFERENCE_TOPICS.map((entry) => entry.name);
  if (!topicNames.includes(topic)) {
    throw usageError(
      "help.topic_unknown",
      `Unknown reference topic. Expected one of: ${topicNames.join(", ")}.`,
      { alternatives: topicNames },
    );
  }
  if (
    (
      topic === "pages"
      || topic === "components"
      || topic === "designs"
      || topic === "nav"
      || topic === "media"
      || topic === "preview"
      || topic === "theme"
      || topic === "appearance"
      || topic === "footer"
      || topic === "fixture"
      || topic === "redirects"
      || topic === "forms"
      || topic === "walkthrough"
      || topic === "delivery"
      || topic === "import"
    )
    && (subject !== undefined || extra.length > 0)
  ) {
    throw usageError("help.usage", `The '${topic}' topic does not accept a name.`);
  }
  if (topic === "fonts" && extra.length > 0) {
    throw usageError("help.usage", "The 'fonts' topic accepts at most one category.");
  }
  if ((topic === "page" || topic === "component" || topic === "design") && (subject === undefined || extra.length > 0)) {
    throw usageError("help.usage", `The '${topic}' topic requires exactly one name.`);
  }
  return { mode: "reference", topic, subject, json };
}

function referenceResult(parsed) {
  const result = {
    schemaVersion: RESULT_SCHEMA_VERSION,
    ok: true,
    cli: { name: CLI_NAME, version: CLI_VERSION },
    verb: VERB_HELP,
    referenceVersion: REFERENCE_VERSION,
  };
  switch (parsed.topic) {
    case "topics":
      return { ...result, topic: "topics", topics: REFERENCE_TOPICS };
    case "pages":
      return { ...result, topic: "page-types", pageTypes: listPageTypeReferences() };
    case "components":
      return { ...result, topic: "component-types", components: listComponentTypeReferences() };
    case "designs":
      return { ...result, topic: "design-types", designs: listDesignBlueprints() };
    case "page": {
      const page = getPageTypeReference(parsed.subject);
      if (!page) {
        throw usageError(
          "help.page_type_unknown",
          `Unknown page type. Expected one of: ${PAGE_TYPES.join(", ")}.`,
          { alternatives: PAGE_TYPES },
        );
      }
      return { ...result, topic: "page", page };
    }
    case "component": {
      const component = getComponentReference(parsed.subject);
      if (!component) {
        const alternatives = listComponentTypeReferences().map((entry) => entry.type);
        throw usageError(
          "help.component_type_unknown",
          `Unknown component type. Expected one of: ${alternatives.join(", ")}.`,
          { alternatives },
        );
      }
      return { ...result, topic: "component", component };
    }
    case "design": {
      const design = getDesignBlueprint(parsed.subject);
      if (!design) {
        throw usageError(
          "help.design_type_unknown",
          `Unknown design type. Expected one of: ${DESIGN_TYPES.join(", ")}.`,
          { alternatives: DESIGN_TYPES },
        );
      }
      return { ...result, topic: "design", design };
    }
    case "nav":
    case "redirects":
    case "forms":
    case "media":
    case "preview":
    case "fixture":
    case "walkthrough":
    case "delivery":
    case "import":
      return {
        ...result,
        topic: "workflow",
        referenceKind: parsed.topic,
        reference: getWorkflowReference(parsed.topic),
      };
    case "fonts": {
      const fonts = getFontCatalogReference(parsed.subject);
      if (!fonts) {
        throw usageError(
          "help.font_category_unknown",
          `Unknown font category. Expected one of: ${FONT_CATEGORIES.join(", ")}.`,
          { alternatives: FONT_CATEGORIES },
        );
      }
      return { ...result, topic: "fonts", fonts };
    }
    case "theme":
      return { ...result, topic: "presentation", referenceKind: "theme", reference: getThemeReference() };
    case "appearance":
      return { ...result, topic: "presentation", referenceKind: "appearance", reference: getAppearanceReference() };
    case "footer":
      return { ...result, topic: "presentation", referenceKind: "footer", reference: getFooterReference() };
    default:
      throw usageError("help.usage", "The reference-help invocation is incomplete.");
  }
}

function parseConfigOption(arguments_, index) {
  const candidate = arguments_[index + 1];
  if (
    typeof candidate !== "string"
    || candidate.length === 0
    || Buffer.byteLength(candidate, "utf8") > LIMITS.configPathBytes
    || hasAsciiControl(candidate)
    || candidate.startsWith("--")
  ) {
    throw usageError("cli.config_option", "--config requires exactly one path before the operational verb.", {
      field: "configPath",
    });
  }
  return candidate;
}

/**
 * The command-line shape of `--name`, exactly as `parseConfigOption` handles
 * `--config`: presence, bounds, and printability here; the semantic rule
 * (trimmed, 1-100 characters) belongs to the verb, which a programmatic caller
 * reaches without passing through this parser at all.
 */
function parseUrlOption(arguments_, index) {
  const candidate = arguments_[index + 1];
  let url;
  try {
    url = typeof candidate === "string" ? new URL(candidate) : undefined;
  } catch {
    url = undefined;
  }
  if (
    !url || url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || (url.pathname !== "/" && url.pathname !== "") || hasAsciiControl(candidate)
  ) {
    throw usageError("cli.url_option", "--url requires one https origin such as https://example.com/.", {
      field: "url",
    });
  }
  return `${url.origin}/`;
}

function parseWaitOption(arguments_, index) {
  const candidate = arguments_[index + 1];
  const seconds = typeof candidate === "string" && /^\d{1,3}$/u.test(candidate) ? Number(candidate) : undefined;
  if (seconds === undefined || seconds > 120) {
    throw usageError("cli.wait_option", "--wait requires a whole number of seconds from 0 to 120.", {
      field: "propagationWaitSeconds",
    });
  }
  return seconds;
}

function parsePlanOption(arguments_, index) {
  const candidate = arguments_[index + 1];
  if (typeof candidate !== "string" || !PLAN_HASH.test(candidate)) {
    throw usageError("apply.plan_required", "--plan requires the planHash 'plan' reported (sha256:<64 hex>).", {
      field: "planHash",
    });
  }
  return candidate;
}

/**
 * The text after --title or --description. Either may be empty, which clears a
 * generated page's custom value; a page with its own title refuses an empty one.
 */
function parseMetaOption(arguments_, index, option) {
  const candidate = arguments_[index + 1];
  if (
    typeof candidate !== "string"
    || Buffer.byteLength(candidate, "utf8") > 8 * 1024
    || hasAsciiControl(candidate)
  ) {
    throw usageError(
      "cli.meta_option",
      option === "--title"
        ? "--title requires one printable title (an empty one clears a generated page's custom title)."
        : "--description requires one printable description (an empty one clears it).",
      { field: option.slice(2) },
    );
  }
  return candidate;
}

/** The text after --author, --name (authors add) or --email: one printable value, bounded. */
function parseAuthorOption(arguments_, index, option, { allowEmpty = false } = {}) {
  const candidate = arguments_[index + 1];
  if (
    typeof candidate !== "string"
    || (candidate.length === 0 && !allowEmpty)
    || Buffer.byteLength(candidate, "utf8") > 2 * 1024
    || hasAsciiControl(candidate)
    || candidate.startsWith("--")
  ) {
    throw usageError("cli.author_option", `${option} requires exactly one printable value.`, {
      field: option.slice(2),
    });
  }
  return candidate;
}

function parseNameOption(arguments_, index) {
  const candidate = arguments_[index + 1];
  if (
    typeof candidate !== "string"
    || candidate.length === 0
    || Buffer.byteLength(candidate, "utf8") > LIMITS.configPathBytes
    || hasAsciiControl(candidate)
    || candidate.startsWith("--")
  ) {
    throw usageError("cli.name_option", "--name requires exactly one printable key name.", {
      field: "keyName",
    });
  }
  return candidate;
}

function parseArguments(arguments_) {
  if (!Array.isArray(arguments_) || arguments_.some((argument) => typeof argument !== "string")) {
    throw usageError("cli.usage", "The command line must be a list of strings.");
  }
  if (arguments_.length === 1 && arguments_[0] === "--help") return { mode: "help" };
  if (arguments_.length === 1 && arguments_[0] === "--version") return { mode: "version" };

  let configPath;
  let commandArguments = arguments_;
  if (arguments_[0] === "--config") {
    configPath = parseConfigOption(arguments_, 0);
    commandArguments = arguments_.slice(2);
  }

  const verb = matchVerb(commandArguments);
  if (!verb) {
    throw usageError(
      "cli.usage",
      `Expected one of: ${VERBS.map((candidate) => candidate.tokens.join(" ")).join(", ")}.`,
    );
  }
  const rest = commandArguments.slice(verb.tokens.length);
  if (verb.name === VERB_HELP) {
    if (configPath !== undefined) {
      throw usageError("cli.config_option", "--config applies only to operational verbs.", {
        field: "configPath",
      });
    }
    return parseReferenceArguments(rest);
  }
  // `--config` names the configuration a verb reads, so it is refused only by
  // the verbs that read none. login and logout are credential-free but still
  // read a configuration when one is discoverable — it is what names the API
  // origin the sign-in belongs to — so they accept it. whoami is offline and
  // reads both the store and the configuration, so it accepts it too: the test
  // is "reads nothing local", not "makes no request".
  // validate reads the configuration in two cases: --init, and no directory,
  // which checks the workspace the configuration names.
  const validateReadsConfig = verb.name === VERB_VALIDATE
    && (rest.includes("--init") || rest.every((argument) => argument.startsWith("-")));
  if (verb.offline && !verb.readsLocalState && configPath !== undefined && !validateReadsConfig) {
    throw usageError("cli.config_option", "--config applies only to verbs that read the site configuration.", {
      field: "configPath",
    });
  }
  if (rest.length === 1 && rest[0] === "--help") return { mode: "verb_help", verb };
  if (rest.length === 1 && rest[0] === "--version") return { mode: "version" };

  let init = false;
  let quiet = false;
  let deployTarget;
  let deliveryUrl;
  let propagationWaitSeconds;
  let browser;
  let allowFailedPreview = false;
  let dryRun = false;
  let json = false;
  let keyName;
  let planHash;
  let metaTitle;
  let metaDescription;
  let metaAuthor;
  let authorName;
  let authorEmail;
  const positionals = [];
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (verb.name === VERB_VALIDATE && argument === "--init") {
      if (init) throw usageError("cli.duplicate_option", "--init may be supplied only once.");
      init = true;
      continue;
    }
    if (argument === "--quiet") {
      if (quiet) throw usageError("cli.duplicate_option", "--quiet may be supplied only once.");
      quiet = true;
      continue;
    }
    if (argument === "--config") {
      throw usageError("cli.config_option", "--config must appear before the operational verb.", {
        field: "configPath",
      });
    }
    if (verb.target && (argument === "--staging" || argument === "--production")) {
      const candidate = argument === "--staging" ? DEPLOY_TARGET_STAGING : DEPLOY_TARGET_PRODUCTION;
      if (deployTarget === candidate) {
        throw usageError("cli.duplicate_option", `${argument} may be supplied only once.`);
      }
      if (deployTarget !== undefined) {
        throw usageError(
          "cli.deploy_target",
          "deploy accepts exactly one of --staging or --production.",
        );
      }
      deployTarget = candidate;
      continue;
    }
    if (verb.deliveryOptions && argument === "--url") {
      if (deliveryUrl !== undefined) throw usageError("cli.duplicate_option", "--url may be supplied only once.");
      deliveryUrl = parseUrlOption(rest, index);
      index += 1;
      continue;
    }
    if (verb.deliveryOptions && argument === "--wait") {
      if (propagationWaitSeconds !== undefined) throw usageError("cli.duplicate_option", "--wait may be supplied only once.");
      propagationWaitSeconds = parseWaitOption(rest, index);
      index += 1;
      continue;
    }
    if (verb.deliveryOptions && argument === "--no-browser") {
      if (browser === false) throw usageError("cli.duplicate_option", "--no-browser may be supplied only once.");
      browser = false;
      continue;
    }
    if (verb.target && argument === "--allow-failed-preview") {
      if (allowFailedPreview) {
        throw usageError("cli.duplicate_option", "--allow-failed-preview may be supplied only once.");
      }
      allowFailedPreview = true;
      continue;
    }
    if (verb.dryRun && argument === "--dry-run") {
      if (dryRun) throw usageError("cli.duplicate_option", "--dry-run may be supplied only once.");
      dryRun = true;
      continue;
    }
    if (verb.json && argument === "--json") {
      if (json) throw usageError("cli.duplicate_option", "--json may be supplied only once.");
      json = true;
      continue;
    }
    if (verb.planHash && argument === "--plan") {
      if (planHash !== undefined) throw usageError("cli.duplicate_option", "--plan may be supplied only once.");
      planHash = parsePlanOption(rest, index);
      index += 1;
      continue;
    }
    if (verb.metaOptions && (argument === "--title" || argument === "--description")) {
      const value = parseMetaOption(rest, index, argument);
      if (argument === "--title") {
        if (metaTitle !== undefined) throw usageError("cli.duplicate_option", "--title may be supplied only once.");
        metaTitle = value;
      } else {
        if (metaDescription !== undefined) {
          throw usageError("cli.duplicate_option", "--description may be supplied only once.");
        }
        metaDescription = value;
      }
      index += 1;
      continue;
    }
    if (verb.metaOptions && argument === "--author") {
      if (metaAuthor !== undefined) throw usageError("cli.duplicate_option", "--author may be supplied only once.");
      // An empty value clears a pending author that was never sent.
      metaAuthor = parseAuthorOption(rest, index, argument, { allowEmpty: true });
      index += 1;
      continue;
    }
    if (verb.authorOptions && (argument === "--name" || argument === "--email")) {
      const value = parseAuthorOption(rest, index, argument);
      if (argument === "--name") {
        if (authorName !== undefined) throw usageError("cli.duplicate_option", "--name may be supplied only once.");
        authorName = value;
      } else {
        if (authorEmail !== undefined) throw usageError("cli.duplicate_option", "--email may be supplied only once.");
        authorEmail = value;
      }
      index += 1;
      continue;
    }
    if (verb.keyName && argument === "--name") {
      if (keyName !== undefined) throw usageError("cli.duplicate_option", "--name may be supplied only once.");
      keyName = parseNameOption(rest, index);
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) {
      throw usageError("cli.unknown_option", "The command contains an unknown option.");
    }
    if (verb.positionals) {
      if (
        argument.length === 0
        || Buffer.byteLength(argument, "utf8") > LIMITS.configPathBytes
        || hasAsciiControl(argument)
      ) {
        throw usageError("cli.unexpected_argument", "A positional argument is empty, oversized, or unprintable.");
      }
      if (positionals.length >= 100) {
        throw usageError("cli.unexpected_argument", "Too many positional arguments; supply at most 100.");
      }
      positionals.push(argument);
      continue;
    }
    throw usageError("cli.unexpected_argument", "The command contains an unexpected argument.");
  }
  if (verb.target && deployTarget === undefined) {
    throw usageError(
      "cli.deploy_target",
      `${verb.tokens.join(" ")} requires exactly one of --staging or --production.`,
    );
  }
  if (verb.positionals === "fixturePath" && (positionals.length > 1 || (init && positionals.length !== 1))) {
    throw usageError(
      "validate.fixture_path_invalid",
      init ? "validate --init requires exactly one new fixture directory." : "validate accepts at most one directory.",
      { field: "fixturePath" },
    );
  }
  if (
    verb.positionals === "pageSelector"
    && (
      positionals.length !== 1
      || (!isCanonicalUuid(positionals[0]) && isCanonicalUuid(positionals[0].toLowerCase()))
    )
  ) {
    throw usageError(
      "preview.page_selector_invalid",
      "preview page requires exactly one page path or canonical lowercase page UUID.",
      { field: "pageSelector" },
    );
  }
  if (
    verb.positionals === "previewIds"
    && (
      positionals.length !== 2
      || !isCanonicalUuid(positionals[0])
      || !isCanonicalUuid(positionals[1])
    )
  ) {
    const field = positionals.length === 2 && !isCanonicalUuid(positionals[0])
      ? "pageId"
      : "snapshotId";
    throw usageError(
      "preview.identity_invalid",
      "preview revoke requires one canonical lowercase page UUID and one canonical lowercase snapshot UUID.",
      { field },
    );
  }
  if (verb.positionals == "siteSelector" && positionals.length !== 1) {
    throw usageError(
      "use.selector_missing",
      "use requires exactly one site name or canonical lowercase site UUID.",
      { field: "selector" },
    );
  }
  if (verb.positionals === "environmentSelector" && positionals.length > 1) {
    throw usageError(
      "env.unexpected_argument",
      "env takes at most one environment: 'production', 'local', or an explicit loopback URL.",
      { field: "environmentSelector" },
    );
  }
  if (verb.positionals === "metaPagePath" && positionals.length !== 1) {
    throw usageError("pages.meta_path_invalid", "pages meta set names exactly one page path ('/' for the homepage).", {
      field: "pagePath",
    });
  }
  if (verb.metaOptions && metaTitle === undefined && metaDescription === undefined && metaAuthor === undefined) {
    throw usageError(
      "pages.meta_nothing_to_set",
      "pages meta set needs --title, --description, --author, or any of them.",
      { field: "title" },
    );
  }
  if (verb.positionals === "authorHandle" && positionals.length !== 1) {
    throw usageError("authors.handle_missing", "authors add needs exactly one handle, such as jane-doe.", {
      field: "handle",
    });
  }
  if (verb.authorOptions && authorName === undefined) {
    throw usageError("authors.name_missing", "authors add needs --name, the name readers see on the byline.", {
      field: "name",
    });
  }
  if (verb.planHash && planHash === undefined) {
    throw usageError("apply.plan_required", "apply requires --plan with the planHash that 'plan' reported.", {
      field: "planHash",
    });
  }
  if (quiet && verb.name === VERB_LOGIN) {
    // The approval URL and user code reach the operator only as progress
    // lines, and the JSON result is serialized only after polling ends — so a
    // silenced login is one nobody can ever approve. Refusing up front beats
    // a guaranteed timeout fifteen minutes later.
    throw usageError(
      "cli.quiet_option",
      "--quiet cannot be used with login: the approval URL and code are printed as progress, "
        + "and the JSON result exists only after the approval completes.",
      { field: "quiet" },
    );
  }
  return {
    mode: "run",
    verb: verb.name,
    // The smallest capability set this verb's requests need — every permission
    // the server resolves for them, not only the ones the verb's writes name.
    // It reaches the exchange so a content push never holds deploy, and a pull
    // never holds delete (TR00645). Two things count beyond the writes
    // (TR00691): reads (nav push lists pages; deploy checks the redirect map),
    // each gated on Content, and re-authorization
    // of server-held state (deploy --production re-checks the promoted
    // candidate's stored settings and navigation against a Design permission).
    // `VERB_CAPABILITIES` below is what the tests pin against the routes each
    // verb actually calls.
    capabilities: verb.capabilities,
    // The narrowest site surface the verb applies to (TR00790). `openSession`
    // refuses a verb its site cannot take before any request; `VERB_SURFACES`
    // below is what the tests pin.
    surface: verb.surface,
    surfaceCapabilities: verb.surfaceCapabilities,
    configPath,
    quiet,
    deployTarget,
    allowFailedPreview,
    ...(deliveryUrl === undefined ? {} : { deliveryUrl }),
    ...(propagationWaitSeconds === undefined ? {} : { propagationWaitSeconds }),
    ...(browser === undefined ? {} : { browser }),
    init,
    dryRun,
    keyName,
    ...(planHash === undefined ? {} : { planHash }),
    ...(metaTitle === undefined ? {} : { metaTitle }),
    ...(metaDescription === undefined ? {} : { metaDescription }),
    ...(metaAuthor === undefined ? {} : { metaAuthor }),
    ...(authorName === undefined ? {} : { authorName }),
    ...(authorEmail === undefined ? {} : { authorEmail }),
    positionals: verb.positionals
      ? {
        key: verb.positionals,
        values: positionals,
        scalar: verb.positionals === "pageSelector" || verb.positionals === "fixturePath" || verb.positionals === "metaPagePath"
          || verb.positionals === "siteSelector" || verb.positionals === "environmentSelector"
          || verb.positionals === "authorHandle",
      }
      : undefined,
  };
}

export async function runCli({
  arguments_ = process.argv.slice(2),
  environment = process.env,
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
  handlers = VERB_HANDLERS,
  fetch,
  signal,
} = {}) {
  let parsed;
  let progress;
  let completedPreviewRecovery;
  const isReferenceInvocation = Array.isArray(arguments_)
    && (
      arguments_[0] === "help"
      || (arguments_[0] === "--config" && arguments_[2] === "help")
    );
  // `validate` promises not to write even when parsing later rejects its
  // invocation. Detect its only legal command positions without consulting
  // config or environment, so a malformed offline command cannot fall through
  // to the generic GitHub Actions output writer.
  const isValidationInvocation = Array.isArray(arguments_)
    && (
      arguments_[0] === VERB_VALIDATE
      || (arguments_[0] === "--config" && arguments_[2] === VERB_VALIDATE)
    );
  try {
    parsed = parseArguments(arguments_);
    if (parsed.mode === "help") {
      stdout.write(HELP);
      return 0;
    }
    if (parsed.mode === "verb_help") {
      stdout.write(verbHelp(parsed.verb));
      return 0;
    }
    if (parsed.mode === "version") {
      stdout.write(`${CLI_VERSION}\n`);
      return 0;
    }
    if (parsed.mode === "reference") {
      await assertCliCurrent(environment);
      const result = referenceResult(parsed);
      stdout.write(parsed.json ? `${serializeResult(result)}\n` : formatReferenceResult(result));
      return 0;
    }
    if (VERSION_GATED_OFFLINE_VERBS.includes(parsed.verb)) {
      await assertCliCurrent(environment);
    }
    // Own properties only: a verb name must never resolve through the
    // prototype chain to something like `constructor`.
    const handler = Object.hasOwn(handlers, parsed.verb) ? handlers[parsed.verb] : undefined;
    if (typeof handler !== "function") {
      throw usageError("cli.unsupported_verb", `No handler is registered for '${parsed.verb}'.`);
    }
    progress = createProgressReporter({
      stream: stderr,
      interactive: stderr.isTTY === true && environment.TERM !== "dumb",
      quiet: parsed.quiet,
    });
    const result = await handler(Object.freeze({
      verb: parsed.verb,
      cwd,
      environment,
      configPath: parsed.configPath,
      deployTarget: parsed.deployTarget,
      allowFailedPreview: parsed.allowFailedPreview,
      init: parsed.init,
      quiet: parsed.quiet,
      dryRun: parsed.dryRun,
      keyName: parsed.keyName,
      ...(parsed.planHash === undefined ? {} : { planHash: parsed.planHash }),
      // Only when given, like the other optional fields, so each verb keeps its default (TR00925).
      ...(parsed.deliveryUrl === undefined ? {} : { deliveryUrl: parsed.deliveryUrl }),
      ...(parsed.propagationWaitSeconds === undefined ? {} : { propagationWaitSeconds: parsed.propagationWaitSeconds }),
      ...(parsed.browser === undefined ? {} : { browser: parsed.browser }),
      ...(parsed.metaTitle === undefined ? {} : { metaTitle: parsed.metaTitle }),
      ...(parsed.metaDescription === undefined ? {} : { metaDescription: parsed.metaDescription }),
      ...(parsed.metaAuthor === undefined ? {} : { metaAuthor: parsed.metaAuthor }),
      ...(parsed.authorName === undefined ? {} : { authorName: parsed.authorName }),
      ...(parsed.authorEmail === undefined ? {} : { authorEmail: parsed.authorEmail }),
      capabilities: parsed.capabilities,
      surface: parsed.surface,
      surfaceCapabilities: parsed.surfaceCapabilities,
      // Positionals land under the verb's own seam name (paths for media
      // upload, pagePaths for approve) and only when some were given, so a
      // bare invocation keeps each verb's documented default behavior.
      ...(parsed.positionals && parsed.positionals.values.length > 0
        ? {
          [parsed.positionals.key]: parsed.positionals.scalar
            ? parsed.positionals.values[0]
            : parsed.positionals.values,
        }
        : {}),
      // `endWait` lets a wait say it is over while the verb goes on (staging checks).
      onProgress: Object.assign((message, event) => progress.report(message, event), {
        endWait: () => progress.endWait(),
      }),
      fetch,
      signal,
    }));
    if (parsed.verb === VERB_PREVIEW_PAGE && result?.ok === true) {
      completedPreviewRecovery = normalizePreviewRecovery(result);
    }
    progress.stop();
    const json = serializeResult(result);
    if (!isValidationInvocation && environment.GITHUB_OUTPUT) {
      await writeGithubActionsOutput(environment.GITHUB_OUTPUT, result);
    }
    stdout.write(`${json}\n`);
    return 0;
  } catch (unknownError) {
    progress?.stop();
    const error = asSiteAuthoringError(unknownError);
    if (completedPreviewRecovery) error.withPreviewRecovery(completedPreviewRecovery);
    const result = failureResult(error);
    stdout.write(`${serializeResult(result)}\n`);
    stderr.write(`${humanFailure(error)}\n`);
    if (!isValidationInvocation && environment.GITHUB_OUTPUT && !isReferenceInvocation) {
      try {
        await writeGithubActionsOutput(environment.GITHUB_OUTPUT, result);
      } catch (outputError) {
        stderr.write(`${humanFailure(asSiteAuthoringError(outputError))}\n`);
      }
    }
    return error.exitCode;
  }
}
