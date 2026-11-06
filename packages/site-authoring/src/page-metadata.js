import { SiteAuthoringError } from "./errors.js";
import { DESCRIPTION_WARN_LENGTH } from "./page-structure-checks.js";
import { boundedByBytes } from "./session.js";
import { displayPagePath } from "./workspace.js";

/**
 * Description length advice is shared with the document rules. The separate
 * descriptionWarnings output stays compatible; the 1000-character storage
 * maximum is still enforced here and by the API (TR01194).
 */
export { DESCRIPTION_WARN_LENGTH };
export const DESCRIPTION_MAXIMUM_LENGTH = 1000;
export const PAGE_DESCRIPTION_LONG = "pages.description_long";

const length = (value) => [...value].length;

/** Refuses a description the API would refuse. */
export function requireDescriptionLength(description, field = "description") {
  if (typeof description === "string" && length(description) > DESCRIPTION_MAXIMUM_LENGTH) {
    throw new SiteAuthoringError(
      "pages.description_too_long",
      `The description is ${length(description)} characters; it may be at most ${DESCRIPTION_MAXIMUM_LENGTH} `
        + `(the writing guidance is at most ${DESCRIPTION_WARN_LENGTH}).`,
      { field },
    );
  }
}

/** The compatible length-warning output for known author-entered descriptions. */
export function descriptionWarnings(pages, onProgress) {
  const items = [];
  for (const page of pages ?? []) {
    const description = page.metadataDescriptionKnown === false ? undefined : page.declaredDescription ?? page.description;
    if (typeof description !== "string" || length(description.trim()) <= DESCRIPTION_WARN_LENGTH) continue;
    const item = {
      code: PAGE_DESCRIPTION_LONG,
      file: page.file,
      path: displayPagePath(page.pagePath ?? page.path),
      length: length(description.trim()),
    };
    onProgress(
      `Warning: ${item.file}'s description is ${item.length} characters; consider shortening it `
        + `(guidance: at most ${DESCRIPTION_WARN_LENGTH}).`,
    );
    items.push(item);
  }
  const reported = boundedByBytes(items, 8 * 1024);
  return items.length === 0
    ? {}
    : {
      descriptionWarnings: {
        total: items.length,
        items: reported.items,
        ...(reported.truncated ? { truncated: true } : {}),
      },
    };
}

export const PAGE_AUTHOR_UNVERIFIED = "pages.author_unverified";

/**
 * Warnings for authors an offline run could not confirm (TR01196). The only
 * evidence offline is `authors.json`, which is as old as the last `pull` or
 * `authors list`, so a name missing from it may simply be newer; it is flagged
 * rather than refused, and an online run settles it against the site.
 */
export function authorWarnings(pages, onProgress) {
  const items = [];
  for (const page of pages ?? []) {
    if (page.authorUnverified !== true) continue;
    const item = {
      code: PAGE_AUTHOR_UNVERIFIED,
      file: page.file,
      path: displayPagePath(page.pagePath ?? page.path),
      author: page.author,
    };
    onProgress(
      `Warning: ${item.file} names author '${item.author}', who is not in authors.json; it may have been added `
        + "since. 'taproot-site authors list' refreshes it, and 'pages push' checks the name against the site.",
    );
    items.push(item);
  }
  const reported = boundedByBytes(items, 8 * 1024);
  return items.length === 0
    ? {}
    : {
      authorWarnings: {
        total: items.length,
        items: reported.items,
        ...(reported.truncated ? { truncated: true } : {}),
      },
    };
}
