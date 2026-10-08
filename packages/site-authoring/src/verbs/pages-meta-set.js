import {
  AUTHORS_FILE_NAME,
  authorConflictMessage,
  authorKnown,
  parseAuthorReference,
  readAuthorsDocument,
  requireAuthorReference,
} from "../authors-contract.js";
import { VERB_PAGES_META_SET } from "../constants.js";
import { SiteAuthoringError } from "../errors.js";
import { descriptionWarnings, PAGE_AUTHOR_UNVERIFIED, requireDescriptionLength } from "../page-metadata.js";
import { openAnonymousSession, successResult } from "../session.js";
import { isGeneratedTemplateType, TEMPLATE_GENERATED, typedDocumentFromJson } from "../typed-pages.js";
import {
  displayPagePath,
  normalizePagePath,
  PAGE_SOURCE_FORMAT_MARKDOWN,
  PAGE_WORKSPACE_MODE_EDITABLE,
  readManifest,
  readWorkspaceFile,
  readWorkspaceJson,
  workspaceFileExists,
  WORKSPACE_LIMITS,
  writeManifest,
  writeWorkspaceJson,
} from "../workspace.js";

/**
 * `pages meta set` — the supported way to change a .pm.json page's title,
 * description or author, which live in the workspace manifest rather than the
 * file (TR01194, TR01196). It edits the workspace only; `pages push` sends the
 * change, since the page's content key covers all three.
 *
 * The author is the one field that can only be filled, never changed: pages are
 * authorless by default and an author already on the page is never replaced.
 *
 * A generated page keeps its own title and description in its source document
 * (`data.customTitle`, `data.customDescription`), because the manifest holds the
 * ones the site reports; an empty value there means "use the generated default"
 * (TR01195).
 */
