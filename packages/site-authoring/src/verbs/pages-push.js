import {
  createPage,
  freeFormTemplate,
  listSitePages,
  PAGE_STATUS_DELETED,
  TEMPLATE_TYPE_FREE_FORM,
  updatePage,
  withRefusalGuidance,
} from "../api.js";
import { VERB_PAGES_PUSH } from "../constants.js";
import { SiteAuthoringError } from "../errors.js";
import { boundedList, openSession, successResult, warnIfExternalWritesPaused } from "../session.js";
import { SETTINGS_TYPE_TAPROOT_STYLES } from "../settings-catalog.js";
import {
  hasNamedFreeFormSectionContext,
  sharedThemeContextNames,
  validateFreeFormSectionContexts,
} from "../content/free-form-sections.js";
import { CONTENT_ERROR_CODES } from "../content/vocabulary.js";
import {
  deleteWorkspaceFile,
  internalPageObservedRevisionFile,
  MEDIA_MANIFEST_FILE_NAME,
  normalizePageBodyRevision,
  normalizePagePath,
  PAGE_SOURCE_EXTENSIONS,
  PAGE_SOURCE_FORMAT_MARKDOWN,
  PAGE_SOURCE_FORMAT_PROSEMIRROR,
  pageSourceFormat,
  pageSourceRegistry,
  PAGES_DIRECTORY,
  readManifest,
  readMediaManifest,
  readObservedPageRevision,
  readOnlySystem404Projections,
  readWorkspaceFile,
  readWorkspaceJson,
  requireManifestSourceRegistry,
  SAFE_SEGMENT,
  SETTINGS_DIRECTORY,
  SYSTEM_PAGE_NOT_FOUND_PATH,
  walkWorkspaceFiles,
  WORKSPACE_LIMITS,
  workspaceContentHash,
  workspaceFileExists,
  writeManifest,
} from "../workspace.js";

/**
 * `pages push` — create and update pages from the local workspace.
 *
 * The verb runs in two phases, and the split is the point of it. Phase one
 * reads, converts, and *validates every document it will send* without touching
 * the API; phase two sends. The server checks a free-form body only for
 * presence, so a malformed document is accepted, stored, and then fails
 * silently at render — which means a push that validated page three after
 * publishing pages one and two would leave a half-broken site behind. Nothing
 * is sent until everything has passed.
 *
 * **What "everything" means depends on the selection.** With no page path, it
 * is the whole workspace: every authored source is resolved, converted, and
 * validated, and that is the command whose job is to report a page nobody has
 * touched since a contract changed. With page paths, it is those pages. A
 * selection resolves to its source from metadata alone — a manifest entry or a
 * front-matter block — before any document is converted, so an unrelated page
 * carrying an obsolete component shape is never converted at all and cannot
 * block a push it was never part of.
 *
 * Scoping the validation is not scoping the safety. Site binding, manifest
 * integrity, the live create-or-update resolution, system-page rules,
 * target-path uniqueness against the live site, media ownership, and two
 * workspace files claiming one page path all still fail closed for the
 * selection. What narrows is only the set of *other* pages whose bodies this
 * run has an opinion about.
 *
 * Wire facts the body honors:
 * - Home (path `""`) and `404` are seeded system pages: update-only, and their
 *   paths are immutable (`SystemPagePaths.IsPathChangeAllowed`).
 * - A page's template type is immutable after creation, so an update against a
 *   page that is not FREE_FORM is refused rather than sent.
 * - Creates are POST and updates are PATCH with a *whole* template, not a patch
 *   mask. Neither is replayed by the transport, so each is issued once and an
 *   ambiguous outcome surfaces as ambiguous.
 *
 * `rawHtml` renders verbatim and unsanitized. It is rejected unless the caller
 * explicitly asks for it via `allowRawHtml`, which is exactly the thing an
 * agent must not be able to emit by accident.
 *
 * Pull's system 404 is the deliberate exception to "every file is authored."
 * Its exact bytes remain inspectable in the workspace but carry a manifest
 * hash and read-only marker. An unchanged whole-workspace push skips it;
 * changing, deleting, or replacing it is a refusal before any remote write.
 */

const MAXIMUM_REPORTED = 200;
const FRONT_MATTER_FENCE = "---";
const FRONT_MATTER_KEYS = new Set(["title", "path", "description"]);
const FRONT_MATTER_ENTRY = /^([A-Za-z][A-Za-z0-9_]*)[ \t]*:[ \t]*(.*)$/u;

/**
 * The refusals that mean "this file does not say which page it is".
 *
 * A targeted push records one of these against the file and carries on: a
 * source that declares no page path cannot be the page the selection asked
 * for, so blocking on it is the whole of residual R3. The list is explicit
 * rather than "any error from the read", because a containment refusal, an
 * oversized file, or an unreadable one is not a metadata fault and must still
 * fail closed. A whole-workspace push reports every one of them as before.
 */
const RESOLUTION_METADATA_CODES = new Set([
  "pages.front_matter_missing",
  "pages.front_matter_unterminated",
  "pages.front_matter_invalid",
  "pages.front_matter_unknown",
  "pages.front_matter_duplicate",
  "pages.metadata_missing",
  "pages.path_missing",
  "pages.path_unsupported",
]);

function documentError(code, message, field) {
  return new SiteAuthoringError(code, message, { field });
}

