import { SiteAuthoringError } from "./errors.js";

/**
 * Who a page can be credited to (TR01196).
 *
 * A page's author is one of two kinds of person, named by one string:
 *
 * - a site member who can create pages, by email address; or
 * - a site author without a Taproot account, by handle. Handles are a
 *   lowercase slug the site fixes when the author is created, so a page keeps
 *   pointing at the same person if their display name changes.
 *
 * The two spellings cannot collide: a handle never contains '@'. The site
 * folds case on both (an address is stored lowercase, a handle is lowercase),
 * so this module does too, and compares only folded values.
 */

export const AUTHORS_FILE_NAME = "authors.json";

export const AUTHOR_HANDLE_MAXIMUM_LENGTH = 64;
export const AUTHOR_DISPLAY_NAME_MAXIMUM_LENGTH = 256;
export const AUTHOR_EMAIL_MAXIMUM_LENGTH = 320;

const HANDLE = /^[a-z0-9]+(-[a-z0-9]+)*$/u;
// Deliberately loose: the site canonicalizes and decides. This only tells an
// address from a handle and refuses text that cannot be one.
const EMAIL = /^[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+$/u;

export const AUTHOR_KIND_HANDLE = "handle";
export const AUTHOR_KIND_EMAIL = "email";

/** The folded handle, or undefined when the text is not a handle. */
export function normalizeAuthorHandle(value) {
  if (typeof value !== "string") return undefined;
  const handle = value.trim().toLowerCase();
  return handle.length > 0 && handle.length <= AUTHOR_HANDLE_MAXIMUM_LENGTH && HANDLE.test(handle)
    ? handle
    : undefined;
}

/** The folded address, or undefined when the text is not an email address. */
export function normalizeAuthorEmail(value) {
  if (typeof value !== "string") return undefined;
  const email = value.trim().toLowerCase();
  return email.length <= AUTHOR_EMAIL_MAXIMUM_LENGTH && EMAIL.test(email) ? email : undefined;
}

/**
 * What an `author` reference names: `{ kind, value }` with the folded value, or
 * undefined for text that is neither a handle nor an email address.
 */
export function parseAuthorReference(value) {
  if (typeof value !== "string") return undefined;
  if (value.includes("@")) {
    const email = normalizeAuthorEmail(value);
    return email === undefined ? undefined : { kind: AUTHOR_KIND_EMAIL, value: email };
  }
  const handle = normalizeAuthorHandle(value);
  return handle === undefined ? undefined : { kind: AUTHOR_KIND_HANDLE, value: handle };
}

/** The folded reference, or a refusal that names where it was written. */
export function requireAuthorReference(value, field, code = "pages.author_invalid") {
  const reference = parseAuthorReference(value);
  if (reference === undefined) {
    throw new SiteAuthoringError(
      code,
      `'${typeof value === "string" ? value.slice(0, 80) : ""}' is not an author reference. Name a site author by `
        + "handle (lowercase letters, digits and hyphens, such as jane-doe) or a site member by email address.",
      { field },
    );
  }
  return reference.value;
}

function boundedText(value, maximum) {
  return typeof value === "string" && value.length <= maximum ? value : undefined;
}

/**
 * Reads the site's author listing, refusing a response that does not have the
 * shape this CLI relies on. A member's address is only present for a caller
 * allowed to see it; the CLI's credential is, so an absent one is dropped.
 */
export function normalizeAuthorListing(value) {
  const listing = value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
  const authors = [];
  for (const raw of Array.isArray(listing.authors) ? listing.authors : []) {
    const handle = normalizeAuthorHandle(raw?.handle);
    if (handle === undefined) continue;
    authors.push({
      handle,
      displayName: boundedText(raw.displayName, AUTHOR_DISPLAY_NAME_MAXIMUM_LENGTH) ?? "",
      hasEmail: raw.hasEmail === true || (typeof raw.email === "string" && raw.email !== ""),
    });
  }
  const members = [];
  for (const raw of Array.isArray(listing.members) ? listing.members : []) {
    const email = normalizeAuthorEmail(raw?.email);
    if (email === undefined) continue;
    members.push({
      email,
      displayName: boundedText(raw.displayName, AUTHOR_DISPLAY_NAME_MAXIMUM_LENGTH) ?? "",
    });
  }
  return { authors, members };
}

/**
 * The workspace file `pull` and `authors list` write. Site authors carry no
 * address: it is private to the site and nothing local needs it. Members carry
 * theirs, because that is how a page names them.
 */
export function projectAuthorsForWorkspace(siteId, listing) {
  return {
    siteId,
    authors: listing.authors.map(({ handle, displayName }) => ({ handle, displayName })),
    members: listing.members.map(({ email, displayName }) => ({ email, displayName })),
  };
}

/**
 * Reads `authors.json` back. Anything unreadable or bound to another site is
 * treated as absent: it can only ever make a reference unprovable offline,
 * never turn a valid one into a refusal.
 */
export function readAuthorsDocument(value, siteId) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || value.siteId !== siteId) {
    return undefined;
  }
  const handles = new Set();
  for (const author of Array.isArray(value.authors) ? value.authors : []) {
    const handle = normalizeAuthorHandle(author?.handle);
    if (handle !== undefined) handles.add(handle);
  }
  const emails = new Set();
  for (const member of Array.isArray(value.members) ? value.members : []) {
    const email = normalizeAuthorEmail(member?.email);
    if (email !== undefined) emails.add(email);
  }
  return { handles, emails };
}

/**
 * Whether a folded reference names someone the recorded listing knows, or
 * `undefined` when there is no listing to ask.
 */
export function authorKnown(authors, reference) {
  if (authors === undefined) return undefined;
  const parsed = parseAuthorReference(reference);
  if (parsed === undefined) return false;
  return parsed.kind === AUTHOR_KIND_EMAIL ? authors.emails.has(parsed.value) : authors.handles.has(parsed.value);
}

/**
 * The refusal text for a source that names a different author than the site
 * holds. The way out depends on where the author is written: a `.pm.json`
 * page keeps it in the workspace manifest, edited with `pages meta set`; a
 * Markdown page keeps it in its front matter (TR01196).
 */
export function authorConflictMessage({ shown, file, held, wanted, markdown }) {
  const lead = `Page '${shown}' already has the author '${held}'`
    + (wanted === undefined ? "" : `, and '${file}' names '${wanted}'`)
    + ". An author is never replaced from the CLI";
  return markdown
    ? `${lead}: set 'author: ${held}' in the front matter, or remove the line, to match the site. To credit someone `
      + "else, change it in the app."
    : `${lead}: run 'taproot-site pages meta set ${shown} --author ${held}' to match the site. To credit someone `
      + "else, change it in the app.";
}