export async function pagesMetaSet(invocation) {
  const { config, onProgress } = await openAnonymousSession({ ...invocation, client: null });
  if (config === undefined) {
    throw new SiteAuthoringError(
      "config.not_found",
      "No taproot-site.json was found. pages meta set edits the workspace it names.",
    );
  }
  // The parser refuses this too; a handler called directly must not report
  // "nothing changed" for a request that asked for nothing.
  if (
    invocation.metaTitle === undefined && invocation.metaDescription === undefined
    && invocation.metaAuthor === undefined
  ) {
    throw new SiteAuthoringError(
      "pages.meta_nothing_to_set",
      "Name what to set: --title, --description, --author, or any of them.",
      { exitCode: 2 },
    );
  }
  // Surrounding whitespace is never meant; the site would keep it otherwise.
  const title = invocation.metaTitle?.trim();
  const description = invocation.metaDescription?.trim();
  // An empty --author clears one that was never sent; any other value is a reference.
  const clearAuthor = invocation.metaAuthor === "";
  const author = invocation.metaAuthor === undefined || clearAuthor
    ? undefined
    : requireAuthorReference(invocation.metaAuthor, "author");
  const requested = normalizePagePath(invocation.metaPagePath);
  if (requested === undefined) {
    throw new SiteAuthoringError("pages.meta_path_invalid", "The page path is not usable.", {
      field: "pagePath",
      exitCode: 2,
    });
  }
  const manifest = await readManifest(config.workspaceDir, config.siteId);
  const entry = manifest.pages.find((candidate) => normalizePagePath(candidate?.path) === requested);
  const shown = displayPagePath(requested);
  if (entry === undefined) {
    throw new SiteAuthoringError(
      "pages.meta_page_unknown",
      `No page this workspace tracks is at '${shown}'. Run 'taproot-site pull' if it was created elsewhere.`,
      { field: shown },
    );
  }
  if (entry.workspaceMode !== PAGE_WORKSPACE_MODE_EDITABLE) {
    throw new SiteAuthoringError(
      "pages.meta_page_readonly",
      `'${shown}' is not an editable page in this workspace, so its title, description and author cannot be set here.`,
      { field: shown },
    );
  }
  if (entry.sourceFormat === PAGE_SOURCE_FORMAT_MARKDOWN) {
    throw new SiteAuthoringError(
      "pages.meta_markdown",
      `'${shown}' is authored in ${entry.file}, whose front matter holds its title, description and author; edit them there.`,
      { field: shown },
    );
  }
  // The manifest entry outlives a deleted source, and pull re-creates the file
  // from the site, which would silently drop an edit made here.
  if (typeof entry.file !== "string" || !await workspaceFileExists(config.workspaceDir, entry.file)) {
    throw new SiteAuthoringError(
      "pages.meta_source_missing",
      `'${shown}' has no source file in this workspace. Run 'taproot-site pull' to restore it first.`,
      { field: shown },
    );
  }
  if (description !== undefined) requireDescriptionLength(description);
  // A generated page's custom title and description are in its source, where
  // pull already protects an edit like any other.
  if (isGeneratedTemplateType(entry.templateType)) {
    if (author !== undefined || clearAuthor) {
      throw new SiteAuthoringError(
        "pages.meta_author_generated",
        `'${shown}' is a page Taproot generates, so it has no author to set.`,
        { field: shown },
      );
    }
    return await setGeneratedMetadata({ invocation, config, entry, shown, onProgress });
  }
  // pull tells a metadata edit from the site's values by the content key the
  // last pull or push recorded. Without one the edit could not be protected,
  // and the next pull would quietly overwrite it.
  if (typeof entry.baseline?.sourceHash !== "string" || typeof entry.baseline?.contentKey !== "string") {
    throw new SiteAuthoringError(
      "pages.meta_unreconciled",
      `'${shown}' has not been reconciled with the site yet, so an edit here could be lost to the next pull. Run `
        + "'taproot-site pull' (or push the page) first.",
      { field: shown },
    );
  }
  if (title === "") {
    throw new SiteAuthoringError(
      "pages.meta_title_empty",
      `'${shown}' needs a title. Only a generated page can clear its title, to use the default one.`,
      { field: "title", exitCode: 2 },
    );
  }

  let unverifiedAuthor = false;
  if (clearAuthor) requireClearableAuthor({ entry, shown });
  else if (author !== undefined) {
    unverifiedAuthor = await requireAssignableAuthor({ config, entry, shown, author });
    if (unverifiedAuthor) {
      onProgress(
        `Warning: '${author}' is not in ${AUTHORS_FILE_NAME}; it may have been added since. 'taproot-site authors list' `
          + "refreshes it, and 'pages push' checks the name against the site before sending.",
      );
    }
  }

  const next = {
    title: title ?? entry.title,
    description: description ?? entry.description ?? "",
    author: clearAuthor ? "" : author ?? entry.author ?? "",
  };
  const changed = next.title !== entry.title
    || next.description !== (entry.description ?? "")
    || next.author !== (entry.author ?? "");
  if (changed) {
    entry.title = next.title;
    entry.description = next.description;
    if (next.author === "") delete entry.author;
    else entry.author = next.author;
    await writeManifest(config.workspaceDir, manifest);
    onProgress(`Set the ${describeFields(invocation)} of '${shown}'. Run 'taproot-site pages push' to send it.`);
  } else {
    onProgress(`'${shown}' already has that ${describeFields(invocation)}; nothing changed.`);
  }
  return successResult(VERB_PAGES_META_SET, config.siteId, {
    page: {
      path: shown,
      file: entry.file,
      title: next.title,
      description: next.description,
      ...(next.author === "" ? {} : { author: next.author }),
    },
    changed,
    ...descriptionWarnings([{ file: entry.file, pagePath: entry.path, description: next.description }], onProgress),
    ...(unverifiedAuthor
      ? {
        authorWarnings: {
          total: 1,
          items: [{ code: PAGE_AUTHOR_UNVERIFIED, file: entry.file, path: shown, author: next.author }],
        },
      }
      : {}),
    ...(changed ? { nextStep: "pages push" } : {}),
  });
}

function describeFields(invocation) {
  return [
    invocation.metaTitle !== undefined && "title",
    invocation.metaDescription !== undefined && "description",
    invocation.metaAuthor !== undefined && "author",
  ]
    .filter(Boolean)
    .join(" and ");
}