function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && (trimmed.startsWith("\"") || trimmed.startsWith("'"))) {
    const quote = trimmed[0];
    if (trimmed.endsWith(quote)) return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * A deliberately tiny front-matter reader: exactly the three keys the page
 * contract needs, and a hard error on anything else. Silently dropping an
 * unrecognized key is how authored metadata disappears without a trace, and the
 * server would never notice.
 */
function parseFrontMatter(source, file) {
  const lines = source.split(/\r?\n/u);
  if (lines[0]?.trim() !== FRONT_MATTER_FENCE) {
    throw documentError(
      "pages.front_matter_missing",
      `'${file}' must begin with a '---' front-matter block declaring at least a title and a path.`,
      file,
    );
  }
  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === FRONT_MATTER_FENCE);
  if (closing < 0) {
    throw documentError("pages.front_matter_unterminated", `The front-matter block in '${file}' is not closed.`, file);
  }
  // The two faults above are structural: without a delimited block there is
  // nothing here to trust, so they still throw. Everything below is one bad
  // *entry* in a block whose other entries are perfectly readable, and the
  // first of those is carried back rather than thrown — because a file that
  // says `path: about` is a source for `about` even if the next line is
  // nonsense, and dropping it would let a second source for that path be sent
  // as though it were the only one. The caller raises the fault for any page
  // it actually intends to send.
  const values = new Map();
  let fault;
  const record = (candidate) => {
    fault ??= candidate;
  };
  for (const line of lines.slice(1, closing)) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const match = FRONT_MATTER_ENTRY.exec(line);
    if (!match) {
      record(documentError(
        "pages.front_matter_invalid",
        `'${file}' has a front-matter line that is not 'key: value'.`,
        file,
      ));
      continue;
    }
    const [, key, rawValue] = match;
    if (!FRONT_MATTER_KEYS.has(key)) {
      record(documentError(
        "pages.front_matter_unknown",
        `'${file}' declares unsupported front-matter field '${key}'. `
          + `Supported fields: ${[...FRONT_MATTER_KEYS].join(", ")}.`,
        key,
      ));
      continue;
    }
    const seen = values.get(key);
    if (seen === undefined) {
      values.set(key, [unquote(rawValue)]);
      continue;
    }
    record(documentError(
      "pages.front_matter_duplicate",
      `'${file}' declares front-matter field '${key}' twice.`,
      key,
    ));
    seen.push(unquote(rawValue));
  }
  // A repeated key is always a fault, but it is not always an *ambiguity*:
  // the same value written twice says exactly one thing. Only genuinely
  // differing values leave nothing to resolve, and those are handed back as
  // candidates rather than dropped, because a file that says either `about`
  // or `elsewhere` is a possible second source for both.
  const fields = new Map();
  const candidates = new Map();
  for (const [key, seen] of values) {
    const distinct = [...new Set(seen)];
    if (distinct.length === 1) fields.set(key, distinct[0]);
    else candidates.set(key, distinct);
  }
  return {
    fields,
    candidates,
    fault,
    markdown: lines.slice(closing + 1).join("\n"),
  };
}

const STYLES_FILE = `${SETTINGS_DIRECTORY}/taproot-styles.json`;

async function readSharedThemeContexts(workspaceDir, siteId) {
  const document_ = await readWorkspaceJson(workspaceDir, STYLES_FILE, WORKSPACE_LIMITS.settingsBytes);
  if (
    document_ === null
    || typeof document_ !== "object"
    || Array.isArray(document_)
    || document_.settings === null
    || typeof document_.settings !== "object"
    || Array.isArray(document_.settings)
    || document_.settings.lightTheme === null
    || typeof document_.settings.lightTheme !== "object"
    || Array.isArray(document_.settings.lightTheme)
    || document_.settings.darkTheme === null
    || typeof document_.settings.darkTheme !== "object"
    || Array.isArray(document_.settings.darkTheme)
  ) {
    throw documentError(
      "pages.theme_settings_invalid",
      `'${STYLES_FILE}' must be the complete Taproot styles document written by pull.`,
      STYLES_FILE,
    );
  }
  if (document_.entityId !== siteId || document_.settingsType !== SETTINGS_TYPE_TAPROOT_STYLES) {
    throw documentError(
      "pages.theme_settings_site_mismatch",
      `'${STYLES_FILE}' is not bound to site ${siteId} and ${SETTINGS_TYPE_TAPROOT_STYLES}. Run pull again.`,
      STYLES_FILE,
    );
  }
  return sharedThemeContextNames(document_.settings.lightTheme, document_.settings.darkTheme);
}

function unwrapProseMirrorDocument(parsed, file) {
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    if (parsed.type === "doc") return parsed;
    if (parsed.body !== null && typeof parsed.body === "object" && parsed.body?.type === "doc") return parsed.body;
  }
  throw documentError(
    "pages.document_shape",
    `'${file}' is not a ProseMirror document: expected a top-level object with "type": "doc".`,
    file,
  );
}

/**
 * The candidate keys a Markdown image reference could match in the media
 * manifest. Authors write `./media/hero.png`, `media/hero.png`, or
 * `/media/hero.png` for the same file, and a resolver that accepted only one
 * spelling would refuse content that is plainly correct.
 */
