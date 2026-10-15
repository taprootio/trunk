import { SiteAuthoringError } from "./errors.js";
import { RUNTIME_MIRROR_PATH_REASON } from "./reserved-paths.js";
import {
  isRequestSpelling,
  normalizeRedirectPath,
  redirectSourceRule,
  resolvesAway,
  RULE_REDIRECT_SOURCE_GENERATED_FILE,
  RULE_REDIRECT_SOURCE_INDEX_HTML,
  RULE_REDIRECT_SOURCE_INTEGRATION_DATA,
  RULE_REDIRECT_SOURCE_INVALID,
  RULE_REDIRECT_SOURCE_NOT_STORABLE,
  RULE_REDIRECT_SOURCE_RUNTIME_MIRROR,
  RULE_REDIRECT_SOURCE_SHARE_LINK,
} from "./site-checks.js";

export { normalizeRedirectPath };

/**
 * The redirect map's workspace contract (TR00702).
 *
 * A migrated site's old URLs are the only thing standing between its search
 * history and a wall of 404s, so this file is authored deliberately rather than
 * inferred: `redirects pull` writes it, `redirects push` replaces the whole map
 * from it, and `validate` proves it offline. Every rule the API enforces is
 * enforced here first, by entry index, because a hundred-row import that comes
 * back as one unnamed 400 is a hunt rather than a fix.
 *
 * Where a rule depends on what the site actually serves — path occupancy, and
 * the path bound for an entry the site itself recorded — the site is the
 * authority and this pass defers to it rather than refusing a map the site
 * would have accepted.
 *
 * Converting an engagement's spreadsheet into this file is the agent's job. The
 * CLI's contract is JSON; it deliberately does not parse CSV, because a real
 * migration list needs judgement about which old URLs still deserve a
 * destination and which are simply gone.
 */

export const REDIRECTS_FILE_NAME = "redirects.json";

export const REDIRECT_KIND_REDIRECT = "redirect";
export const REDIRECT_KIND_GONE = "gone";
export const REDIRECT_KINDS = Object.freeze([REDIRECT_KIND_REDIRECT, REDIRECT_KIND_GONE]);

export const REDIRECT_ORIGIN_AUTHORED = "authored";
export const REDIRECT_ORIGIN_PATH_HISTORY = "path_history";
export const REDIRECT_ORIGINS = Object.freeze([REDIRECT_ORIGIN_AUTHORED, REDIRECT_ORIGIN_PATH_HISTORY]);

/** The status a redirect entry serves when it declares none. */
export const DEFAULT_REDIRECT_STATUS = 301;

/** The status a gone entry serves. It is not declarable as anything else. */
export const GONE_STATUS = 410;

/** The statuses the published-site edge value contract accepts. */
export const REDIRECT_STATUSES = Object.freeze([301, 302, 307, 308]);

/**
 * Bounds, mirrored from `SiteRedirectMapContract` on the server. The path bound
 * is the map's own; the target bound is the edge's own, and a target must also
 * fit as metadata on its redirect file once encoded.
 */
export const REDIRECT_LIMITS = Object.freeze({
  entries: 2_000,
  pathBytes: 400,
  targetBytes: 2_048,
  // Once percent-encoded, a target rides on its redirect file as object
  // metadata; the server pins the same number (MaxMarkerTargetEncodedLength).
  targetEncodedCharacters: 1_810,
});

// C0, DEL, and C1 — every code point the server's own `char.IsControl`
// refuses, so a value the site would reject is named here by entry index
// rather than surviving the offline pass. A path or target carrying one is
// not a URL a browser could have requested, and normalizing it away would
// hide the mistake.
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/u;
const ENTRY_KEYS = new Set(["path", "kind", "target", "status", "origin"]);
const SHA256 = /^[0-9a-f]{64}$/u;


/** Whether the value is a redirect-map revision as the server mints one. */
export function isRedirectMapRevision(value) {
  return typeof value === "string" && SHA256.test(value);
}

