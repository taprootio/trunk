import {
  CANONICAL_TIMESTAMP,
  CAPABILITY_REFUSAL_FIELD,
  CLI_UPGRADE_COMMAND,
  CLI_UPGRADE_REFUSAL_FIELD,
  CLI_VERSION,
  EXTERNAL_WRITES_SETTING_KEY,
  EXTERNAL_WRITES_SETTING_LOCATION,
  LIMITS,
  REFUSAL_CAPABILITY_MISSING,
  REFUSAL_CLI_OUTDATED,
  REFUSAL_CREDENTIAL_REJECTED,
  REFUSAL_PLAN_LIMIT,
  REFUSAL_PLATFORM_PAUSED,
  REFUSAL_THROTTLED,
  REFUSAL_UNCLASSIFIED,
} from "./constants.js";
import { normalizeLatestCliVersion } from "./cli-release.js";
// The display-prefix shape lives with the store because acceptance on claim
// must equal acceptance on save — a prefix admitted here but refused there
// would turn a successful mint into an orphaned key.
import { KEY_PREFIX } from "./credentials.js";
import { isCanonicalUuid, sanitizeDiagnostic, SiteAuthoringError } from "./errors.js";
import {
  DEFAULT_REDIRECT_STATUS,
  GONE_STATUS,
  REDIRECT_KIND_GONE,
  REDIRECT_KIND_REDIRECT,
  REDIRECT_ORIGIN_AUTHORED,
  REDIRECT_ORIGIN_PATH_HISTORY,
} from "./redirects-contract.js";
import { ApiError, isWellFormedCredential } from "./transport.js";
// The revision's shape lives with the manifest that records it: a value this
// module admitted but the registry then dropped would be recorded on a push
// and unreadable on the next pull, which reads as "never reconciled" forever.
import { normalizePageBodyRevision } from "./workspace.js";

/**
 * The proto enum spellings the redirect map travels as. The CLI's own
 * vocabulary is the lowercase word the workspace file uses; these are the wire
 * identities it is translated from, kept beside the translation.
 */
const REDIRECT_KIND_REDIRECT_WIRE = "SITE_REDIRECT_KIND_REDIRECT";
const REDIRECT_KIND_GONE_WIRE = "SITE_REDIRECT_KIND_GONE";
const REDIRECT_ORIGIN_AUTHORED_WIRE = "SITE_REDIRECT_ORIGIN_AUTHORED";

/**
 * The wire vocabulary and the read helpers every verb shares.
 *
 * Two facts shape everything here. First, proto3 omits zero-valued enums and
 * scalars, so an absent `status` is not missing data — it is the zero member,
 * and a reader that treats absence as "unknown" will mis-report a queued
 * deployment or a pending image. Second, ordinary authoring mutations carry
 * no idempotency key, so the transport will not replay them; the helpers below
 * issue exactly one mutation per intent and let an ambiguous outcome surface
 * as ambiguous. The sole exception is handoff minting, whose transactional
 * contract replaces the prior unconsumed handoff and therefore permits replay.
 */

export const PAGE_STATUS_UNKNOWN = "PAGE_STATUS_UNKNOWN";
export const PAGE_STATUS_DRAFT = "PAGE_STATUS_DRAFT";
export const PAGE_STATUS_APPROVED = "PAGE_STATUS_APPROVED";
export const PAGE_STATUS_PUBLISHED = "PAGE_STATUS_PUBLISHED";
export const PAGE_STATUS_DELETED = "PAGE_STATUS_DELETED";
export const PAGE_STATUSES = Object.freeze([
  PAGE_STATUS_UNKNOWN,
  PAGE_STATUS_DRAFT,
  PAGE_STATUS_APPROVED,
  PAGE_STATUS_PUBLISHED,
  PAGE_STATUS_DELETED,
]);

export const TEMPLATE_TYPE_FREE_FORM = "TEMPLATE_TYPE_FREE_FORM";
export const FREE_FORM_TEMPLATE_VERSION = "1.0";

export const NAV_ITEM_KIND_PAGE = "NAV_ITEM_KIND_PAGE";
export const NAV_ITEM_KIND_EXTERNAL_URL = "NAV_ITEM_KIND_EXTERNAL_URL";
export const NAV_ITEM_KIND_GROUP_HEADER = "NAV_ITEM_KIND_GROUP_HEADER";
export const NAV_ITEM_KINDS = Object.freeze([
  NAV_ITEM_KIND_PAGE,
  NAV_ITEM_KIND_EXTERNAL_URL,
  NAV_ITEM_KIND_GROUP_HEADER,
]);
export const NAVIGATION_MAXIMUM_DEPTH = 3;

export const DEPLOYMENT_ENVIRONMENT_STAGING = "DEPLOYMENT_ENVIRONMENT_STAGING";
export const DEPLOYMENT_ENVIRONMENT_PRODUCTION = "DEPLOYMENT_ENVIRONMENT_PRODUCTION";
export const DEPLOYMENT_STATUS_QUEUED = "DEPLOYMENT_STATUS_QUEUED";
export const DEPLOYMENT_STATUS_COMPLETED = "DEPLOYMENT_STATUS_COMPLETED";
export const DEPLOYMENT_STATUS_FAILED = "DEPLOYMENT_STATUS_FAILED";
export const DEPLOYMENT_PENDING_STATUSES = Object.freeze([
  DEPLOYMENT_STATUS_QUEUED,
  "DEPLOYMENT_STATUS_GENERATING",
  "DEPLOYMENT_STATUS_DEPLOYING",
]);
export const DEPLOYMENT_STATUSES = Object.freeze([
  ...DEPLOYMENT_PENDING_STATUSES,
  DEPLOYMENT_STATUS_COMPLETED,
  DEPLOYMENT_STATUS_FAILED,
]);

export const IMAGE_PROCESSING_STATE_UNKNOWN = "IMAGE_PROCESSING_STATE_UNKNOWN";
export const IMAGE_PROCESSING_STATE_COMPLETE = "IMAGE_PROCESSING_STATE_COMPLETE";
export const IMAGE_PROCESSING_STATE_FAILED = "IMAGE_PROCESSING_STATE_FAILED";
export const IMAGE_PROCESSING_STATES = Object.freeze([
  IMAGE_PROCESSING_STATE_UNKNOWN,
  "IMAGE_PROCESSING_STATE_PENDING",
  IMAGE_PROCESSING_STATE_COMPLETE,
  "IMAGE_PROCESSING_STATE_IN_PROGRESS",
  "IMAGE_PROCESSING_STATE_RETRYING",
  IMAGE_PROCESSING_STATE_FAILED,
]);

export const IMAGE_OWNERSHIP_SCOPE_SITE = "IMAGE_OWNERSHIP_SCOPE_SITE";

// The environment every read in this CLI names explicitly. `SITE_ENVIRONMENT_UNKNOWN`
// is the zero member, and the navigation and settings handlers both refuse it
// outright rather than treating it as a default — so an omitted `environment`
// is a 400, not a fallback.
export const SITE_ENVIRONMENT_DRAFT = "SITE_ENVIRONMENT_DRAFT";

export const AUTHORING_PREVIEW_STATUS_QUEUED = "AUTHORING_PREVIEW_STATUS_QUEUED";
export const AUTHORING_PREVIEW_STATUS_RENDERING = "AUTHORING_PREVIEW_STATUS_RENDERING";
export const AUTHORING_PREVIEW_STATUS_READY = "AUTHORING_PREVIEW_STATUS_READY";
export const AUTHORING_PREVIEW_STATUS_FAILED = "AUTHORING_PREVIEW_STATUS_FAILED";
export const AUTHORING_PREVIEW_STATUS_REVOKED = "AUTHORING_PREVIEW_STATUS_REVOKED";
export const AUTHORING_PREVIEW_STATUS_EXPIRED = "AUTHORING_PREVIEW_STATUS_EXPIRED";
export const AUTHORING_PREVIEW_STATUSES = Object.freeze([
  AUTHORING_PREVIEW_STATUS_QUEUED,
  AUTHORING_PREVIEW_STATUS_RENDERING,
  AUTHORING_PREVIEW_STATUS_READY,
  AUTHORING_PREVIEW_STATUS_FAILED,
  AUTHORING_PREVIEW_STATUS_REVOKED,
  AUTHORING_PREVIEW_STATUS_EXPIRED,
]);

