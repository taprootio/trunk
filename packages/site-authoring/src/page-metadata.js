import { SiteAuthoringError } from "./errors.js";
import { boundedByBytes } from "./session.js";
import { displayPagePath } from "./workspace.js";

/**
 * A page description is what search results and link previews show. Past about
 * 160 characters search engines cut it off, so it is warned about; past 1000 it
 * is refused, here and by the API (TR01194).
 */
export const DESCRIPTION_WARN_LENGTH = 160;
export const DESCRIPTION_MAXIMUM_LENGTH = 1000;
export const PAGE_DESCRIPTION_LONG = "pages.description_long";

const length = (value) => [...value].length;

/** Refuses a description the API would refuse. */
export function requireDescriptionLength(description, field = "description") {
  if (typeof description === "string" && length(description) > DESCRIPTION_MAXIMUM_LENGTH) {
    throw new SiteAuthoringError(
      "pages.description_too_long",
      `The description is ${length(description)} characters; it may be at most ${DESCRIPTION_MAXIMUM_LENGTH} `
        + `(search results show about ${DESCRIPTION_WARN_LENGTH}).`,
      { field },
    );
  }
}

/** Warnings for descriptions search results will cut off, named per page. */
export function descriptionWarnings(pages, onProgress) {
  const items = [];
  for (const page of pages ?? []) {
    const description = page.declaredDescription ?? page.description;
    if (typeof description !== "string" || length(description) <= DESCRIPTION_WARN_LENGTH) continue;
    const item = {
      code: PAGE_DESCRIPTION_LONG,
      file: page.file,
      path: displayPagePath(page.pagePath ?? page.path),
      length: length(description),
    };
    onProgress(
      `Warning: ${item.file}'s description is ${item.length} characters; search results show about `
        + `${DESCRIPTION_WARN_LENGTH}.`,
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
