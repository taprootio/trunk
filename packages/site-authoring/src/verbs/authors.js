import { createSiteAuthor, listSiteAuthors, withRefusalGuidance } from "../api.js";
import {
  AUTHOR_DISPLAY_NAME_MAXIMUM_LENGTH,
  AUTHOR_HANDLE_MAXIMUM_LENGTH,
  AUTHORS_FILE_NAME,
  normalizeAuthorEmail,
  normalizeAuthorHandle,
  projectAuthorsForWorkspace,
} from "../authors-contract.js";
import { VERB_AUTHORS_ADD, VERB_AUTHORS_LIST } from "../constants.js";
import { sanitizeDiagnostic, SiteAuthoringError } from "../errors.js";
import { boundedList, openSession, successResult } from "../session.js";
import { ApiError } from "../transport.js";
import { ensureWorkspaceRoot, writeWorkspaceJson } from "../workspace.js";

const MAXIMUM_REPORTED = 200;

/**
 * `authors list` — who a page can be credited to (TR01196): the site's authors
 * without a Taproot account and the members who can create pages. It also
 * rewrites `authors.json`, the copy `validate` and `pages push` check an
 * author reference against when they run offline.
 */
export async function authorsList(invocation) {
  const { client, config, siteId, onProgress } = await openSession(invocation);
  const listing = await withRefusalGuidance(onProgress, "authors list", () => listSiteAuthors(client, siteId));
  await writeAuthorsFile(config, siteId, listing);

  onProgress(
    listing.authors.length === 0
      ? "This site has no site authors without a Taproot account."
      : `Site authors (handle: name):\n${
        listing.authors.map((author) => `  ${author.handle}: ${author.displayName}`).join("\n")
      }`,
  );
  onProgress(
    listing.members.length === 0
      ? "No member can be named as an author."
      : `Members who can be named (email: name):\n${
        listing.members.map((member) => `  ${member.email}: ${member.displayName}`).join("\n")
      }`,
  );
  const authors = boundedList(listing.authors, MAXIMUM_REPORTED);
  const members = boundedList(listing.members, MAXIMUM_REPORTED);
  return successResult(VERB_AUTHORS_LIST, siteId, {
    authorsFile: AUTHORS_FILE_NAME,
    authors: {
      total: listing.authors.length,
      items: authors.items,
      ...(authors.truncated ? { itemsTruncated: true } : {}),
    },
    members: {
      total: listing.members.length,
      items: members.items,
      ...(members.truncated ? { itemsTruncated: true } : {}),
    },
  });
}

/**
 * `authors add` — creates a site author, someone a page can be credited to who
 * has no Taproot account, such as one of an imported blog's authors.
 */
export async function authorsAdd(invocation) {
  const handle = normalizeAuthorHandle(invocation.authorHandle);
  if (handle === undefined) {
    throw new SiteAuthoringError(
      "authors.handle_invalid",
      `'${String(invocation.authorHandle ?? "").slice(0, 80)}' is not a handle. Use lowercase letters and digits `
        + `with single hyphens between them, at most ${AUTHOR_HANDLE_MAXIMUM_LENGTH} characters, such as jane-doe.`,
      { field: "handle", exitCode: 2 },
    );
  }
  const displayName = typeof invocation.authorName === "string" ? invocation.authorName.trim() : "";
  if (displayName === "" || [...displayName].length > AUTHOR_DISPLAY_NAME_MAXIMUM_LENGTH) {
    throw new SiteAuthoringError(
      "authors.name_invalid",
      `--name must be the name readers see, 1 to ${AUTHOR_DISPLAY_NAME_MAXIMUM_LENGTH} characters.`,
      { field: "name", exitCode: 2 },
    );
  }
  let email;
  if (invocation.authorEmail !== undefined) {
    email = normalizeAuthorEmail(invocation.authorEmail);
    if (email === undefined) {
      throw new SiteAuthoringError("authors.email_invalid", "--email must be an email address.", {
        field: "email",
        exitCode: 2,
      });
    }
  }

  const { client, config, siteId, onProgress } = await openSession(invocation);
  // A handle that is already taken by the same person is a repeat of this
  // command, not a mistake: a script that adds its authors again succeeds.
  let existing = false;
  let known;
  const created = await withRefusalGuidance(onProgress, "authors add", async () => {
    try {
      return await createSiteAuthor(client, siteId, { handle, displayName, email });
    } catch (error) {
      const refusal = translateAuthorsRefusal(error, handle);
      if (refusal?.code !== "authors.handle_taken") throw refusal;
      known = await listSiteAuthors(client, siteId);
      const held = known.authors.find((author) => author.handle === handle);
      if (held === undefined) throw refusal;
      if (held.displayName !== displayName) {
        throw new SiteAuthoringError(
          "authors.handle_taken",
          `A site author with the handle '${handle}' already exists, named '${held.displayName}', not `
            + `'${displayName}'. Use another handle, or the existing author.`,
          { field: "handle" },
        );
      }
      existing = true;
      return held;
    }
  });
  onProgress(
    existing
      ? `Site author '${created.handle}' (${created.displayName}) already exists; nothing was created.`
      : `Created site author '${created.handle}' (${created.displayName}).`,
  );

  // The listing is read back rather than patched, so authors.json is exactly
  // what the site holds. Created is created: a failed refresh does not undo it.
  let refreshed = false;
  try {
    await writeAuthorsFile(config, siteId, known ?? await listSiteAuthors(client, siteId));
    refreshed = true;
  } catch (error) {
    if (!(error instanceof SiteAuthoringError)) throw error;
    onProgress(`The author was created, but ${AUTHORS_FILE_NAME} could not be refreshed: run 'authors list'.`);
  }
  return successResult(VERB_AUTHORS_ADD, siteId, {
    author: { handle: created.handle, displayName: created.displayName, hasEmail: created.hasEmail },
    existing,
    ...(refreshed ? { authorsFile: AUTHORS_FILE_NAME } : {}),
    nextStep: `Credit pages with 'author: ${created.handle}' in a page's front matter or `
      + `'pages meta set <path> --author ${created.handle}', then 'pages push'.`,
  });
}

async function writeAuthorsFile(config, siteId, listing) {
  await ensureWorkspaceRoot(config);
  await writeWorkspaceJson(config.workspaceDir, AUTHORS_FILE_NAME, projectAuthorsForWorkspace(siteId, listing));
}

/** Gives the site's refusals of a new author the stable codes the CLI documents. */
function translateAuthorsRefusal(error, handle) {
  if (!(error instanceof ApiError)) return error;
  for (const [field, code, fallback] of [
    ["HandleTaken", "authors.handle_taken", `A site author with the handle '${handle}' already exists.`],
    ["Handle", "authors.handle_invalid", `'${handle}' cannot be used as a handle.`],
    ["DisplayName", "authors.name_invalid", "The name was refused."],
    ["Email", "authors.email_invalid", "The email address was refused."],
  ]) {
    if (error.hasField(field)) {
      return new SiteAuthoringError(
        code,
        sanitizeDiagnostic(error.descriptionFor(field) ?? fallback, fallback),
        { field: field.toLowerCase() },
      );
    }
  }
  return error;
}