const AUTHORING_PREVIEW_FAILURE_RENDER_FAILED = "preview.render_failed";
const AUTHORING_PREVIEW_FAILURE_RENDER_UNCLAIMED = "preview.render_unclaimed";
const AUTHORING_PREVIEW_FAILURE_ARTIFACT_MISSING = "preview.artifact_missing";
const AUTHORING_PREVIEW_FAILURE_EXPIRED = "preview.expired";
const AUTHORING_PREVIEW_FAILURE_REVOKED = "preview.revoked";
const AUTHORING_PREVIEW_FAILURES = new Set([
  "",
  AUTHORING_PREVIEW_FAILURE_RENDER_FAILED,
  AUTHORING_PREVIEW_FAILURE_RENDER_UNCLAIMED,
  AUTHORING_PREVIEW_FAILURE_ARTIFACT_MISSING,
  AUTHORING_PREVIEW_FAILURE_EXPIRED,
  AUTHORING_PREVIEW_FAILURE_REVOKED,
]);
const AUTHORING_PREVIEW_FIELDS = Object.freeze({
  draft: "AuthoringPreviewDraft",
  staging: "AuthoringPreviewStaging",
  expiry: "AuthoringPreviewExpiry",
  readiness: "AuthoringPreviewReadiness",
  rollout: "AuthoringPreviewRollout",
  siteCapacity: "AuthoringPreviewCapacity",
  authorityCapacity: "AuthoringPreviewAuthorityCapacity",
  manifest: "AuthoringPreviewManifest",
});
const AUTHORING_PREVIEW_FIELD_ERRORS = Object.freeze({
  [AUTHORING_PREVIEW_FIELDS.draft]: ["preview.no_draft", "The requested page does not have a persisted draft to preview."],
  [AUTHORING_PREVIEW_FIELDS.staging]: [
    "preview.staging_unavailable",
    "The site does not have an available staging hostname for authoring previews.",
  ],
  [AUTHORING_PREVIEW_FIELDS.expiry]: ["preview.expired", "The authoring preview has expired."],
  [AUTHORING_PREVIEW_FIELDS.readiness]: ["preview.not_ready", "The authoring preview is not ready for a handoff."],
  [AUTHORING_PREVIEW_FIELDS.rollout]: [
    "preview.temporarily_unavailable",
    "Authoring previews are temporarily unavailable while Taproot completes a deployment rollover.",
  ],
  [AUTHORING_PREVIEW_FIELDS.siteCapacity]: [
    "preview.site_capacity",
    "This site already has the maximum number of queued or rendering authoring previews. "
      + "Wait for one to finish rendering, or revoke a preview that is still queued or rendering.",
  ],
  [AUTHORING_PREVIEW_FIELDS.authorityCapacity]: [
    "preview.authority_capacity",
    "This authoring key has reached its active preview limit. Use preview revoke on an older preview or wait for it to expire.",
  ],
  [AUTHORING_PREVIEW_FIELDS.manifest]: [
    "preview.snapshot_too_large",
    "The site is too large to capture as an authoring preview.",
  ],
});
const CANONICAL_SHA256 = /^sha256:[0-9a-f]{64}$/u;
const CANONICAL_HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const CANONICAL_HANDOFF = /^[A-Za-z0-9_-]{43}$/u;
const AUTHORING_PREVIEW_PATH_PREFIX = "/_taproot/preview/pages";
const AUTHORING_PREVIEW_LIFETIME_MILLISECONDS = 60 * 60_000;
const AUTHORING_PREVIEW_HANDOFF_LIFETIME_MILLISECONDS = 2 * 60_000;
const AUTHORING_PREVIEW_CLOCK_SKEW_MILLISECONDS = 5 * 60_000;

const MAXIMUM_LIST_REQUESTS = 200;
const MAXIMUM_PAGES = 5_000;
const MAXIMUM_IMAGES = 5_000;
const LIST_PAGE_SIZE = 100;
const DEPLOYMENT_PAGE_SIZE = 50;
// Enough to observe a deployment that has not appeared in the list yet without
// spending the whole deadline on a deployment that never will.
const MAXIMUM_DEPLOYMENT_MISSES = 5;
const MAXIMUM_DIAGNOSTIC_LENGTH = 400;

export function requireObject(value, code, description) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new SiteAuthoringError(code, `Taproot returned an invalid ${description} response.`);
  }
  return value;
}

function requireIdentifier(value, code, field) {
  if (typeof value !== "string" || value.length === 0 || value.length > 100 || !/^[\w-]+$/u.test(value)) {
    throw new SiteAuthoringError(code, `Taproot returned an invalid ${field}.`, { field });
  }
  return value;
}

function requireCanonicalUuid(value, code, field) {
  if (!isCanonicalUuid(value)) {
    throw new SiteAuthoringError(code, `Taproot returned an invalid ${field}.`, { field });
  }
  return value;
}

function requireCanonicalTimestamp(value, code, field) {
  const milliseconds = typeof value === "string" && CANONICAL_TIMESTAMP.test(value) ? Date.parse(value) : Number.NaN;
  const wholeSecond = typeof value === "string" ? `${value.slice(0, 19)}Z` : "";
  const canonicalWholeSecond = Number.isFinite(milliseconds)
    ? `${new Date(milliseconds).toISOString().slice(0, 19)}Z`
    : "";
  if (!Number.isFinite(milliseconds) || canonicalWholeSecond !== wholeSecond) {
    throw new SiteAuthoringError(code, `Taproot returned an invalid ${field}.`, { field });
  }
  return { value, milliseconds };
}

function requireCanonicalStagingHost(value) {
  if (
    typeof value !== "string"
    || !CANONICAL_HOST.test(value)
  ) {
    throw new SiteAuthoringError(
      "preview.status_contract",
      "Taproot returned an invalid authoring-preview staging host.",
      { field: "stagingHost" },
    );
  }
  let canonical;
  try {
    canonical = new URL(`https://${value}/`).hostname;
  } catch {
    canonical = "";
  }
  if (canonical !== value) {
    throw new SiteAuthoringError(
      "preview.status_contract",
      "Taproot returned a non-canonical authoring-preview staging host.",
      { field: "stagingHost" },
    );
  }
  return value;
}

function equalPreviewIdentity(actual, expected) {
  return actual.siteId === expected.siteId
    && actual.pageId === expected.pageId
    && actual.snapshotId === expected.snapshotId
    // PostgreSQL persists timestamps at microsecond precision while JS dates
    // observe milliseconds. Compare the represented instants, not whether two
    // protobuf serializers chose the same permitted fractional spelling.
    && actual.capturedAtMilliseconds === expected.capturedAtMilliseconds
    && actual.expiresAtMilliseconds === expected.expiresAtMilliseconds
    && actual.draftRevision === expected.draftRevision
    && actual.stagingHost === expected.stagingHost;
}

/** proto3 omits a zero-valued enum, so absence resolves to the zero member. */
function enumValue(value, allowed, zero, code, field) {
  if (value === undefined || value === null || value === "") return zero;
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new SiteAuthoringError(code, `Taproot returned an unsupported ${field}.`, { status: value });
  }
  return value;
}

function safeCount(value) {
  const numeric = typeof value === "string" ? Number(value) : value;
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : 0;
}

/** A server string that exists to be *read* — bounded hard, because it is only ever displayed. */
function text(value) {
  return typeof value === "string" ? sanitizeDiagnostic(value, "").slice(0, MAXIMUM_DIAGNOSTIC_LENGTH) : "";
}

/**
 * A server string that travels back to the server unchanged: a page title,
 * which `pull` writes into the manifest and `pages push` sends straight back.
 *
 * Control characters are still stripped — that is terminal and result safety,
 * not fidelity. What is deliberately *not* applied is the diagnostic length
 * cap. `Page.Title` is citext with no maximum, so capping it at 400 renamed
 * every long-titled page on its next push: silently, permanently, and in the
 * one direction nobody inspects. The response byte cap already bounds what can
 * arrive at all, and `sanitizeDiagnostic`'s own outer bound slices whole code
 * points rather than UTF-16 units, so nothing here can cut a surrogate pair in
 * half and hand the server a lone half-character.
 */
function roundTrippedText(value) {
  return typeof value === "string" ? sanitizeDiagnostic(value, "") : "";
}

function query(parameters) {
  const search = new URLSearchParams();
  for (const [name, value] of parameters) {
    if (value === undefined || value === "") continue;
    if (Array.isArray(value)) {
      for (const entry of value) search.append(name, String(entry));
      continue;
    }
    search.set(name, String(value));
  }
  const serialized = search.toString();
  return serialized === "" ? "" : `?${serialized}`;
}

export function sitePath(siteId, suffix) {
  return `v1/sites/${encodeURIComponent(siteId)}/${suffix}`;
}

/**
 * The one thing an agent should do next, per refusal kind. These are different
 * behaviors — retry later, stop and re-issue, upgrade, back off — and a caller
 * that collapses them retries a revoked credential forever or treats a
 * commercial ceiling as an outage.
 */
const REFUSAL_GUIDANCE = Object.freeze({
  [REFUSAL_PLATFORM_PAUSED]:
    "Taproot has paused external site authoring platform-wide. The credential and the request are both fine; "
    + "retry later, or ask a Taproot administrator to re-enable the platform setting "
    + `'${EXTERNAL_WRITES_SETTING_KEY}' (${EXTERNAL_WRITES_SETTING_LOCATION}).`,
  [REFUSAL_CREDENTIAL_REJECTED]:
    "The site authoring credential was rejected: it is invalid, revoked, or bound to a different site. "
    + "Stop and re-issue it; retrying cannot succeed.",
  [REFUSAL_THROTTLED]:
    "This credential exceeded its request budget. Back off and retry with delay.",
});

/**
 * Says out loud, on the human channel, what a classified refusal means.
 *
 * The plan limit gets the loudest treatment because it is the one refusal an
 * agent cannot resolve by retrying, waiting, or fixing its input: the site has
 * reached a commercial ceiling. It is raised at deploy — no pre-flight read of
 * the published-page quota exists anywhere on the contract — and also by the
 * image-upload handlers, so `action` names the operation that was actually
 * refused rather than telling someone whose upload was rejected to "run the
 * deploy again". The CLI never invents the numeric limit it was not told.
 */