function mediaReferenceCandidates(reference) {
  if (typeof reference !== "string" || reference === "") return [];
  const withoutQuery = reference.split("#")[0].split("?")[0];
  const stripped = withoutQuery.replace(/^\.\//u, "").replace(/^\/+/u, "");
  const candidates = new Set([reference, withoutQuery, stripped]);
  if (!stripped.includes("/")) candidates.add(`media/${stripped}`);
  return [...candidates];
}

function makeResolveImage(mediaManifest, file) {
  return async (reference) => {
    for (const candidate of mediaReferenceCandidates(reference)) {
      const entry = mediaManifest.media[candidate];
      if (entry !== null && typeof entry === "object" && typeof entry.imageId === "string" && entry.imageId !== "") {
        return {
          imageId: entry.imageId,
          // `PageImageDeliveryRewriter` only replaces keys that are already
          // present, so a `taprootImage` node missing `src` or `urls` is
          // rewritten into nothing and renders blank. Both are handed back
          // empty and present.
          src: typeof entry.src === "string" ? entry.src : "",
          urls: Array.isArray(entry.urls) ? entry.urls : [],
          width: Number.isSafeInteger(entry.width) ? entry.width : 0,
          height: Number.isSafeInteger(entry.height) ? entry.height : 0,
          alt: typeof entry.alt === "string" ? entry.alt : "",
        };
      }
    }
    throw documentError(
      "media.unresolved_reference",
      `'${file}' references media '${reference}', which is not recorded in ${MEDIA_MANIFEST_FILE_NAME}. `
        + "Run 'taproot-site media upload' first.",
      typeof reference === "string" ? reference : file,
    );
  };
}

/**
 * S3 owns `src/content/`. It is imported dynamically so this build stays
 * loadable — and every other verb stays usable — before that slice lands, and
 * so tests can inject the seam directly.
 */
async function loadContentModule(injected) {
  if (injected !== undefined) return injected;
  try {
    return await import("../content/index.js");
  } catch {
    throw new SiteAuthoringError(
      "content.unavailable",
      "The Markdown and ProseMirror content pipeline is not available in this build.",
    );
  }
}

function requireContentFunctions(content) {
  if (
    content === null
    || typeof content !== "object"
    || typeof content.validateDocument !== "function"
    || typeof content.markdownToProseMirror !== "function"
  ) {
    throw new SiteAuthoringError(
      "content.contract_invalid",
      "The content pipeline does not expose validateDocument and markdownToProseMirror.",
    );
  }
  return content;
}

function assertValid(content, document_, file, allowRawHtml) {
  const outcome = content.validateDocument(document_, { allowRawHtml });
  const errors = outcome === null || typeof outcome !== "object" ? undefined : outcome.errors;
  if (!Array.isArray(errors)) {
    throw new SiteAuthoringError(
      "content.contract_invalid",
      "The content validator did not return a list of validation errors.",
    );
  }
  if (errors.length === 0) return;
  const first = errors[0] ?? {};
  const location = typeof first.path === "string" && first.path !== "" ? first.path : "doc";
  throw documentError(
    first.code === CONTENT_ERROR_CODES.rawHtmlForbidden ? CONTENT_ERROR_CODES.rawHtmlForbidden : "pages.document_invalid",
    `'${file}' is not a valid Taproot document: ${errors.length} problem(s), first at ${location} (${
      typeof first.code === "string" ? first.code : "invalid"
    }): ${typeof first.message === "string" ? first.message : "the node or mark is outside the accepted vocabulary."}`,
    `${file}:${location}`,
  );
}

function systemPageKind(pagePath) {
  if (pagePath === "") return "home";
  return pagePath.toLowerCase() === SYSTEM_PAGE_NOT_FOUND_PATH ? "notFound" : undefined;
}

function requireText(value, code, message, field) {
  if (typeof value !== "string" || value.trim() === "") throw documentError(code, message, field);
  return value;
}

/**
 * Reads one editable page source and resolves the metadata that says *which
 * page it is* — no Markdown conversion, no media resolution, no document
 * vocabulary.
 *
 * The split is what makes a targeted push targeted. Deciding whether a file
 * claims the requested path costs a read and a front-matter parse; deciding
 * whether its body is still valid costs the whole content pipeline, and that
 * is where a page left on an obsolete component contract fails. Resolving
 * identity separately means an unrelated stale page is never converted at all,
 * so it cannot block a push that was never going to send it.
 */
export async function readWorkspacePageSource({ workspaceDir, file, manifestEntry }) {
  const isMarkdown = pageSourceFormat(file) === PAGE_SOURCE_FORMAT_MARKDOWN;
  const bytes = await readWorkspaceFile(workspaceDir, file, WORKSPACE_LIMITS.documentBytes);
  const source = bytes.toString("utf8");

  let markdown;
  let fault;
  let pathCandidates = [];
  let title;
  let declaredDescription;
  let declaredPath;
  if (isMarkdown) {
    const frontMatter = parseFrontMatter(source, file);
    title = frontMatter.fields.get("title") ?? manifestEntry?.title;
    declaredDescription = frontMatter.fields.get("description") ?? manifestEntry?.description;
    declaredPath = frontMatter.fields.has("path") ? frontMatter.fields.get("path") : manifestEntry?.path;
    markdown = frontMatter.markdown;
    fault = frontMatter.fault;
    pathCandidates = frontMatter.candidates.get("path") ?? [];
  } else {
    if (manifestEntry === undefined) {
      throw documentError(
        "pages.metadata_missing",
        `'${file}' is a raw ProseMirror document with no manifest entry, so its title and path are unknown. `
          + "Author it as Markdown with front-matter, or run 'taproot-site pull' first.",
        file,
      );
    }
    title = manifestEntry.title;
    declaredDescription = manifestEntry.description;
    declaredPath = manifestEntry.path;
  }

  const pagePath = normalizePagePath(declaredPath);
  if (pagePath === undefined) {
    // Not one resolved page, but not nothing either: a file declaring two
    // different paths is a candidate source for each of them, and a push that
    // touches one of those paths must not proceed as though this file were
    // absent. Anything that touches a claim fails closed on the fault below.
    const claims = [...new Set(pathCandidates.map((value) => normalizePagePath(value)))]
      .filter((value) => value !== undefined);
    if (claims.length > 0) return { file, pagePath: undefined, pathClaims: claims, fault };
    // Nothing readable said which page this is, so a deferred entry fault is
    // the real reason resolution failed and is reported in preference to a
    // generic "no path".
    if (fault !== undefined) throw fault;
    throw documentError(
      "pages.path_missing",
      `'${file}' does not declare a usable page path. `
        + "Add 'path:' to its front-matter (use an empty value for the home page).",
      file,
    );
  }
  // The server enforces `\A[A-Za-z0-9][A-Za-z0-9._-]*\z` on every segment
  // (`Validations.ValidatePagePath`). Checking it here is what keeps phase
  // one's promise: without it `path: Hello World` passes validation and fails
  // mid-phase-two, after earlier pages have already been created. Home ("")
  // has no segments and is always legal.
  if (pagePath !== "" && !pagePath.split("/").every((segment) => SAFE_SEGMENT.test(segment))) {
    throw documentError(
      "pages.path_unsupported",
      `'${file}' declares page path '${pagePath}', but Taproot requires every path segment to match `
        + "[A-Za-z0-9][A-Za-z0-9._-]* — start with a letter or digit, and use only letters, digits, "
        + "'.', '_', and '-'.",
      file,
    );
  }

  return {
    file,
    pagePath,
    title,
    declaredDescription,
    fault,
    pathClaims: [],
    sourceFormat: isMarkdown ? PAGE_SOURCE_FORMAT_MARKDOWN : PAGE_SOURCE_FORMAT_PROSEMIRROR,
    sourceHash: workspaceContentHash(bytes),
    markdown,
    text: source,
  };
}

/**
 * Refuses to overwrite a live page that moved since this workspace last
 * reconciled with it.
 *
 * TR00622 left one detection gap open deliberately: a remote edit made between
 * this workspace's own push and its next pull was adopted as the new baseline
 * rather than reported, because the bytes a push sends are not comparable with
 * the bytes a read returns and closing it needed a revision on the read
 * contract. This is that revision, so the gap closes here: the site states the
 * revision of each page's stored authoring state, the workspace records the one
 * it last wrote or pulled, and a push into a page carrying a different one is
 * refused before a single mutation is sent.
 *
 * The guard is armed by knowledge, not by policy. A page the workspace has
 * never reconciled with records no revision, and a Taproot that predates the
 * contract reports none; neither is evidence of a concurrent edit, and refusing
 * on absence would make the ordinary first push of a workspace impossible.
 * Both leave this exactly where TR00622 left it, which is where the caller
 * already is.
 */
function requireReconciledRevision({ file, pagePath, target, entry, observedRevision }) {
  // What the operator was shown by a refused pull outranks what the manifest
  // last reconciled with. Without that, this guard would also refuse the pull
  // conflict's own documented recovery, and the only way out of a conflict
  // would be to abandon the local source.
  const recorded = observedRevision ?? normalizePageBodyRevision(entry?.baseline?.revision);
  const live = target.bodyRevision;
  if (recorded === undefined || live === undefined || recorded === live) return;
  const selector = pagePath || "/";
  throw new SiteAuthoringError(
    "pages.push_conflict",
    `Page '${selector}' changed on the site since this workspace last reconciled with it: it now reports revision `
      + `${live}, and '${file}' was written against ${recorded}. No page was pushed. Run `
      + `'taproot-site pull' to see what differs and to adopt the site's version, or delete '${file}' and pull `
      + "again to take the site's document as this page's source.",
    { field: file, alternatives: [recorded, live] },
  );
}

/**
 * The metadata checks that are *not* part of deciding which page a source is.
 *
 * They are separate because a file that declares `path: about` is a source for
 * `about` whether or not it also declares a title, and the duplicate-source
 * rule has to see it either way. Folding this into path resolution let a
 * titleless second source drop out of a targeted push as "unresolved", so the
 * other `about` source was sent as though it were the only one — the guess
 * one source per page exists to refuse.
 */
export function requireCompletePageMetadata(source) {
  if (source.fault !== undefined) throw source.fault;
  requireText(source.title, "pages.title_missing", `'${source.file}' does not declare a title.`, source.file);
  return source;
}

/**
 * Turns one resolved page source into the canonical ProseMirror document the
 * wire carries — converting Markdown through the bounded subset and resolving
 * its media, or unwrapping an authored document.
 */
export async function convertWorkspacePageSource({ source, mediaManifest, content: injectedContent }) {
  const content = requireContentFunctions(await loadContentModule(injectedContent));
  const { file } = source;
  if (source.sourceFormat === PAGE_SOURCE_FORMAT_MARKDOWN) {
    const converted = await content.markdownToProseMirror(source.markdown, {
      resolveImage: makeResolveImage(mediaManifest, file),
    });
    return unwrapProseMirrorDocument(
      converted === null || typeof converted !== "object" ? undefined : converted.doc,
      file,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(source.text);
  } catch {
    throw documentError("pages.document_shape", `'${file}' is not valid JSON.`, file);
  }
  return unwrapProseMirrorDocument(parsed, file);
}

/**
 * Reads and converts one editable page source in a single step, for the
 * offline fixture validator.
 *
 * Live push no longer takes this path. It resolves every source's identity
 * first — `readWorkspacePageSource` for all of them, then one cross-file
 * duplicate-path pass — and converts only what it is going to send, so a
 * fixture's file-at-a-time walk and a push's selection no longer share an
 * error order. A fixture binds every page it declares and validates them all,
 * so the distinction costs it nothing.
 */
export async function validateWorkspacePageSource({
  workspaceDir,
  file,
  manifestEntry,
  mediaManifest,
  content: injectedContent,
}) {
  const source = requireCompletePageMetadata(await readWorkspacePageSource({ workspaceDir, file, manifestEntry }));
  return {
    ...source,
    document: await convertWorkspacePageSource({ source, mediaManifest, content: injectedContent }),
  };
}

/**
 * Validates a parsed page document through the same content and named-context
 * contracts used by live push. Offline fixtures invoke this directly after
 * parsing; live push invokes it at its historical point after identity checks.
 */
export async function validateWorkspacePageDocument({
  workspaceDir,
  siteId,
  file,
  document: document_,
  content: injectedContent,
  allowRawHtml = false,
  getSharedThemeContexts,
}) {
  const content = requireContentFunctions(await loadContentModule(injectedContent));
  assertValid(content, document_, file, allowRawHtml);
  if (hasNamedFreeFormSectionContext(document_)) {
    const contexts = typeof getSharedThemeContexts === "function"
      ? await getSharedThemeContexts()
      : await readSharedThemeContexts(workspaceDir, siteId);
    const contextErrors = validateFreeFormSectionContexts(document_, contexts).errors;
    if (contextErrors.length > 0) {
      const first = contextErrors[0];
      throw documentError(
        first.code,
        `'${file}' has an invalid section context at ${first.path}: ${first.message}`,
        `${file}:${first.path}`,
      );
    }
  }
}

export async function pagesPush(invocation) {
  const session = await openSession(invocation);
  const { client, config, siteId, onProgress } = session;
  // One advisory line before this verb does any work, and only when the
  // exchange said the platform is paused. It changes nothing else: the write
  // still runs and its refusal still classifies as platform_paused (TR00692).
  warnIfExternalWritesPaused(session, VERB_PAGES_PUSH);
  const allowRawHtml = invocation.allowRawHtml === true;
  // Both manifests are bound to the site before anything is planned or sent:
  // every id in them is site-scoped, and a workspace pulled from another site
  // reads as entirely valid until phase two is already writing.
  const manifest = await readManifest(config.workspaceDir, siteId);
  const mediaManifest = await readMediaManifest(config.workspaceDir, siteId);
  const content = requireContentFunctions(await loadContentModule(invocation.content));
  const requestedPaths = Array.isArray(invocation.pagePaths)
    ? new Set(invocation.pagePaths.map((value) => {
      const normalized = normalizePagePath(value);
      if (normalized === undefined) {
        throw new SiteAuthoringError(
          "pages.page_path_invalid",
          `'${typeof value === "string" ? value : String(value)}' is not a usable page path.`,
          { field: typeof value === "string" ? value : undefined, exitCode: 2 },
        );
      }
      return normalized;
    }))
    : undefined;
  // Manifest integrity is never scoped: a registry that contradicts itself
  // describes some other workspace, and a selection cannot make that safe.
  requireManifestSourceRegistry(pageSourceRegistry(manifest));
  const readOnlyProjections = readOnlySystem404Projections(manifest);
  const targeted = requestedPaths !== undefined;
  const readOnlyByFile = new Map(readOnlyProjections.map((entry) => [entry.file, entry]));
  const readOnlyByPath = new Map(readOnlyProjections.map((entry) => [normalizePagePath(entry.path), entry]));

  // Naming the projection in a selection is refused by name before anything is
  // read. It is the one page this workspace may never send, and a selection is
  // an explicit request rather than something to quietly drop.
  if (targeted) {
    const requestedReadOnly = readOnlyProjections.find((entry) =>
      requestedPaths.has(normalizePagePath(entry.path) ?? entry.path));
    if (requestedReadOnly !== undefined) {
      const pagePath = normalizePagePath(requestedReadOnly.path) ?? requestedReadOnly.path;
      throw new SiteAuthoringError(
        "pages.page_read_only",
        `Page path '${pagePath}' is the pulled read-only system 404 projection and cannot be pushed.`,
        { field: pagePath },
      );
    }
  }

  // The shared list, so the set `pull` refuses to write over is exactly the set
  // this walks: a file one counted and the other ignored would be a page pushed
  // from a workspace nothing proved the ownership of.
  const files = await walkWorkspaceFiles(config.workspaceDir, PAGES_DIRECTORY, PAGE_SOURCE_EXTENSIONS);
  const editableFiles = files.filter((file) => !readOnlyByFile.has(file));
  if (editableFiles.length === 0 && readOnlyProjections.length === 0) {
    throw new SiteAuthoringError(
      "pages.none_found",
      `No Markdown or ProseMirror page files were found under '${PAGES_DIRECTORY}/' in the workspace.`,
      { field: PAGES_DIRECTORY },
    );
  }
  // The projection's own integrity is a whole-workspace check. A targeted push
  // has already refused to name it and cannot reach it any other way, so an
  // edited projection is something `pages push` with no path reports — not
  // something that blocks a different page from being sent.
  const skippedReadOnly = [];
  if (!targeted) {
    for (const entry of readOnlyProjections) {
      if (!files.includes(entry.file)) {
        throw documentError(
          "pages.read_only_missing",
          `The pulled read-only system 404 projection '${entry.file}' is missing or was replaced. Run pull again; `
            + "author the system 404 through an owner-controlled surface.",
          entry.file,
        );
      }
      const bytes = await readWorkspaceFile(config.workspaceDir, entry.file, WORKSPACE_LIMITS.documentBytes);
      if (workspaceContentHash(bytes) !== entry.workspaceContentHash) {
        throw documentError(
          "pages.read_only_modified",
          `The pulled read-only system 404 projection '${entry.file}' changed after pull. No page was pushed. `
            + "Restore it or pull again; author the system 404 through an owner-controlled surface.",
          entry.file,
        );
      }
      skippedReadOnly.push({
        file: entry.file,
        path: normalizePagePath(entry.path),
        pageId: entry.pageId,
        reason: entry.readOnlyReason,
      });
      onProgress(`Verified read-only system 404 projection '${entry.file}'; it will not be pushed.`);
    }
  }
  let sharedThemeContexts;
  const manifestByFile = new Map(
    manifest.pages.filter((entry) => typeof entry?.file === "string").map((entry) => [entry.file, entry]),
  );
  // Keyed by identity as well as by file, because the two do not always agree.
  // `pull` writes a `.pm.json` and records it under that name; the documented
  // way to switch a page to Markdown is to delete it and author a `.md` beside
  // it — which leaves the page's manifest entry reachable by `pageId` and by
  // nothing else.
  const manifestByPageId = new Map(
    manifest.pages.filter((entry) => typeof entry?.pageId === "string").map((entry) => [entry.pageId, entry]),
  );

  return await withRefusalGuidance(onProgress, "push", async () => {
    onProgress("Listing the site's pages to resolve creates from updates.");
    const { pages: livePages, truncated } = await listSitePages(client, siteId, { onProgress });
    if (truncated) {
      // Every create-or-update decision below is made against this list. A
      // partial one turns a tracked page into a create, which the server then
      // refuses for a duplicate path — mid-phase-two, after earlier pages have
      // already been written.
      throw new SiteAuthoringError(
        "pages.live_list_truncated",
        "The site has more pages than this CLI can enumerate, so an update cannot be told from a create. "
          + "No page was pushed.",
        { field: PAGES_DIRECTORY },
      );
    }
    const live = livePages.filter((summary) => summary.status !== PAGE_STATUS_DELETED);
    const liveById = new Map(live.map((summary) => [summary.pageId, summary]));
    const liveByPath = new Map(live.map((summary) => [normalizePagePath(summary.path) ?? summary.path, summary]));
    // The projection's live identity is the other half of the whole-workspace
    // read-only check above, and is scoped with it for the same reason.
    if (!targeted) {
      for (const projection of readOnlyProjections) {
        const summary = liveById.get(projection.pageId);
        if (
          normalizePagePath(summary?.path)?.toLowerCase() !== SYSTEM_PAGE_NOT_FOUND_PATH
          || summary?.templateType !== TEMPLATE_TYPE_FREE_FORM
        ) {
          const index = manifest.pages.indexOf(projection);
          throw documentError(
            "workspace.manifest_invalid",
            `The read-only page projection at pages[${index}] does not identify the live free-form system 404. `
              + "No page was pushed; run 'taproot-site pull' again.",
            `pages[${index}].pageId`,
          );
        }
      }
    }

    // Resolution: which file is each page path's one authoritative source.
    // This reads metadata only — a manifest entry, or a front-matter block —
    // so no document is converted, no media reference is resolved, and no
    // component contract is checked until the selection is known.
    const sources = [];
    const claimants = [];
    const unresolved = [];
    for (const file of editableFiles) {
      const manifestEntry = manifestByFile.get(file);
      try {
        const source = await readWorkspacePageSource({ workspaceDir: config.workspaceDir, file, manifestEntry });
        if (source.pagePath === undefined) {
          // A file whose page identity is ambiguous. A whole-workspace push
          // reports every authored page, so it is a refusal there; a targeted
          // one refuses only if the selection touches a path it might be.
          if (!targeted) throw source.fault;
          claimants.push(source);
          continue;
        }
        sources.push(source);
      } catch (error) {
        // A source whose metadata cannot be read declares no page path, so it
        // cannot be the page a selection asked for. A whole-workspace push is
        // the command that reports it; a targeted one names it and carries on.
        // Anything that is not a metadata fault — a containment refusal, an
        // oversized file, an unreadable one — still fails closed.
        if (!targeted || !(error instanceof SiteAuthoringError) || !RESOLUTION_METADATA_CODES.has(error.code)) {
          throw error;
        }
        unresolved.push({ file, code: error.code });
        onProgress(`'${file}' declares no readable page path (${error.code}); it is outside this selection.`);
      }
    }

    // Two editable sources for one page path. Whichever push would touch that
    // path refuses: choosing between them is exactly the ambiguity one source
    // per page exists to remove, and it is also how the documented format
    // change — remove the old source, author the other beside it — is proved
    // to have actually removed the old one.
    const sourcesByPath = new Map();
    for (const source of sources) {
      const existing = sourcesByPath.get(source.pagePath);
      if (existing === undefined) {
        sourcesByPath.set(source.pagePath, source);
        continue;
      }
      if (!targeted || requestedPaths.has(source.pagePath)) {
        throw documentError(
          "pages.path_conflict",
          `'${source.file}' and '${existing.file}' both claim page path '${source.pagePath}'.`,
          source.pagePath,
        );
      }
      onProgress(
        `'${source.file}' and '${existing.file}' both claim page path '${source.pagePath}'; `
          + "neither is in this selection.",
      );
    }

    const selected = targeted ? sources.filter((source) => requestedPaths.has(source.pagePath)) : sources;
    if (targeted) {
      // Before deciding what the selection resolved to: a file that might be
      // one of the selected pages makes the selection unprovable, so its own
      // fault is what this push reports.
      const claimant = claimants.find((source) => source.pathClaims.some((claim) => requestedPaths.has(claim)));
      if (claimant !== undefined) throw claimant.fault;
    }
    if (targeted) {
      const matched = new Set(selected.map((source) => source.pagePath));
      const missing = [...requestedPaths].filter((pagePath) => !matched.has(pagePath)).sort();
      if (missing.length > 0) {
        // The homepage normalizes to the empty path, which the result emitters
        // drop as falsy; name it by its documented '/' spelling so the stable
        // error contract keeps a field for every unknown path.
        throw new SiteAuthoringError(
          "pages.page_not_found",
          `No workspace page was found for page path '${missing[0] || "/"}'.`,
          { field: missing[0] || "/" },
        );
      }
      onProgress(
        `Selected ${selected.length} of ${sources.length} page source(s) by path; `
          + "only the selection is validated and sent.",
      );
    } else {
      onProgress(`Validating every one of the ${sources.length} page source(s) in this workspace.`);
    }

    // Phase one: convert and validate the selection. No mutation is sent until
    // every document that will be sent has passed.
    const planned = [];
    for (const source of selected) {
      const { file, pagePath, title, declaredDescription } = source;
      onProgress(`Validating '${file}'.`);
      const manifestEntry = manifestByFile.get(file);
      requireCompletePageMetadata(source);
      const document_ = await convertWorkspacePageSource({ source, mediaManifest, content });
      if (readOnlyByPath.has(pagePath)) {
        throw documentError(
          "pages.system_page_read_only",
          `'${file}' attempts to replace the read-only system 404 projection. No page was pushed. `
            + "Run pull again; author the system 404 through an owner-controlled surface.",
          file,
        );
      }

      const target = manifestEntry?.pageId !== undefined
        ? liveById.get(manifestEntry.pageId)
        : liveByPath.get(pagePath);
      const workspaceSystemKind = systemPageKind(pagePath);
      if (target === undefined) {
        if (workspaceSystemKind !== undefined) {
          throw documentError(
            "pages.system_page_missing",
            `'${file}' claims the system ${workspaceSystemKind === "home" ? "home" : "404"} page, `
              + "which is seeded by Taproot and can only be updated. No such page exists on this site.",
            // The homepage's field carries its documented '/' spelling, the
            // same normalization every not-found in this package now uses.
            pagePath || "/",
          );
        }
      } else {
        const livePath = normalizePagePath(target.path) ?? target.path;
        if (systemPageKind(livePath) !== undefined && livePath !== pagePath) {
          throw documentError(
            "pages.system_path_immutable",
            `'${file}' would move the system ${systemPageKind(livePath) === "home" ? "home" : "404"} page `
              + `from '${livePath}' to '${pagePath}'. System page paths are immutable.`,
            file,
          );
        }
        if (target.templateType !== TEMPLATE_TYPE_FREE_FORM) {
          throw documentError(
            "pages.template_immutable",
            `'${file}' targets page '${livePath}', whose template type is ${target.templateType}. `
              + "A page's template type is immutable after creation.",
            file,
          );
        }
        // The record this push may spend has to be removable after the send:
        // a directory or a symlink at its path is refused here, before any
        // page is written, rather than discovered after the site has changed.
        const observedRecordFile = internalPageObservedRevisionFile(target.pageId);
        if (observedRecordFile !== undefined) await workspaceFileExists(config.workspaceDir, observedRecordFile);
        requireReconciledRevision({
          file,
          pagePath,
          target,
          entry: manifestByPageId.get(target.pageId),
          observedRevision: await readObservedPageRevision(config.workspaceDir, target.pageId),
        });
      }

      // The duplicate-source check above only catches two workspace files
      // fighting over one path. This catches the other half: a path some *live*
      // page already holds. Renaming onto it, or creating at it, is a duplicate
      // the server refuses — and without this it refuses mid-phase-two, after
      // earlier pages have been written. A page matching itself is the ordinary
      // update and is left alone.
      const holder = liveByPath.get(pagePath);
      if (holder !== undefined && holder.pageId !== target?.pageId) {
        throw documentError(
          "pages.path_taken",
          `'${file}' claims page path '${pagePath}', which page ${holder.pageId} already holds on this site. `
            + "Choose another path, or point this file at that page by pulling first.",
          file,
        );
      }

      // The file-keyed entry is gone whenever the file was renamed or replaced —
      // which is exactly what the pull, delete the `.pm.json`, author a `.md`
      // flow does. Falling back through the page's own identity keeps the
      // fields the workspace never restated; without it the whole-object
      // UpdatePage sends "" and false and silently clears both.
      const targetEntry = target === undefined ? undefined : manifestByPageId.get(target.pageId);
      const description = declaredDescription ?? targetEntry?.description ?? "";

      await validateWorkspacePageDocument({
        workspaceDir: config.workspaceDir,
        siteId,
        file,
        document: document_,
        content,
        allowRawHtml,
        getSharedThemeContexts: async () => {
          sharedThemeContexts ??= await readSharedThemeContexts(config.workspaceDir, siteId);
          return sharedThemeContexts;
        },
      });

      planned.push({
        file,
        pagePath,
        title,
        description: typeof description === "string" ? description : "",
        document: document_,
        sourceFormat: source.sourceFormat,
        sourceHash: source.sourceHash,
        pageId: target?.pageId,
        action: target === undefined ? "created" : "updated",
      });
    }

    // Phase two: send. The manifest is written back even if a later page fails,
    // so a retry updates the pages this run created rather than duplicating them.
    const applied = [];
    let manifestDirty = false;
    try {
      for (const page of planned) {
        onProgress(`${page.action === "created" ? "Creating" : "Updating"} '${page.pagePath}' from '${page.file}'.`);
        const template = freeFormTemplate(page.document);
        const summary = page.action === "created"
          ? await createPage(client, {
            siteId,
            path: page.pagePath,
            title: page.title,
            shortDescription: page.description,
            template,
          })
          : await updatePage(client, page.pageId, {
            pageId: page.pageId,
            path: page.pagePath,
            title: page.title,
            shortDescription: page.description,
            template,
          });
        manifestDirty = true;
        applied.push({
          file: page.file,
          path: summary.path,
          pageId: summary.pageId,
          action: page.action,
          status: summary.status,
        });
        // `entry?.` because a hand-edited manifest can hold a null in the list,
        // and a raw TypeError here would collapse to an opaque `site.failed`
        // *after* pages had already been created — the one place in this verb
        // where a crash costs more than a refusal.
        const existing = manifest.pages.find((entry) => entry?.pageId === summary.pageId);
        const record = existing ?? {};
        Object.assign(record, {
          pageId: summary.pageId,
          resourceId: summary.resourceId || record.resourceId || "",
          path: summary.path,
          title: page.title,
          description: page.description,
          status: summary.status,
          templateType: TEMPLATE_TYPE_FREE_FORM,
          hasDraft: summary.hasDraft,
          // The registry: this file, in this format, is now the page's one
          // authoritative source, whatever the entry said before. That is what
          // makes the documented format change — remove the old source, author
          // the other beside it — stick after a single push.
          file: page.file,
          sourceFormat: page.sourceFormat,
          // The page's remote body is now derived from exactly these bytes.
          // No remote *hash* is recorded: a read re-projects image delivery and
          // re-serializes component data, so a hash of what was sent is not
          // comparable with a hash of what a pull would read, and the next pull
          // establishes that half from what it actually reads.
          //
          // The revision is different in kind and is recorded here. It is the
          // site's own statement about the stored state this mutation just
          // wrote, so it is directly comparable with the revision the next read
          // reports — which is what lets the *next* push tell "nobody else
          // touched this page" from "someone did", without a pull in between.
          // Absent against a Taproot that predates the contract, and then
          // dropped rather than carried forward: this push moved the stored
          // state, so whatever was recorded describes a version that no longer
          // exists, and keeping it would refuse the *next* push over a change
          // this workspace made itself.
          baseline: {
            sourceHash: page.sourceHash,
            ...(summary.bodyRevision === undefined ? {} : { revision: summary.bodyRevision }),
          },
          pendingApproval: true,
        });
        if (existing === undefined) manifest.pages.push(record);
        // The override this page's record permitted has now been taken, and
        // the baseline above records what the site holds because of it.
        // Keeping the record would let a *later* push overwrite somebody
        // else's edit without anyone having been shown it. Removed after the
        // manifest record is written, so a failure here can never leave a
        // successful mutation unrecorded; the record's shape was checked
        // before anything was sent.
        const observedRevisionFile = internalPageObservedRevisionFile(summary.pageId);
        if (observedRevisionFile !== undefined) {
          await deleteWorkspaceFile(config.workspaceDir, observedRevisionFile);
        }
      }
    } finally {
      if (manifestDirty) await writeManifest(config.workspaceDir, manifest);
    }

    const reported = boundedList(applied, MAXIMUM_REPORTED);
    const reportedUnresolved = boundedList(unresolved, MAXIMUM_REPORTED);
    return successResult(VERB_PAGES_PUSH, siteId, {
      allowRawHtml,
      pages: {
        total: planned.length,
        created: applied.filter((entry) => entry.action === "created").length,
        updated: applied.filter((entry) => entry.action === "updated").length,
        skippedReadOnly: skippedReadOnly.length,
        readOnlyItems: skippedReadOnly,
        // What this run actually looked at, so automation can tell a targeted
        // push from a whole-workspace one without inferring it from counts.
        selection: targeted ? "targeted" : "workspace",
        ...(targeted ? { selectedPaths: [...requestedPaths].sort().map((pagePath) => pagePath || "/") } : {}),
        discovered: editableFiles.length,
        validated: planned.length,
        ...(unresolved.length > 0
          ? {
            unresolved: unresolved.length,
            unresolvedItems: reportedUnresolved.items,
            ...(reportedUnresolved.truncated ? { unresolvedItemsTruncated: true } : {}),
          }
          : {}),
        items: reported.items,
        ...(reported.truncated ? { itemsTruncated: true } : {}),
      },
      // `pages push` writes drafts. Nothing reaches an audience until `approve`
      // stages them and `deploy` publishes the site.
      nextStep: "approve",
    });
  });
}