function entryError(code, message, field, rule) {
  return new SiteAuthoringError(code, `${field}: ${message}`, { field, rule });
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function utf8Length(value) {
  return Buffer.byteLength(value, "utf8");
}

/**
 * Why a source rule refuses a path, in the words the CLI shows. The rule ids are
 * the site checks' (shared/site-check-rules.json); the decisions themselves are
 * made by `redirectSourceRule` in the shared source, which the API's C#
 * implementation also passes the same corpus for.
 */
const SOURCE_RULE_REASONS = Object.freeze({
  [RULE_REDIRECT_SOURCE_INDEX_HTML]: () =>
    "the platform already redirects every '…/index.html' address to its directory, so it cannot also be "
    + "a redirect source, and the page or home file there is generated.",
  [RULE_REDIRECT_SOURCE_INTEGRATION_DATA]: (first) =>
    `'/${first}' is reserved for integration data, so nothing under it can be a redirect source.`,
  [RULE_REDIRECT_SOURCE_SHARE_LINK]: () =>
    "'/s/' is reserved for share links, so nothing under it can be a redirect source.",
  [RULE_REDIRECT_SOURCE_RUNTIME_MIRROR]: () => RUNTIME_MIRROR_PATH_REASON,
  [RULE_REDIRECT_SOURCE_GENERATED_FILE]: (first) =>
    `'/${first}' is a file the site generates, so neither it nor anything under it can be a redirect source.`,
  [RULE_REDIRECT_SOURCE_NOT_STORABLE]: () =>
    "a redirect is stored as a file in the published site, and this path cannot be one (no dot-prefixed "
    + "segments, reserved device names, '..', escaped percent signs, or segments over 200 bytes).",
});

/** The refusal for a normalized source: its site-check rule id and the reason, or undefined when it can be a redirect. */
export function redirectSourceRefusal(path) {
  const refusal = redirectSourceRule(path);
  if (refusal === undefined) return undefined;
  return { ruleId: refusal.ruleId, reason: SOURCE_RULE_REASONS[refusal.ruleId](refusal.detail) };
}

function looksAbsolute(value) {
  return !value.startsWith("/") && value.includes("://");
}

/** Whether the value is an absolute, credential-free http(s) URL. */
export function isAbsoluteRedirectTarget(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (url.protocol === "https:" || url.protocol === "http:")
    && url.username === ""
    && url.password === "";
}

/**
 * The site path an internal target names, or undefined when the target leaves
 * the site. Only internal targets take part in chain and loop detection: an
 * absolute URL is another origin's business even when it happens to spell this
 * site's own domain.
 *
 * The query string and fragment are cut before the comparison, never before
 * storage. The edge keys a redirect on the pathname alone, so '/b?x=1' and
 * '/b' are one route to it; normalizing the whole target would return
 * undefined for either (a source may carry no query, a target may) and
 * '/a -> /b?x=1' beside '/b -> /a?y=2' would pass as a pair of unrelated
 * entries and loop at the edge.
 */
export function internalRedirectTargetPath(entry) {
  if (entry.kind === REDIRECT_KIND_GONE || isAbsoluteRedirectTarget(entry.target)) return undefined;
  if (typeof entry.target !== "string") return undefined;
  const cut = entry.target.search(/[?#]/u);
  return normalizeRedirectPath(cut === -1 ? entry.target : entry.target.slice(0, cut));
}

function validateEntry(value, index, seen) {
  const field = `entries[${index}]`;
  if (!isPlainObject(value)) {
    throw entryError("redirects.entry_invalid", "a redirect entry must be an object.", field);
  }
  const unknown = Object.keys(value).filter((key) => !ENTRY_KEYS.has(key)).sort();
  if (unknown.length > 0) {
    throw entryError(
      "redirects.unknown_field",
      `unsupported redirect field '${unknown[0]}'; an entry carries ${[...ENTRY_KEYS].join(", ")}.`,
      field,
    );
  }

  const path = normalizeRedirectPath(value.path);
  if (path === undefined) {
    throw entryError(
      "redirects.path_invalid",
      "'path' must be an absolute site path such as /faqs.html, with no query string, fragment, or host, no '.' "
        + "or '..' segment, no empty segment, and no percent-encoded dot or slash. Write the percent-encoded "
        + "spelling a browser sends (/caf%C3%A9, /old%20page), never the raw one.",
      `${field}.path`,
      RULE_REDIRECT_SOURCE_INVALID,
    );
  }
  // The site root is not refused here. A home page rename records an entry at
  // '/', so refusing it offline would make a pulled map unpushable for a site
  // whose home page moved. Occupancy is the rule that belongs, and it is the
  // site's to enforce: '/' is refused for exactly as long as a home page is
  // served there.
  //
  // The path bound is the same shape of problem. A page may sit at a path
  // longer than the map allows a source to be, and renaming it records a
  // path-history entry at that length which 'redirects pull' returns. Refusing
  // it here would make the site's own map fail 'validate' and unpushable
  // without dropping a live redirect, so an entry the site reports as
  // path_history is exempt and the site decides: it alone knows whether the
  // push is introducing that path or merely carrying it back unchanged.
  if (value.origin !== REDIRECT_ORIGIN_PATH_HISTORY && utf8Length(path) > REDIRECT_LIMITS.pathBytes) {
    throw entryError(
      "redirects.path_too_long",
      `'path' cannot exceed ${REDIRECT_LIMITS.pathBytes} bytes.`,
      `${field}.path`,
    );
  }
  const sourceRefusal = redirectSourceRefusal(path);
  if (sourceRefusal !== undefined) {
    throw entryError(
      "redirects.path_unpublishable",
      `'${path}': ${sourceRefusal.reason}`,
      `${field}.path`,
      sourceRefusal.ruleId,
    );
  }
  // The marker is stored under the decoded spelling, so `/a%41` and `/aA` are one
  // file, and the second would silently replace the first.
  const markerKey = decodeURIComponent(path).toLowerCase();
  if (seen.has(markerKey)) {
    throw entryError(
      "redirects.path_duplicate",
      `'${path}' appears more than once; one path has one entry.`,
      `${field}.path`,
    );
  }
  seen.add(markerKey);

  const kind = value.kind === undefined ? REDIRECT_KIND_REDIRECT : value.kind;
  if (!REDIRECT_KINDS.includes(kind)) {
    throw entryError(
      "redirects.kind_invalid",
      `'kind' must be one of ${REDIRECT_KINDS.join(", ")}.`,
      `${field}.kind`,
    );
  }

  if (value.origin !== undefined && !REDIRECT_ORIGINS.includes(value.origin)) {
    throw entryError(
      "redirects.origin_invalid",
      `'origin' must be one of ${REDIRECT_ORIGINS.join(", ")} when present. It is what the site reports, `
        + "not something a push can set.",
      `${field}.origin`,
    );
  }

  if (kind === REDIRECT_KIND_GONE) {
    if (value.target !== undefined && value.target !== "") {
      throw entryError(
        "redirects.gone_target",
        "a gone entry answers 410 and carries no target.",
        `${field}.target`,
      );
    }
    if (value.status !== undefined && value.status !== GONE_STATUS) {
      throw entryError(
        "redirects.gone_status",
        `a gone entry serves ${GONE_STATUS}; no other status can be declared for it.`,
        `${field}.status`,
      );
    }
    return { path, kind: REDIRECT_KIND_GONE, target: "", status: GONE_STATUS };
  }

  if (typeof value.target !== "string" || value.target.trim() === "") {
    throw entryError(
      "redirects.target_missing",
      "a redirect entry needs a 'target': a site-relative path such as /classes, or an absolute http(s) URL.",
      `${field}.target`,
    );
  }
  const rawTarget = value.target.trim();
  if (utf8Length(rawTarget) > REDIRECT_LIMITS.targetBytes) {
    throw entryError(
      "redirects.target_too_long",
      `'target' cannot exceed ${REDIRECT_LIMITS.targetBytes} bytes.`,
      `${field}.target`,
    );
  }

  if (encodeURIComponent(rawTarget).length > REDIRECT_LIMITS.targetEncodedCharacters) {
    throw entryError(
      "redirects.target_too_long_to_store",
      "'target' is stored as metadata on the published site's redirect file and is too long to fit "
        + `(${REDIRECT_LIMITS.targetEncodedCharacters} characters once percent-encoded).`,
      `${field}.target`,
    );
  }

  let target;
  if (looksAbsolute(rawTarget)) {
    if (!isAbsoluteRedirectTarget(rawTarget)) {
      throw entryError(
        "redirects.target_invalid",
        "an absolute 'target' must be an http or https URL carrying no credentials.",
        `${field}.target`,
      );
    }
    target = rawTarget;
  } else {
    // Only the path component is held to the alias and spelling rules: a query
    // string or fragment legitimately carries percent-encoded slashes and whole
    // URLs, and the edge keys on the pathname alone, as
    // internalRedirectTargetPath cuts it.
    const targetPath = rawTarget.split(/[?#]/u)[0];
    if (
      rawTarget.includes("\\")
      || CONTROL_CHARACTERS.test(rawTarget)
      || !isRequestSpelling(targetPath)
      || resolvesAway(targetPath)
    ) {
      throw entryError(
        "redirects.target_invalid",
        "a site-relative 'target' must be a single-slash absolute path such as /classes, whose path carries no "
          + "'.' or '..' segment and no percent-encoded dot or slash (a query string may). Write its path in the "
          + "percent-encoded spelling a browser sends (/caf%C3%A9, /old%20page), never the raw one.",
        `${field}.target`,
      );
    }
    target = rawTarget.startsWith("/") ? rawTarget : `/${rawTarget}`;
  }

  const status = value.status === undefined ? DEFAULT_REDIRECT_STATUS : value.status;
  if (!REDIRECT_STATUSES.includes(status)) {
    throw entryError(
      "redirects.status_invalid",
      `'status' must be one of ${REDIRECT_STATUSES.join(", ")}.`,
      `${field}.status`,
    );
  }

  return { path, kind: REDIRECT_KIND_REDIRECT, target, status };
}

// The marker is stored under the decoded spelling, so `/%61` and `/a` are one route
// and `/%61 -> /a` is a loop. A target's escape may not decode; it then compares raw.
function routeIdentity(path) {
  try {
    return decodeURIComponent(path).toLowerCase();
  } catch {
    return path.toLowerCase();
  }
}

function assertNoChains(entries) {
  const sources = new Set(entries.map((entry) => routeIdentity(entry.path)));
  entries.forEach((entry, index) => {
    const targetPath = internalRedirectTargetPath(entry);
    if (targetPath === undefined || !sources.has(routeIdentity(targetPath))) return;
    const field = `entries[${index}].target`;
    if (routeIdentity(targetPath) === routeIdentity(entry.path)) {
      throw entryError("redirects.loop", `'${entry.path}' redirects to itself.`, field);
    }
    throw entryError(
      "redirects.chain",
      `'${entry.path}' targets '${targetPath}', which is itself a redirect source. Point it at the final `
        + "destination instead; Taproot refuses chains rather than following them.",
      field,
    );
  });
}

/**
 * Validates the whole `redirects.json` document and returns the normalized map
 * a push sends. The document is `{ siteId, revision, entries }` — the same
 * shape `redirects pull` writes — so a workspace file always says which site
 * and which read it belongs to.
 *
 * `baselineEntries` is how many entries the last pull recorded in the manifest,
 * and it scopes the entry-count bound exactly as the site scopes it: a map that
 * was already over the cap when it was pulled validates and pushes back, so
 * accumulated path history never has to be deleted to make a push land, while a
 * document authored past the cap is still refused offline. A caller with no
 * baseline — a fixture, whose entries are all authored — passes none and gets
 * the bare cap.
 */
export function validateRedirectsDocument(
  document_,
  siteId,
  { requireRevision = true, baselineEntries = 0 } = {},
) {
  if (!isPlainObject(document_)) {
    throw new SiteAuthoringError(
      "redirects.document_invalid",
      `${REDIRECTS_FILE_NAME} must be the redirect document written by pull: { siteId, revision, entries }.`,
      { field: REDIRECTS_FILE_NAME },
    );
  }
  if (document_.siteId !== siteId) {
    throw new SiteAuthoringError(
      "redirects.site_mismatch",
      `${REDIRECTS_FILE_NAME} is not bound to this site. Run 'taproot-site pull' again.`,
      { field: "siteId" },
    );
  }
  if (requireRevision && !isRedirectMapRevision(document_.revision)) {
    throw new SiteAuthoringError(
      "redirects.revision_invalid",
      `${REDIRECTS_FILE_NAME} does not record the map revision it was read at. Run 'taproot-site redirects pull' `
        + "again before pushing; without it a push could delete an entry a page rename recorded since.",
      { field: "revision" },
    );
  }
  if (!Array.isArray(document_.entries)) {
    throw new SiteAuthoringError(
      "redirects.entries_invalid",
      `${REDIRECTS_FILE_NAME} must carry an 'entries' array.`,
      { field: "entries" },
    );
  }
  const baseline = Number.isInteger(baselineEntries) && baselineEntries > 0 ? baselineEntries : 0;
  if (document_.entries.length > Math.max(REDIRECT_LIMITS.entries, baseline)) {
    throw new SiteAuthoringError(
      "redirects.too_many_entries",
      `A site's redirect map cannot hold more than ${REDIRECT_LIMITS.entries} entries, and the last pull `
        + `recorded ${baseline}, so a push may carry that many back or fewer; this document holds `
        + `${document_.entries.length}.`,
      { field: "entries" },
    );
  }

  const seen = new Set();
  const entries = document_.entries.map((entry, index) => validateEntry(entry, index, seen));
  assertNoChains(entries);
  return {
    siteId,
    revision: document_.revision,
    entries: entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)),
  };
}

/** Projects a map read from the API into the document shape pull writes. */
export function projectRedirectMapForWorkspace(siteId, map) {
  return {
    siteId,
    revision: map.revision,
    entries: map.entries.map((entry) => ({
      path: entry.path,
      kind: entry.kind,
      ...(entry.kind === REDIRECT_KIND_GONE ? {} : { target: entry.target }),
      status: entry.status,
      origin: entry.origin,
    })),
  };
}