export function announceRefusal(error, onProgress, action = "request") {
  if (!(error instanceof ApiError)) return;
  const kind = error.refusalKind();
  if (kind === REFUSAL_CLI_OUTDATED) {
    onProgress("");
    onProgress(`CLI UPGRADE REQUIRED (refusal=${REFUSAL_CLI_OUTDATED}, field=${CLI_UPGRADE_REFUSAL_FIELD})`);
    onProgress(
      `  Taproot supports only the latest published release of this package, and refused this ${action} because `
        + `this CLI (${CLI_VERSION}) is behind it. Nothing about the credential, the request, or the site is wrong, `
        + "and no retry of this version can succeed.",
    );
    onProgress(`  Upgrade with: ${CLI_UPGRADE_COMMAND}`);
    // The server names both versions and says when waiting is the right move
    // (a deploy that landed ahead of its npm publish). Surface it verbatim
    // rather than restating a policy this side does not own; the bounded
    // ApiError message stays the fallback for a server that sent no
    // description.
    const serverDescription = error.descriptionFor?.(CLI_UPGRADE_REFUSAL_FIELD);
    onProgress(`  Taproot's own detail: ${
      sanitizeDiagnostic(serverDescription ?? error.message, "the request was rejected.")
    }`);
    onProgress("");
    return;
  }
  if (kind === REFUSAL_CAPABILITY_MISSING) {
    const { permission, granted, required } = error.capability;
    onProgress("");
    onProgress(`CAPABILITY MISSING (refusal=${REFUSAL_CAPABILITY_MISSING}, field=${CAPABILITY_REFUSAL_FIELD})`);
    onProgress(
      `  Taproot refused this ${action} because the credential it runs on was not exchanged for a capability `
        + `that grants '${permission}'.`,
    );
    onProgress(`  Granted: ${granted.length > 0 ? granted.join(", ") : "(none)"}.`);
    onProgress(
      required.length > 0
        ? `  Carried by: ${required.join(", ")}.`
        : "  Carried by: no site-authoring capability — this permission is not reachable by any credential.",
    );
    // The credential is exactly what was asked for, so re-issuing it changes
    // nothing. What is wrong is the verb's declared capability set, and saying
    // so is the whole point of the named refusal: the first agent to meet this
    // had to read the package source to find out.
    onProgress(
      `  The credential is not the problem: the exchange minted precisely what the ${action} asked for. `
        + "The verb's declared capability set in the CLI's verb table is short of the requests it makes; "
        + "report it rather than minting a wider key.",
    );
    onProgress("");
    return;
  }
  if (kind === REFUSAL_PLAN_LIMIT) {
    onProgress("");
    onProgress("PLAN LIMIT (refusal=plan_limit, field=UpgradePrompt)");
    onProgress(
      `  Taproot refused this ${action} against a plan ceiling rather than a content problem.`,
    );
    onProgress(
      `  Upgrade the site's plan, or reduce what this site is using, then run the ${action} again.`,
    );
    // The server's own violation description names the remedy; surface it
    // verbatim (sanitized) rather than paraphrasing policy the CLI does not
    // own. The bounded ApiError message remains as the fallback.
    const serverDescription = error.descriptionFor?.("UpgradePrompt");
    onProgress(`  Taproot's own detail: ${
      sanitizeDiagnostic(serverDescription ?? error.message, "the request was rejected.")
    }`);
    onProgress("");
    return;
  }
  const guidance = REFUSAL_GUIDANCE[kind];
  if (guidance) onProgress(guidance);
}

/**
 * Wraps wire work so a classified refusal explains itself before it propagates.
 * `action` is the verb's own short noun for what it was doing — it reaches the
 * plan-limit announcement, which otherwise names the wrong operation.
 */
export async function withRefusalGuidance(onProgress, action, work) {
  try {
    return await work();
  } catch (error) {
    announceRefusal(error, onProgress, action);
    throw error;
  }
}

export function normalizePageSummary(value) {
  const summary = requireObject(value, "api.page_contract", "page summary");
  return {
    pageId: requireIdentifier(summary.pageId, "api.page_contract", "page.pageId"),
    resourceId: typeof summary.resourceId === "string" ? summary.resourceId : "",
    path: typeof summary.path === "string" ? summary.path : "",
    // Not `text()`: a title round-trips to the server, so truncating it here
    // renames the page on the next push.
    title: roundTrippedText(summary.title),
    templateType: typeof summary.templateType === "string" ? summary.templateType : "TEMPLATE_TYPE_UNKNOWN",
    status: enumValue(summary.status, PAGE_STATUSES, PAGE_STATUS_UNKNOWN, "api.page_status", "page status"),
    hasDraft: summary.hasDraft === true,
    isGenerated: summary.isGenerated === true,
    // Absent against a Taproot that predates the revision contract, and absent
    // on the listings that never resolve stored body state. Both mean the same
    // thing to a caller — "this read cannot say what version you are looking
    // at" — and both are carried as `undefined` rather than as a sentinel that
    // would compare unequal to every recorded baseline and refuse every push.
    bodyRevision: normalizePageBodyRevision(summary.bodyRevision),
  };
}

export async function listSitePages(client, siteId, { onProgress = () => {} } = {}) {
  const pages = [];
  let pageToken = "";
  for (let request = 0; request < MAXIMUM_LIST_REQUESTS; request += 1) {
    const search = query([["pageSize", LIST_PAGE_SIZE], ["pageToken", pageToken]]);
    const response = requireObject(
      await client.request(`v1/pages/by_site/${encodeURIComponent(siteId)}${search}`),
      "api.page_contract",
      "site pages",
    );
    const batch = Array.isArray(response.pages) ? response.pages : [];
    for (const summary of batch) pages.push(normalizePageSummary(summary));
    pageToken = typeof response.nextPageToken === "string" ? response.nextPageToken : "";
    if (pageToken === "" || batch.length === 0) return { pages, truncated: false };
    if (pages.length >= MAXIMUM_PAGES) break;
    onProgress(`Listed ${pages.length} pages.`);
  }
  return { pages, truncated: true };
}

/**
 * Reads one page's editable body. `GetPageById` refuses an unspecified status,
 * so the caller must name which version it wants: the draft when the summary
 * says one exists, otherwise the version the summary reports.
 */
export async function getPage(client, pageId, status) {
  return requireObject(
    await client.request(`v1/pages/${encodeURIComponent(pageId)}${query([["status", status]])}`),
    "api.page_contract",
    "page",
  );
}

export function freeFormTemplate(body) {
  return {
    templateType: TEMPLATE_TYPE_FREE_FORM,
    templateVersion: FREE_FORM_TEMPLATE_VERSION,
    freeFormData: { body },
  };
}

export async function createPage(client, body) {
  return normalizePageSummary(await client.request("v1/pages", { method: "POST", body }));
}

export async function updatePage(client, pageId, body) {
  return normalizePageSummary(
    await client.request(`v1/pages/${encodeURIComponent(pageId)}`, { method: "PATCH", body }),
  );
}

export async function publishDrafts(client, pageIds) {
  const response = requireObject(
    await client.request("v1/pages/publish_drafts", { method: "POST", body: { pageIds } }),
    "api.page_contract",
    "publish drafts",
  );
  return (Array.isArray(response.pages) ? response.pages : []).map(normalizePageSummary);
}

/**
 * Reads the site's *draft* navigation tree — the one the editor and this CLI
 * both work against.
 *
 * The environment is explicit and must be. `SITE_ENVIRONMENT_UNKNOWN` is the
 * proto3 zero, so omitting the parameter does not mean "the default": the
 * handler's `MapSiteNavigationEnvironment` throws `InvalidArgument` on it
 * before it reads anything or checks anything. Draft is also the only branch
 * that authorizes through `SiteThemeManage`, which is the permission a
 * site-authoring key actually holds; production resolves against a published
 * deployment instead.
 */
export async function getNavigation(client, siteId) {
  const search = query([["environment", SITE_ENVIRONMENT_DRAFT]]);
  const response = requireObject(
    await client.request(sitePath(siteId, `navigation${search}`)),
    "api.navigation_contract",
    "site navigation",
  );
  return Array.isArray(response.navItems) ? response.navItems : [];
}

export async function saveNavigation(client, siteId, navItems) {
  const response = requireObject(
    await client.request(sitePath(siteId, "navigation"), { method: "PUT", body: { siteId, navItems } }),
    "api.navigation_contract",
    "site navigation",
  );
  return Array.isArray(response.navItems) ? response.navItems : [];
}

/**
 * Reads the site's whole redirect map with the revision a replace must carry
 * (TR00702).
 */
export async function getSiteRedirectMap(client, siteId) {
  return requireRedirectMap(
    await client.request(sitePath(siteId, "redirects"), {
      maximumResponseBytes: LIMITS.redirectMapResponseBytes,
    }),
    siteId,
  );
}

/**
 * Replaces the whole map. `expectedRevision` is the revision the map was read
 * at; the site refuses the write rather than dropping an entry a rename
 * recorded since.
 */