/**
 * Refuses an author the site would not take: a different one than the site
 * holds (never replaced). One that `authors.json` lacks is only warned about,
 * because this verb is offline and the file is as old as the last `pull` or
 * `authors list`: the person may have been added since, and `pages push` asks
 * the site before it sends anything. Answers whether the name is unverified.
 */
async function requireAssignableAuthor({ config, entry, shown, author }) {
  const held = parseAuthorReference(entry.baseline?.author)?.value ?? "";
  if (held !== "" && held !== author) {
    throw new SiteAuthoringError(
      "pages.author_conflict",
      authorConflictMessage({ shown, held, wanted: author, markdown: false, file: entry.file }),
      { field: shown },
    );
  }
  if (held === author) return false;
  let recorded;
  try {
    if (await workspaceFileExists(config.workspaceDir, AUTHORS_FILE_NAME)) {
      recorded = readAuthorsDocument(
        await readWorkspaceJson(config.workspaceDir, AUTHORS_FILE_NAME, WORKSPACE_LIMITS.authorsBytes),
        config.siteId,
      );
    }
  } catch {
    recorded = undefined;
  }
  return authorKnown(recorded, author) === false;
}

/**
 * `--author ""` drops an author this workspace has not sent yet. It never asks
 * the site to remove one: once the site holds an author (the last pull or push
 * recorded it), only the app changes that, so the request is refused rather
 * than quietly leaving the author in place.
 */
function requireClearableAuthor({ entry, shown }) {
  const held = parseAuthorReference(entry.baseline?.author)?.value ?? "";
  if (held !== "") {
    throw new SiteAuthoringError(
      "pages.author_conflict",
      `Page '${shown}' already has the author '${held}', and an author is never removed from the CLI. `
        + "To change or remove it, use the app.",
      { field: shown },
    );
  }
}

/** Sets a generated page's custom title or description in its source document. */
async function setGeneratedMetadata({ invocation, config, entry, shown, onProgress }) {
  let parsed;
  try {
    const bytes = await readWorkspaceFile(config.workspaceDir, entry.file, WORKSPACE_LIMITS.documentBytes);
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    if (error instanceof SiteAuthoringError) throw error;
    throw new SiteAuthoringError("pages.document_shape", `'${entry.file}' is not valid JSON.`, { field: entry.file });
  }
  const document_ = typedDocumentFromJson(parsed, entry.file);
  if (document_.template !== TEMPLATE_GENERATED) {
    throw new SiteAuthoringError(
      "pages.meta_page_readonly",
      `'${entry.file}' is not a generated-page source, so '${shown}' cannot be set from it.`,
      { field: shown },
    );
  }
  const data = {
    ...document_.data,
    ...(invocation.metaTitle === undefined ? {} : { customTitle: invocation.metaTitle.trim() }),
    ...(invocation.metaDescription === undefined ? {} : { customDescription: invocation.metaDescription.trim() }),
  };
  const next = typedDocumentFromJson({ ...document_, data }, entry.file);
  const changed = next.data.customTitle !== document_.data.customTitle
    || next.data.customDescription !== document_.data.customDescription;
  if (changed) {
    await writeWorkspaceJson(config.workspaceDir, entry.file, next);
    onProgress(
      `Set the ${describeFields(invocation)} of '${shown}' in ${entry.file}. Run 'taproot-site pages push' to send it.`,
    );
  } else {
    onProgress(`'${shown}' already has that ${describeFields(invocation)}; nothing changed.`);
  }
  return successResult(VERB_PAGES_META_SET, config.siteId, {
    // The owner's own values; empty means the page uses its generated default.
    page: {
      path: shown,
      file: entry.file,
      title: next.data.customTitle,
      description: next.data.customDescription,
      generated: true,
    },
    changed,
    ...descriptionWarnings(
      [{ file: entry.file, pagePath: entry.path, description: next.data.customDescription }],
      onProgress,
    ),
    ...(changed ? { nextStep: "pages push" } : {}),
  });
}