export async function replaceSiteRedirectMap(client, siteId, expectedRevision, entries) {
  return requireRedirectMap(
    await client.request(sitePath(siteId, "redirects"), {
      method: "PUT",
      body: { siteId, expectedRevision, entries: entries.map(toWireRedirectEntry) },
      // The reply is the whole replaced map, as large as the read.
      maximumResponseBytes: LIMITS.redirectMapResponseBytes,
    }),
    siteId,
  );
}

/**
 * The wire shape of one entry. `origin` is deliberately not sent: it is what
 * the site decided about a stored row, and echoing a pulled value back would
 * be asking to relabel a rename-recorded entry as one this workspace authored.
 */
function toWireRedirectEntry(entry) {
  return entry.kind === REDIRECT_KIND_GONE
    ? { path: entry.path, kind: REDIRECT_KIND_GONE_WIRE, status: GONE_STATUS }
    : {
      path: entry.path,
      kind: REDIRECT_KIND_REDIRECT_WIRE,
      target: entry.target,
      status: entry.status,
    };
}

function requireRedirectMap(value, siteId) {
  const response = requireObject(value, "api.redirects_contract", "site redirects");
  if (typeof response.revision !== "string" || response.revision === "") {
    throw new SiteAuthoringError(
      "api.redirects_contract",
      "Taproot returned a redirect map with no revision, so a later push could not be fenced against it.",
      { field: "revision" },
    );
  }
  if (typeof response.siteId === "string" && response.siteId !== "" && response.siteId !== siteId) {
    throw new SiteAuthoringError(
      "api.redirects_contract",
      "Taproot returned a redirect map for a different site.",
      { field: "siteId" },
    );
  }
  const entries = Array.isArray(response.entries) ? response.entries : [];
  return {
    revision: response.revision,
    entries: entries.map((entry) => normalizeRedirectMapEntry(entry)),
  };
}

/**
 * Reads one entry off the wire. Transcoding omits proto default values, so an
 * absent `kind`, `status`, or `origin` is the enum's zero — which the contract
 * reads as a redirect, the default status, and path history respectively.
 */
function normalizeRedirectMapEntry(entry) {
  const source = requireObject(entry, "api.redirects_contract", "site redirect entry");
  const kind = source.kind === REDIRECT_KIND_GONE_WIRE ? REDIRECT_KIND_GONE : REDIRECT_KIND_REDIRECT;
  return {
    path: typeof source.path === "string" ? source.path : "",
    kind,
    target: kind === REDIRECT_KIND_GONE || typeof source.target !== "string" ? "" : source.target,
    status: Number.isSafeInteger(source.status) && source.status > 0
      ? source.status
      : kind === REDIRECT_KIND_GONE
      ? GONE_STATUS
      : DEFAULT_REDIRECT_STATUS,
    origin: source.origin === REDIRECT_ORIGIN_AUTHORED_WIRE
      ? REDIRECT_ORIGIN_AUTHORED
      : REDIRECT_ORIGIN_PATH_HISTORY,
  };
}

/**
 * Reads one *draft* settings group for the site. Same rule as navigation:
 * `GetSettings` calls `RequireEnvironment`, so the zero value is refused rather
 * than defaulted, and draft is the environment a key-authorized caller reads.
 */
export async function getSettingsGroup(client, siteId, settingsType) {
  const search = query([["entityId", siteId], ["environment", SITE_ENVIRONMENT_DRAFT]]);
  return requireObject(
    await client.request(`v1/settings/${encodeURIComponent(settingsType)}${search}`),
    "api.settings_contract",
    "settings",
  );
}

export async function setSetting(client, siteId, settingsType, setting, value) {
  await client.request("v1/setting", {
    method: "POST",
    body: { entityId: siteId, settingsType, setting, value },
  });
}

export async function saveSiteFooterSettings(client, siteId, footerSettings, expectedFooterDraftHash) {
  return requireObject(
    await client.request(sitePath(siteId, "footer-settings"), {
      method: "POST",
      body: { siteId, footerSettings, expectedFooterDraftHash },
    }),
    "api.footer_settings_contract",
    "footer settings",
  );
}

export async function requestImageUpload(client, body) {
  return requireObject(
    await client.request("v1/images/request-upload", { method: "POST", body }),
    "api.image_contract",
    "image upload request",
  );
}

export async function confirmImageUpload(client, uploadId) {
  return requireObject(
    await client.request("v1/images/confirm-upload", { method: "POST", body: { uploadId } }),
    "api.image_contract",
    "image upload confirmation",
  );
}

export function normalizeImage(value) {
  const image = requireObject(value, "api.image_contract", "image");
  return {
    imageId: requireIdentifier(image.imageId, "api.image_contract", "image.imageId"),
    url: roundTrippedText(image.url),
    responsiveUrls: (Array.isArray(image.responsiveUrls) ? image.responsiveUrls : []).map((value) => {
      const responsive = requireObject(value, "api.image_contract", "image.responsiveUrls[]");
      return { minWidth: safeCount(responsive.minWidth), url: roundTrippedText(responsive.url) };
    }).filter((value) => value.url !== ""),
    width: safeCount(image.width),
    height: safeCount(image.height),
    processingState: enumValue(
      image.processingState,
      IMAGE_PROCESSING_STATES,
      IMAGE_PROCESSING_STATE_UNKNOWN,
      "api.image_state",
      "image processing state",
    ),
    uploadedName: text(image.uploadedName),
  };
}

/**
 * Processing is observed through `ListSiteImages`; `GetImageById` is
 * session-only under TR00602's read list, so a key-authorized client watches
 * the library rather than one image.
 *
 * `requestOptions` carries a poller's `{ deadline, now }` into *every* page of
 * the listing. Without it a single read of a large library could spend far more
 * than the caller's whole budget — the page bound alone permits hundreds of
 * requests, each with its own request timeout and retry budget — and the
 * deadline would only be noticed once the read finally returned.
 */
export async function listSiteImages(client, siteId, requestOptions = {}) {
  const images = [];
  let pageToken = "";
  let summary = { totalImages: 0, processingImages: 0 };
  for (let request = 0; request < MAXIMUM_LIST_REQUESTS; request += 1) {
    const search = query([["pageSize", LIST_PAGE_SIZE], ["pageToken", pageToken]]);
    const response = requireObject(
      await client.request(sitePath(siteId, `images${search}`), requestOptions),
      "api.image_contract",
      "site images",
    );
    summary = {
      totalImages: safeCount(response.totalImages),
      processingImages: safeCount(response.processingImages),
    };
    const batch = Array.isArray(response.images) ? response.images : [];
    for (const entry of batch) {
      const record = requireObject(entry, "api.image_contract", "image library entry");
      const image = normalizeImage(record.image);
      images.push({
        ...image,
        // The entry-level state is the library's authority; the embedded image
        // carries the same value and is the fallback when the entry omits it.
        processingState: enumValue(
          record.processingState,
          IMAGE_PROCESSING_STATES,
          image.processingState,
          "api.image_state",
          "image processing state",
        ),
        processingFailureReason: text(record.processingFailureReason),
      });
    }
    pageToken = typeof response.nextPageToken === "string" ? response.nextPageToken : "";
    if (pageToken === "" || batch.length === 0) return { images, summary, truncated: false };
    if (images.length >= MAXIMUM_IMAGES) break;
  }
  return { images, summary, truncated: true };
}

export async function getPublishingReadiness(client, siteId, selection = {}) {
  const response = requireObject(
    await client.request(sitePath(siteId, `publishing/readiness${query([
      ["stagedPageIds", selection.stagedPageIds],
      ["selectedSettingsTypes", selection.selectedSettingsTypes],
      ["includeNavigation", selection.includeNavigation],
    ])}`)),
    "api.readiness_contract",
    "publishing readiness",
  );
  const blockers = (Array.isArray(response.blockers) ? response.blockers : []).map((blocker) => ({
    imageId: typeof blocker?.imageId === "string" ? blocker.imageId : "",
    uploadedName: text(blocker?.uploadedName),
    state: typeof blocker?.state === "string" ? blocker.state : "PAGE_PUBLISHING_READINESS_STATE_UNKNOWN",
    message: text(blocker?.message),
  }));
  return {
    state: typeof response.state === "string" ? response.state : "PAGE_PUBLISHING_READINESS_STATE_UNKNOWN",
    approvedPageCount: safeCount(response.approvedPageCount),
    selectedPageCount: safeCount(response.selectedPageCount),
    blockedPageCount: safeCount(response.blockedPageCount),
    hasCandidateChanges: response.hasCandidateChanges === true,
    hasSuccessfulStagingDeployment: response.hasSuccessfulStagingDeployment === true,
    blockers,
  };
}

export async function getStagingPreviewStatus(client, siteId) {
  const response = requireObject(
    await client.request(sitePath(siteId, "staging-preview/status")),
    "api.staging_preview_contract",
    "staging preview status",
  );
  if (response.siteId !== siteId || typeof response.ready !== "boolean") {
    throw new SiteAuthoringError(
      "api.staging_preview_contract",
      "Taproot returned an invalid staging preview status response.",
    );
  }
  if (!response.ready) return { ready: false, stagingUrl: "" };

  let url;
  try {
    url = new URL(response.stagingUrl);
  } catch {
    throw new SiteAuthoringError(
      "api.staging_preview_contract",
      "Taproot returned an invalid staging preview URL.",
      { field: "stagingUrl" },
    );
  }
  if (
    url.protocol !== "https:"
    || !CANONICAL_HOST.test(url.hostname)
    || url.port !== ""
    || url.username !== ""
    || url.password !== ""
    || url.pathname !== "/"
    || url.search !== ""
    || url.hash !== ""
  ) {
    throw new SiteAuthoringError(
      "api.staging_preview_contract",
      "Taproot returned an invalid staging preview URL.",
      { field: "stagingUrl" },
    );
  }
  return { ready: true, stagingUrl: `https://${url.hostname}/` };
}

export function normalizeDeployment(value) {
  const deployment = requireObject(value, "api.deployment_contract", "deployment");
  return {
    id: requireIdentifier(deployment.id, "api.deployment_contract", "deployment.id"),
    siteId: typeof deployment.siteId === "string" ? deployment.siteId : "",
    // `DEPLOYMENT_STATUS_QUEUED` is the zero member, so an omitted status is a
    // queued deployment rather than an unknown one.
    status: enumValue(
      deployment.status,
      DEPLOYMENT_STATUSES,
      DEPLOYMENT_STATUS_QUEUED,
      "api.deployment_status",
      "deployment status",
    ),
    environment: typeof deployment.environment === "string"
      ? deployment.environment
      : "DEPLOYMENT_ENVIRONMENT_UNKNOWN",
    startedAt: text(deployment.startedAt),
    completedAt: text(deployment.completedAt),
    errorMessage: text(deployment.errorMessage),
    pageCount: safeCount(deployment.pageCount),
  };
}

/**
 * Reads one page of the deployment log. Unlike the page and image listings this
 * deliberately does *not* paginate — a deployment history is unbounded and only
 * its recent end is interesting — so it reports `truncated` and lets the caller
 * say so rather than presenting one page's size as the site's total.
 */
export async function listDeployments(
  client,
  siteId,
  { environment, pageSize = DEPLOYMENT_PAGE_SIZE } = {},
  requestOptions = {},
) {
  const response = requireObject(
    await client.request(
      sitePath(siteId, `deployments${query([
        ["pageSize", pageSize],
        ["includeStaging", true],
        ["environment", environment],
      ])}`),
      requestOptions,
    ),
    "api.deployment_contract",
    "site deployments",
  );
  return {
    deployments: (Array.isArray(response.deployments) ? response.deployments : []).map(normalizeDeployment),
    truncated: typeof response.nextPageToken === "string" && response.nextPageToken !== "",
  };
}

export async function deploySite(client, siteId, body) {
  const response = requireObject(
    await client.request(sitePath(siteId, "deploy"), { method: "POST", body }),
    "api.deployment_contract",
    "deploy",
  );
  return normalizeDeployment(response.deployment);
}

/**
 * Bounded polling, shaped after the Docs publisher's: a hard wall-clock
 * deadline, a read budget derived from it, and a terminal state or a stable
 * timeout code — never an unbounded wait. The SSE deployment stream is
 * user-session-scoped and therefore unreachable from a key-authorized CLI, so
 * polling is the only observation the contract offers here; the repo's
 * no-polling rule governs UX surfaces and does not reach this one.
 */
export async function poll({
  client,
  timeoutMilliseconds,
  // The cadence is a parameter because one caller does not own it: the CLI
  // authorization exchange polls at the interval the *server* published with
  // the authorization, clamped by its own bounds. The read budget is derived
  // from whatever interval is in force, so a slower cadence cannot turn into
  // more reads than the deadline can pay for.
  intervalMilliseconds = LIMITS.pollIntervalMilliseconds,
  read,
  evaluate,
  timeoutCode,
  timeoutError,
  onProgress,
  now,
}) {
  const deadline = now() + timeoutMilliseconds;
  const maximumReads = Math.ceil(timeoutMilliseconds / intervalMilliseconds) + 2;
  for (let readCount = 0; readCount < maximumReads; readCount += 1) {
    if (now() >= deadline) break;
    let value;
    try {
      value = await read({ deadline, now });
    } catch (error) {
      if (error instanceof SiteAuthoringError && error.code === "transport.deadline") break;
      throw error;
    }
    // A value in hand is evaluated even when the read finished at or past the
    // deadline: discarding an answer that already arrived would report a
    // timeout over a state the server has actually reached — for the claim
    // poll, that would silently orphan a minted credential.
    const result = evaluate(value);
    if (result.done) return result.value;
    // A tick with nothing new to report stays silent. The CLI-authorization
    // poll runs every few seconds for up to fifteen minutes, and a line per
    // tick scrolls the one thing the operator still needs — the code — off the
    // top of the terminal.
    if (result.progress !== undefined) onProgress(result.progress);
    if (now() >= deadline) break;
    await client.sleep(Math.min(intervalMilliseconds, Math.max(1, deadline - now())), client.signal);
  }
  throw typeof timeoutError === "function"
    ? timeoutError()
    : new SiteAuthoringError(
      timeoutCode,
      "Taproot did not reach a terminal state before the bounded deadline.",
    );
}

export async function waitForDeployment(client, { siteId, deploymentId, environment, onProgress, now }) {
  let misses = 0;
  return await poll({
    client,
    now,
    onProgress,
    timeoutMilliseconds: LIMITS.deploymentMilliseconds,
    read: async (requestOptions) =>
      (await listDeployments(client, siteId, { environment }, requestOptions))
        .deployments.find((deployment) => deployment.id === deploymentId),
    evaluate: (deployment) => {
      if (deployment === undefined) {
        misses += 1;
        if (misses > MAXIMUM_DEPLOYMENT_MISSES) {
          throw new SiteAuthoringError(
            "deploy.not_observable",
            "Taproot accepted the deployment but never listed it, so its outcome cannot be observed.",
            { field: "deploymentId" },
          );
        }
        return { done: false, progress: "Waiting for the deployment to appear in the deployment log." };
      }
      misses = 0;
      if (deployment.status === DEPLOYMENT_STATUS_COMPLETED) return { done: true, value: deployment };
      if (deployment.status === DEPLOYMENT_STATUS_FAILED) {
        throw new SiteAuthoringError(
          "deploy.failed",
          deployment.errorMessage
            ? `The deployment failed: ${deployment.errorMessage}`
            : "The deployment failed.",
          { status: deployment.status },
        );
      }
      return { done: false, progress: `Waiting for the deployment (${deployment.status}).` };
    },
    timeoutCode: "deploy.timeout",
  });
}

/**
 * The preview API is capability-adjacent: every identity and lifetime returned
 * by it is checked before the CLI will mint or emit a browser URL. In
 * particular, this does not use the permissive identifier helper used for
 * ordinary resources. A preview is bound to three canonical UUIDs and one
 * immutable draft digest, and a response that changes any of them is a
 * contract failure rather than a new source of authority.
 */
export function normalizeAuthoringPreview(value, expected = {}) {
  const preview = requireObject(value, "preview.status_contract", "authoring preview");
  const capturedAt = requireCanonicalTimestamp(
    preview.capturedAt,
    "preview.status_contract",
    "capturedAt",
  );
  const expiresAt = requireCanonicalTimestamp(
    preview.expiresAt,
    "preview.status_contract",
    "expiresAt",
  );
  if (
    expiresAt.milliseconds <= capturedAt.milliseconds
    || expiresAt.milliseconds - capturedAt.milliseconds !== AUTHORING_PREVIEW_LIFETIME_MILLISECONDS
  ) {
    throw new SiteAuthoringError(
      "preview.status_contract",
      "Taproot returned an invalid authoring-preview lifetime.",
      { field: "expiresAt" },
    );
  }
  if (typeof preview.draftRevision !== "string" || !CANONICAL_SHA256.test(preview.draftRevision)) {
    throw new SiteAuthoringError(
      "preview.status_contract",
      "Taproot returned an invalid captured draft revision.",
      { field: "draftRevision" },
    );
  }
  const status = enumValue(
    preview.status,
    AUTHORING_PREVIEW_STATUSES,
    "AUTHORING_PREVIEW_STATUS_UNSPECIFIED",
    "preview.status_contract",
    "authoring preview status",
  );
  if (status === "AUTHORING_PREVIEW_STATUS_UNSPECIFIED") {
    throw new SiteAuthoringError(
      "preview.status_contract",
      "Taproot returned an unspecified authoring-preview status.",
      { field: "status", status },
    );
  }
  const failureCode = preview.failureCode === undefined || preview.failureCode === null
    ? ""
    : preview.failureCode;
  if (typeof failureCode !== "string" || !AUTHORING_PREVIEW_FAILURES.has(failureCode)) {
    throw new SiteAuthoringError(
      "preview.status_contract",
      "Taproot returned an unsupported authoring-preview failure code.",
      { field: "failureCode" },
    );
  }
  const terminalFailureMatches = (
    status === AUTHORING_PREVIEW_STATUS_FAILED
    && (
      failureCode === AUTHORING_PREVIEW_FAILURE_RENDER_FAILED
      || failureCode === AUTHORING_PREVIEW_FAILURE_RENDER_UNCLAIMED
      || failureCode === AUTHORING_PREVIEW_FAILURE_ARTIFACT_MISSING
    )
  ) || (
    status === AUTHORING_PREVIEW_STATUS_EXPIRED
    && (failureCode === "" || failureCode === AUTHORING_PREVIEW_FAILURE_EXPIRED)
  ) || (
    status === AUTHORING_PREVIEW_STATUS_REVOKED
    && (failureCode === "" || failureCode === AUTHORING_PREVIEW_FAILURE_REVOKED)
  );
  const nonTerminalWithoutFailure = (
    status === AUTHORING_PREVIEW_STATUS_QUEUED
    || status === AUTHORING_PREVIEW_STATUS_RENDERING
    || status === AUTHORING_PREVIEW_STATUS_READY
  ) && failureCode === "";
  if (!terminalFailureMatches && !nonTerminalWithoutFailure) {
    throw new SiteAuthoringError(
      "preview.status_contract",
      "Taproot returned an authoring-preview status inconsistent with its failure code.",
      { field: "failureCode", status },
    );
  }
  const normalized = {
    siteId: requireCanonicalUuid(preview.siteId, "preview.status_contract", "siteId"),
    pageId: requireCanonicalUuid(preview.pageId, "preview.status_contract", "pageId"),
    snapshotId: requireCanonicalUuid(preview.snapshotId, "preview.status_contract", "snapshotId"),
    status,
    capturedAt: capturedAt.value,
    capturedAtMilliseconds: capturedAt.milliseconds,
    expiresAt: expiresAt.value,
    expiresAtMilliseconds: expiresAt.milliseconds,
    draftRevision: preview.draftRevision,
    failureCode,
    stagingHost: requireCanonicalStagingHost(preview.stagingHost),
  };
  for (const field of ["siteId", "pageId", "snapshotId"]) {
    if (expected[field] !== undefined && normalized[field] !== expected[field]) {
      throw new SiteAuthoringError(
        "preview.status_contract",
        `Taproot returned an authoring preview bound to a different ${field}.`,
        { field },
      );
    }
  }
  return normalized;
}

export function normalizeAuthoringPreviewCreate(value, expected) {
  const created = requireObject(value, "preview.create_contract", "authoring-preview create result");
  // Protobuf JSON omits an empty repeated field. A cap reduction can also
  // require evicting more snapshots than the newly configured cap, so the
  // eviction list is bounded independently from the resulting budget.
  const evictionValues = created.evictedPreviews ?? [];
  let preview;
  try {
    preview = normalizeAuthoringPreview(created.preview, expected);
  } catch (error) {
    if (error instanceof SiteAuthoringError && error.code === "preview.status_contract") {
      throw new SiteAuthoringError(
        "preview.create_contract",
        "Taproot returned an invalid created authoring preview.",
        { field: "preview" },
      );
    }
    throw error;
  }
  if (
    !Number.isSafeInteger(created.storedPreviewCap)
    || created.storedPreviewCap < 1
    || !Number.isSafeInteger(created.storedPreviewCount)
    || created.storedPreviewCount < 1
    || created.storedPreviewCount > created.storedPreviewCap
    || !Array.isArray(evictionValues)
    || evictionValues.length > 100
  ) {
    throw new SiteAuthoringError(
      "preview.create_contract",
      "Taproot returned an invalid stored-preview budget.",
      { field: "storedPreviewCount" },
    );
  }
  const evictedPreviews = evictionValues.map((candidate) => {
    const eviction = requireObject(candidate, "preview.create_contract", "evicted authoring preview");
    return {
      pageId: requireCanonicalUuid(eviction.pageId, "preview.create_contract", "evictedPreviews.pageId"),
      snapshotId: requireCanonicalUuid(
        eviction.snapshotId,
        "preview.create_contract",
        "evictedPreviews.snapshotId",
      ),
      capturedAt: requireCanonicalTimestamp(
        eviction.capturedAt,
        "preview.create_contract",
        "evictedPreviews.capturedAt",
      ).value,
    };
  });
  if (
    new Set(evictedPreviews.map((candidate) => candidate.snapshotId)).size !== evictedPreviews.length
    || evictedPreviews.some((candidate) => candidate.snapshotId === preview.snapshotId)
  ) {
    throw new SiteAuthoringError(
      "preview.create_contract",
      "Taproot returned duplicate or self-referential authoring-preview evictions.",
      { field: "evictedPreviews" },
    );
  }
  return {
    ...preview,
    storedPreviewCap: created.storedPreviewCap,
    storedPreviewCount: created.storedPreviewCount,
    evictedPreviews,
  };
}

export async function createAuthoringPreview(client, siteId, pageId) {
  return normalizeAuthoringPreviewCreate(
    await client.request(sitePath(siteId, `authoring-previews/pages/${encodeURIComponent(pageId)}`), {
      method: "POST",
      body: { siteId, pageId },
    }),
    { siteId, pageId },
  );
}

export async function getAuthoringPreview(client, expected, requestOptions = {}) {
  return normalizeAuthoringPreview(
    await client.request(sitePath(
      expected.siteId,
      `authoring-previews/pages/${encodeURIComponent(expected.pageId)}/${encodeURIComponent(expected.snapshotId)}`,
    ), requestOptions),
    expected,
  );
}

export async function revokeAuthoringPreview(client, expected) {
  return normalizeAuthoringPreview(
    await client.request(sitePath(
      expected.siteId,
      `authoring-previews/pages/${encodeURIComponent(expected.pageId)}/${encodeURIComponent(expected.snapshotId)}`,
    ), { method: "DELETE" }),
    expected,
  );
}

function assertAuthoringPreviewState(preview, now) {
  if (now() >= preview.expiresAtMilliseconds || preview.status === AUTHORING_PREVIEW_STATUS_EXPIRED) {
    throw new SiteAuthoringError("preview.expired", "The authoring preview has expired.", {
      status: preview.status,
    });
  }
  if (preview.status === AUTHORING_PREVIEW_STATUS_REVOKED) {
    throw new SiteAuthoringError("preview.revoked", "The authoring preview was revoked.", {
      status: preview.status,
    });
  }
  if (preview.status === AUTHORING_PREVIEW_STATUS_FAILED) {
    if (preview.failureCode === AUTHORING_PREVIEW_FAILURE_RENDER_UNCLAIMED) {
      throw new SiteAuthoringError(
        "preview.render_unclaimed",
        "The render service did not claim the authoring preview before its queue deadline.",
        { status: preview.status },
      );
    }
    throw new SiteAuthoringError("preview.render_failed", "Taproot could not render the authoring preview.", {
      status: preview.status,
    });
  }
}

export async function waitForAuthoringPreview(client, { created, onProgress, now }) {
  let lastStatus = created.status;
  return await poll({
    client,
    now,
    onProgress,
    timeoutMilliseconds: LIMITS.previewMilliseconds,
    // Always perform the status read, even if the create response happened to
    // say READY. Status is the side-effect-free authority for render completion.
    read: async (requestOptions) => await getAuthoringPreview(client, created, requestOptions),
    evaluate: (preview) => {
      lastStatus = preview.status;
      if (!equalPreviewIdentity(preview, created)) {
        throw new SiteAuthoringError(
          "preview.status_contract",
          "Taproot changed immutable authoring-preview metadata while it was rendering.",
        );
      }
      assertAuthoringPreviewState(preview, now);
      if (preview.status === AUTHORING_PREVIEW_STATUS_READY) return { done: true, value: preview };
      return { done: false, progress: `Waiting for the authoring preview (${preview.status}).` };
    },
    timeoutCode: "preview.timeout",
    timeoutError: () => lastStatus === AUTHORING_PREVIEW_STATUS_QUEUED
      ? new SiteAuthoringError(
        "preview.timeout",
        `The render service has not claimed this job before the bounded deadline. Revoke it with: taproot-site preview revoke ${created.pageId} ${created.snapshotId}`,
        { status: lastStatus },
      )
      : new SiteAuthoringError(
        "preview.timeout",
        `The render service claimed this job but did not finish before the bounded deadline. Revoke it with: taproot-site preview revoke ${created.pageId} ${created.snapshotId}`,
        { status: lastStatus },
      ),
  });
}

function canonicalHandoffToken(value) {
  if (typeof value !== "string" || !CANONICAL_HANDOFF.test(value)) return false;
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.byteLength === 32 && decoded.toString("base64url") === value;
  } catch {
    return false;
  }
}

export function normalizeAuthoringPreviewHandoff(value, ready, now) {
  const handoff = requireObject(value, "preview.handoff_contract", "authoring-preview handoff");
  const identity = {
    siteId: requireCanonicalUuid(handoff.siteId, "preview.handoff_contract", "siteId"),
    pageId: requireCanonicalUuid(handoff.pageId, "preview.handoff_contract", "pageId"),
    snapshotId: requireCanonicalUuid(handoff.snapshotId, "preview.handoff_contract", "snapshotId"),
  };
  if (
    identity.siteId !== ready.siteId
    || identity.pageId !== ready.pageId
    || identity.snapshotId !== ready.snapshotId
  ) {
    throw new SiteAuthoringError(
      "preview.handoff_contract",
      "Taproot returned a handoff bound to a different authoring preview.",
      { field: "snapshotId" },
    );
  }
  let nested;
  try {
    nested = normalizeAuthoringPreview(handoff.preview, identity);
  } catch (error) {
    if (error instanceof SiteAuthoringError && error.code === "preview.status_contract") {
      throw new SiteAuthoringError(
        "preview.handoff_contract",
        "Taproot returned an invalid nested authoring-preview handoff binding.",
        { field: "preview" },
      );
    }
    throw error;
  }
  if (!equalPreviewIdentity(nested, ready) || nested.status !== AUTHORING_PREVIEW_STATUS_READY) {
    throw new SiteAuthoringError(
      "preview.handoff_contract",
      "Taproot returned a handoff whose preview binding does not match the ready snapshot.",
      { field: "preview" },
    );
  }
  const handoffExpiresAt = requireCanonicalTimestamp(
    handoff.handoffExpiresAt,
    "preview.handoff_contract",
    "handoffExpiresAt",
  );
  const previewExpiresAt = requireCanonicalTimestamp(
    handoff.previewExpiresAt,
    "preview.handoff_contract",
    "previewExpiresAt",
  );
  const currentTime = now();
  if (
    previewExpiresAt.milliseconds !== ready.expiresAtMilliseconds
    || handoffExpiresAt.milliseconds <= currentTime - AUTHORING_PREVIEW_CLOCK_SKEW_MILLISECONDS
    || handoffExpiresAt.milliseconds - currentTime
      > AUTHORING_PREVIEW_HANDOFF_LIFETIME_MILLISECONDS + AUTHORING_PREVIEW_CLOCK_SKEW_MILLISECONDS
    || handoffExpiresAt.milliseconds > previewExpiresAt.milliseconds
  ) {
    throw new SiteAuthoringError(
      "preview.handoff_contract",
      "Taproot returned an invalid authoring-preview handoff lifetime.",
      { field: "handoffExpiresAt" },
    );
  }
  if (typeof handoff.url !== "string" || handoff.url.length > 2_048) {
    throw new SiteAuthoringError(
      "preview.handoff_contract",
      "Taproot returned an invalid authoring-preview handoff URL.",
      { field: "url" },
    );
  }
  let url;
  try {
    url = new URL(handoff.url);
  } catch {
    throw new SiteAuthoringError(
      "preview.handoff_contract",
      "Taproot returned an invalid authoring-preview handoff URL.",
      { field: "url" },
    );
  }
  const handoffValues = url.searchParams.getAll("handoff");
  const token = handoffValues.length === 1 ? handoffValues[0] : "";
  const expectedPath = `${AUTHORING_PREVIEW_PATH_PREFIX}/${ready.pageId}/${ready.snapshotId}`;
  const expectedUrl = canonicalHandoffToken(token)
    ? `https://${ready.stagingHost}${expectedPath}?handoff=${token}`
    : "";
  if (
    url.protocol !== "https:"
    || url.hostname !== ready.stagingHost
    || url.port !== ""
    || url.username !== ""
    || url.password !== ""
    || url.hash !== ""
    || url.pathname !== expectedPath
    || [...url.searchParams].length !== 1
    || handoff.url !== expectedUrl
  ) {
    throw new SiteAuthoringError(
      "preview.handoff_contract",
      "Taproot returned an authoring-preview URL outside the bound staging capability.",
      { field: "url" },
    );
  }
  return {
    siteId: identity.siteId,
    pageId: identity.pageId,
    snapshotId: identity.snapshotId,
    url: handoff.url,
    handoffExpiresAt: handoffExpiresAt.value,
    previewExpiresAt: previewExpiresAt.value,
    preview: nested,
  };
}

export async function mintAuthoringPreviewHandoff(client, ready, { now }) {
  let response;
  try {
    response = await client.replaceablePost(sitePath(
      ready.siteId,
      `authoring-previews/pages/${encodeURIComponent(ready.pageId)}/${encodeURIComponent(ready.snapshotId)}:mint-handoff`,
    ), {
      body: { siteId: ready.siteId, pageId: ready.pageId, snapshotId: ready.snapshotId },
      deadline: ready.expiresAtMilliseconds,
      now,
    });
  } catch (error) {
    if (error instanceof SiteAuthoringError && error.code === "transport.deadline") {
      throw new SiteAuthoringError("preview.expired", "The authoring preview expired before a handoff was minted.");
    }
    throw error;
  }
  return normalizeAuthoringPreviewHandoff(response, ready, now);
}

// ---------------------------------------------------------------------------
// CLI authorization (TR00634)
// ---------------------------------------------------------------------------

/**
 * The device-authorization exchange `login` drives. Both endpoints are
 * unauthenticated and IP-rate-limited, so they are reached through an anonymous
 * client that can never hold a bearer.
 *
 * The claim status is the whole protocol. `CLI_AUTHORIZATION_CLAIM_STATUS_UNKNOWN`
 * is the proto3 zero and is therefore *omitted* from a JSON response — which is
 * exactly why an absent status is a contract violation here rather than
 * "still pending". The classification survives not because it aborts (it no
 * longer does — see `claimCliAuthorization`: an unreadable answer may follow
 * a committed mint, so `login` keeps polling) but because it stays
 * distinguishable from PENDING: it announces itself as a lost answer and, if
 * the deadline arrives first, ends in the MAY-have-been-issued guidance
 * instead of a plain not-approved timeout.
 */
export const CLI_AUTHORIZATION_CLAIM_STATUS_PENDING = "CLI_AUTHORIZATION_CLAIM_STATUS_PENDING";
export const CLI_AUTHORIZATION_CLAIM_STATUS_ISSUED = "CLI_AUTHORIZATION_CLAIM_STATUS_ISSUED";
export const CLI_AUTHORIZATION_CLAIM_STATUS_DENIED = "CLI_AUTHORIZATION_CLAIM_STATUS_DENIED";
export const CLI_AUTHORIZATION_CLAIM_STATUS_EXPIRED = "CLI_AUTHORIZATION_CLAIM_STATUS_EXPIRED";
export const CLI_AUTHORIZATION_CLAIM_STATUS_CONSUMED = "CLI_AUTHORIZATION_CLAIM_STATUS_CONSUMED";
export const CLI_AUTHORIZATION_CLAIM_STATUSES = Object.freeze([
  CLI_AUTHORIZATION_CLAIM_STATUS_PENDING,
  CLI_AUTHORIZATION_CLAIM_STATUS_ISSUED,
  CLI_AUTHORIZATION_CLAIM_STATUS_DENIED,
  CLI_AUTHORIZATION_CLAIM_STATUS_EXPIRED,
  CLI_AUTHORIZATION_CLAIM_STATUS_CONSUMED,
]);

const CLI_AUTHORIZATION_PATH = "v1/site-authoring/cli-authorizations";
const AUTHORABLE_SITES_PATH = "v1/site-authoring/authorable-sites";
const TOKEN_EXCHANGE_PATH = "v1/site-authoring/tokens:exchange";
const CLI_AUTHORIZATION_DEVICE_CODE = /^[A-Za-z0-9_-]{43}$/u;
const CLI_AUTHORIZATION_USER_CODE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/u;
const CLI_AUTHORIZATION_MAXIMUM_EXPIRY_SECONDS = 60 * 60;
const CLI_AUTHORIZATION_MAXIMUM_INTERVAL_SECONDS = 5 * 60;

function requireBoundedSeconds(value, minimum, maximum, field) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new SiteAuthoringError("login.start_contract", `Taproot returned an invalid ${field}.`, { field });
  }
  return value;
}

/**
 * Opens an authorization. Nothing durable is authorized yet, and no credential
 * exists — the response carries only the device code this process polls with
 * and the user code the owner will see in the browser.
 *
 * Deliberately *not* returned: any URL. The approval URL is composed by the
 * caller from the already-allowlisted API origin, so a compromised or
 * misconfigured server cannot steer the owner somewhere else to approve.
 */
export async function startCliAuthorization(client, { keyName }, requestOptions = {}) {
  const response = requireObject(
    // No site: TR00645 made the account-level sign-in the front door, so the
    // CLI no longer has to know a site id before it can authorize at all.
    // `cliVersion` is sent on both calls every online verb passes through
    // (TR00703). Sign-in is the earlier of the two, so an outdated CLI is told
    // to upgrade before an owner is asked to approve anything.
    await client.request(CLI_AUTHORIZATION_PATH, {
      ...requestOptions,
      method: "POST",
      body: { keyName, cliVersion: CLI_VERSION },
    }),
    "login.start_contract",
    "CLI authorization",
  );
  if (typeof response.deviceCode !== "string" || !CLI_AUTHORIZATION_DEVICE_CODE.test(response.deviceCode)) {
    throw new SiteAuthoringError("login.start_contract", "Taproot returned an invalid device code.", {
      field: "deviceCode",
    });
  }
  if (typeof response.userCode !== "string" || !CLI_AUTHORIZATION_USER_CODE.test(response.userCode)) {
    throw new SiteAuthoringError("login.start_contract", "Taproot returned an invalid user code.", {
      field: "userCode",
    });
  }
  return {
    deviceCode: response.deviceCode,
    userCode: response.userCode,
    expiresInSeconds: requireBoundedSeconds(
      response.expiresInSeconds,
      1,
      CLI_AUTHORIZATION_MAXIMUM_EXPIRY_SECONDS,
      "expiresInSeconds",
    ),
    pollIntervalSeconds: requireBoundedSeconds(
      response.pollIntervalSeconds,
      1,
      CLI_AUTHORIZATION_MAXIMUM_INTERVAL_SECONDS,
      "pollIntervalSeconds",
    ),
  };
}

/**
 * Validates an `ISSUED` payload under its own code, `login.claim_unusable`,
 * never the generic `login.claim_contract`: by the time this runs the server
 * has said ISSUED, so the mint has already committed and a malformed field is
 * not "no answer" — it is an answer this side cannot use. The distinct code
 * lets `login` treat it as an ambiguous issuance (keep polling; the next
 * claim answers CONSUMED and names the exact key) instead of aborting behind
 * a contract error that hides a live credential.
 */
/**
 * The sites the sign-in credential's account may author (TR00645).
 *
 * The server has already filtered these to sites an exchange would accept, so
 * anything listed here is a site `use` can select and the next command can
 * author — a picker that offered otherwise would be worse than no picker.
 */
export async function listAuthorableSites(client, requestOptions = {}) {
  const response = requireObject(
    await client.request(AUTHORABLE_SITES_PATH, requestOptions),
    "sites.contract",
    "authorable site list",
  );
  const sites = Array.isArray(response.sites) ? response.sites : [];
  return sites.map((site) => {
    const value = requireObject(site, "sites.contract", "authorable site");
    return {
      siteId: requireCanonicalUuid(value.siteId, "sites.contract", "siteId"),
      name: typeof value.name === "string" ? value.name : "",
      primaryDomain: typeof value.primaryDomain === "string" ? value.primaryDomain : "",
    };
  });
}

/**
 * Exchanges the sign-in credential for a short-lived site credential (TR00645).
 *
 * The secret crosses the wire once and is never persisted: the exchanged
 * credential lives in memory for the run that asked for it. That is what lets
 * this be retried freely — a lost response costs one more exchange, and the
 * credential nobody received expires on its own within the hour.
 */
export async function exchangeSiteAuthoringToken(client, { siteId, capabilities = [] }, requestOptions = {}) {
  const response = requireObject(
    await client.request(TOKEN_EXCHANGE_PATH, {
      ...requestOptions,
      method: "POST",
      body: { siteId, capabilities, cliVersion: CLI_VERSION },
    }),
    "exchange.contract",
    "token exchange",
  );
  if (!isWellFormedCredential(response.rawKey)) {
    // The value is never quoted, here or anywhere: it is the secret.
    throw new SiteAuthoringError("exchange.contract", "Taproot returned an invalid exchanged key.", {
      field: "rawKey",
    });
  }
  return {
    key: response.rawKey,
    keyId: requireCanonicalUuid(response.keyId, "exchange.contract", "keyId"),
    keyPrefix: typeof response.keyPrefix === "string" && KEY_PREFIX.test(response.keyPrefix)
      ? response.keyPrefix
      : "",
    siteId: requireCanonicalUuid(response.siteId, "exchange.contract", "siteId"),
    expiresAt: requireCanonicalTimestamp(response.expiresAt, "exchange.contract", "expiresAt").value,
    capabilities: Array.isArray(response.capabilities)
      ? response.capabilities.filter((entry) => typeof entry === "string")
      : [],
    // The sign-in's refreshed deadline. Not a secret, and absent on a server
    // that predates the sliding window.
    ...(typeof response.signInExpiresAt === "string" && response.signInExpiresAt.length > 0
      ? { signInExpiresAt: requireCanonicalTimestamp(response.signInExpiresAt, "exchange.contract", "signInExpiresAt").value }
      : {}),
    // Whether the platform is accepting external authoring writes at all
    // (TR00692). Read strictly: only a real boolean is a state, so a server
    // that predates the field leaves this undefined rather than reading as
    // paused and warning before every write against a healthy platform.
    ...(typeof response.externalWritesEnabled === "boolean"
      ? { externalWritesEnabled: response.externalWritesEnabled }
      : {}),
    // The latest published release Taproot accepts (TR00703). This exchange
    // already succeeded, so it is never news about *this* request — it is what
    // lets the offline verbs refuse later. Read strictly for the same reason
    // the switch above is: only a value this side can compare is kept, so a
    // server that predates the field, or one that answers something
    // unparseable, leaves the local gate silent rather than refusing work it
    // cannot justify.
    ...(normalizeLatestCliVersion(response.latestCliVersion) === undefined
      ? {}
      : { latestCliVersion: response.latestCliVersion }),
  };
}

function normalizeIssuedCredential(response) {
  if (!isWellFormedCredential(response.rawKey)) {
    // The value is never quoted, here or anywhere: it is the secret.
    throw new SiteAuthoringError("login.claim_unusable", "Taproot returned an invalid issued key.", {
      field: "rawKey",
    });
  }
  const keyId = requireCanonicalUuid(response.keyId, "login.claim_unusable", "keyId");
  if (typeof response.keyPrefix !== "string" || !KEY_PREFIX.test(response.keyPrefix)) {
    throw new SiteAuthoringError("login.claim_unusable", "Taproot returned an invalid key prefix.", {
      field: "keyPrefix",
    });
  }
  // The account-level sign-in TR00645 made the default names an account and no
  // site. A site-scoped claim still names a site, and both shapes stay readable
  // so a server serving either can be talked to.
  const accountId = requireCanonicalUuid(response.accountId, "login.claim_unusable", "accountId");
  // Absent means "never expires", which is a legitimate owner choice on the
  // approval screen — so absence is not a contract failure, but a malformed
  // value is.
  const keyExpiresAt = response.keyExpiresAt === undefined || response.keyExpiresAt === null
      || response.keyExpiresAt === ""
    ? undefined
    : requireCanonicalTimestamp(response.keyExpiresAt, "login.claim_unusable", "keyExpiresAt").value;
  return {
    key: response.rawKey,
    keyId,
    keyPrefix: response.keyPrefix,
    accountId,
    ...(keyExpiresAt === undefined ? {} : { keyExpiresAt }),
  };
}

/**
 * One poll of the claim endpoint. The POST is replayed across transport-level
 * retries on purpose: the claim is a guarded single-use transition, so a replay
 * after a lost response cannot mint a second key — the server answers
 * `..._CONSUMED`, and the caller reports the orphaned credential honestly
 * rather than hiding it behind a network error.
 */
export async function claimCliAuthorization(client, deviceCode, requestOptions = {}) {
  // Every `login.claim_contract` raised here — a non-object envelope, an
  // absent status, a status string this vocabulary does not know — is an
  // answer this client could not read, not proof the claim was refused. A
  // serializer fault or ordinary version skew (a newer server adding a
  // status value) produces exactly these shapes AFTER the handler committed
  // the mint, so `login` treats the code as a possible lost issuance and
  // keeps polling rather than aborting behind a generic error. The code
  // stays distinct from `login.claim_unusable`, which means the stronger
  // thing: the server said ISSUED, so the mint definitely happened.
  const response = requireObject(
    await client.replaceablePost(`${CLI_AUTHORIZATION_PATH}/claim`, { ...requestOptions, body: { deviceCode } }),
    "login.claim_contract",
    "CLI authorization claim",
  );
  const status = response.status;
  if (typeof status !== "string" || !CLI_AUTHORIZATION_CLAIM_STATUSES.includes(status)) {
    throw new SiteAuthoringError(
      "login.claim_contract",
      "Taproot returned an unsupported CLI authorization claim status.",
      { field: "status", ...(typeof status === "string" ? { status } : {}) },
    );
  }
  if (status === CLI_AUTHORIZATION_CLAIM_STATUS_ISSUED) {
    return { status, credential: normalizeIssuedCredential(response) };
  }
  if (status === CLI_AUTHORIZATION_CLAIM_STATUS_CONSUMED) {
    // A consumed answer names the credential an earlier claim minted, so the
    // caller can direct the owner to revoke exactly that key. The metadata is
    // display-only guidance: a malformed value is dropped rather than refused,
    // because failing here would hide the very orphan the answer exists to
    // surface — the fallback guidance names the credential by its display
    // name instead.
    const keyId = isCanonicalUuid(response.keyId) ? response.keyId : undefined;
    const keyPrefix = typeof response.keyPrefix === "string" && KEY_PREFIX.test(response.keyPrefix)
      ? response.keyPrefix
      : undefined;
    return {
      status,
      ...(keyId === undefined ? {} : { keyId }),
      ...(keyPrefix === undefined ? {} : { keyPrefix }),
    };
  }
  return { status };
}

/** Maps only preview-domain validation fields; authentication/refusal identity stays an ApiError. */
export function translateAuthoringPreviewApiError(error) {
  if (!(error instanceof ApiError) || error.refusalKind() !== REFUSAL_UNCLASSIFIED) return error;
  for (const [field, [code, message]] of Object.entries(AUTHORING_PREVIEW_FIELD_ERRORS)) {
    if (error.hasField(field)) {
      const passesServerGuidance = field === AUTHORING_PREVIEW_FIELDS.authorityCapacity
        || field === AUTHORING_PREVIEW_FIELDS.siteCapacity;
      const serverGuidance = passesServerGuidance ? error.descriptionFor(field) : undefined;
      return new SiteAuthoringError(code, serverGuidance ?? message, { field, status: error.status });
    }
  }
  return error;
}
