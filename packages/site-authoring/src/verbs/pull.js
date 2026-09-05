import {
  getNavigation,
  getPage,
  getSettingsGroup,
  getSiteRedirectMap,
  listSitePages,
  PAGE_STATUS_DELETED,
  PAGE_STATUS_DRAFT,
  PAGE_STATUS_UNKNOWN,
  TEMPLATE_TYPE_FREE_FORM,
  withRefusalGuidance,
} from "../api.js";
import { REFUSAL_CAPABILITY_MISSING, REFUSAL_UNCLASSIFIED, VERB_PULL } from "../constants.js";
import { sanitizeDiagnostic, SiteAuthoringError } from "../errors.js";
import { appearanceManifestEntry, footerManifestEntry } from "../footer-workspace.js";
import { describeJsonDifferences, reportableDifferencePaths } from "../json-path-diff.js";
import { projectRedirectMapForWorkspace, REDIRECTS_FILE_NAME } from "../redirects-contract.js";
import { redirectsManifestEntry } from "../redirects-workspace.js";
import { boundedList, openSession, successResult } from "../session.js";
import {
  projectSettingsGroup,
  SETTINGS_GROUPS,
  SETTINGS_TYPE_BRAND,
  SETTINGS_TYPE_SITE_HEADER,
  SETTINGS_TYPE_SITE_PUBLISHING_PREFERENCES,
  SETTINGS_TYPE_TAPROOT_STYLES,
} from "../settings-catalog.js";
import { ApiError } from "../transport.js";
import {
  canonicalDocumentHash,
  deleteWorkspaceFile,
  ensureWorkspaceRoot,
  inspectArtifactSiteBinding,
  inspectManifestSiteBinding,
  internalPageBaselineFile,
  internalPageObservedRevisionFile,
  MANIFEST_FILE_NAME,
  MANIFEST_VERSION,
  MEDIA_MANIFEST_FILE_NAME,
  NAVIGATION_FILE_NAME,
  normalizePageBodyRevision,
  normalizePagePath,
  PAGE_READ_ONLY_REASON_SYSTEM_404,
  PAGE_SOURCE_EXTENSIONS,
  PAGE_SOURCE_FORMAT_MARKDOWN,
  PAGE_WORKSPACE_MODE_EDITABLE,
  PAGE_WORKSPACE_MODE_METADATA_ONLY,
  PAGE_WORKSPACE_MODE_READ_ONLY,
  pageSourceFormat,
  pageSourceRegistry,
  PAGES_DIRECTORY,
  readObservedPageRecord,
  readWorkspaceFile,
  readWorkspaceJson,
  SETTINGS_DIRECTORY,
  SYSTEM_PAGE_NOT_FOUND_PATH,
  walkWorkspaceFiles,
  workspaceContentHash,
  workspaceFileExists,
  workspaceFileNameForPage,
  WORKSPACE_LIMITS,
  writeManifest,
  writeWorkspaceFile,
  writeWorkspaceJson,
} from "../workspace.js";

/**
 * `pull` — snapshot pages, navigation, and settings into the local workspace.
 *
 * The snapshot is what makes the push verbs safe. Without it, `pages push`
 * cannot tell a new page from an edit of an existing one, and `nav push` cannot
 * report what a whole-tree replace is about to remove. So `pull` writes a
 * manifest recording the `pageId`, `resourceId`, path, and status of every page
 * it saw, alongside the FREE_FORM bodies as `.pm.json` and the readable
 * settings groups as JSON.
 *
 * Everything is written beneath `config.workspaceDir`, which `loadSiteConfig`
 * has already proved resolves inside the configuration directory, and every
 * individual write is re-checked for containment. Server-supplied page paths
 * decide file *names* but never file *locations*: a path that is not plainly
 * safe — or that two pages would map to the same name — falls back to the page
 * id, and the manifest, not the file name, remains the authority on which page
 * a file is.
 *
 * **One source per page.** A page whose manifest entry already names a source
 * file that is still on disk keeps it. Pull refreshes remote state around that
 * file; it never mints a second editable one beside it. Writing
 * `pages/about.pm.json` next to an authored `pages/about.md` is what made the
 * safest agent loop — pull, edit, push one path — self-conflicting: the next
 * push saw two sources for one path and refused, every single pull.
 *
 * Markdown is deliberately one-way, so for a Markdown-tracked page the remote
 * body has nowhere in `pages/` to go. It is kept as internal state instead
 * (see `internalPageBaselineFile`), together with the hashes that let the next
 * pull tell an unchanged remote from one that moved underneath the author. A
 * remote body that changed cannot be expressed as Markdown at all, so pull
 * reports it as a conflict rather than pretending the workspace is current —
 * and reports it *before* writing anything under `pages/`, so a refused pull
 * leaves the workspace exactly as it found it.
 */

const MAXIMUM_REPORTED = 200;
// A settings group the credential's envelope does not reach is a narrower
// snapshot, not a failed pull. The server names that shortfall as a
// capability denial (TR00691), and an older server answers a bare 403; both
// mean the same thing here. Any other classified refusal — a rejected
// credential, the rollout switch, a plan ceiling — always propagates.
const UNAVAILABLE_SETTINGS_STATUSES = new Set([403, 404]);
const APPEARANCE_SETTINGS_TYPES = Object.freeze([
  SETTINGS_TYPE_TAPROOT_STYLES,
  SETTINGS_TYPE_BRAND,
  SETTINGS_TYPE_SITE_HEADER,
]);

function isSystemNotFound(pagePath) {
  return normalizePagePath(pagePath)?.toLowerCase() === SYSTEM_PAGE_NOT_FOUND_PATH;
}

/**
 * The refusal for a remote body this workspace cannot represent.
 *
 * It names both revisions and both ways out, because the alternative — pulling
 * anyway — is a workspace that quietly claims to be current and a next push
 * that reverts whatever the site gained. Every conflicted page is listed in
 * `alternatives` so an agent does not have to re-run the pull once per page.
 */
function pullConflict(conflicts) {
  const first = conflicts[0];
  const selector = first.pagePath || "/";
  const remaining = conflicts.length - 1;
  return new SiteAuthoringError(
    "pages.pull_conflict",
    `Page '${selector}' changed on the site${first.localChanged ? " and in this workspace" : ""} since the last `
      + `pull, and '${first.file}' cannot be rewritten from the site's document. Nothing under '${PAGES_DIRECTORY}/' `
      + `was changed, and the site's version is preserved at '${first.baselineFile}'. Either run `
      + `'taproot-site pages push ${selector}' to make the site match '${first.file}', or delete '${first.file}' `
      + `and pull again to adopt the site's version as this page's source.`
      + (remaining > 0 ? ` ${remaining} other tracked page(s) are in the same state.` : "")
      // Last, so the diagnostic bounds itself: the message is cut at
      // LIMITS.diagnosticScalars, and twenty long paths must never cut off the
      // recovery the refusal exists to state.
      + ` ${describeDifferenceSummary(first.differences)}`,
    { field: first.file, alternatives: conflicts.map((entry) => entry.file) },
    // Deliberately not `?? []`: an empty list is the claim "compared, and the
    // body is identical", which is what an agent reads as "look at the title,
    // path, or description instead". A comparison that could not be made at all
    // must leave the field absent rather than make that claim.
  ).withDifferences(reportableDifferencePaths(first.differences));
}

/**
 * One sentence naming what actually moved, for the conflict that reports it.
 *
 * "This page changed on the site" is true and useless: on the SHY production
 * home page the whole change was an image's `src` and `urls`, re-projected on
 * every read, and nothing in the refusal said so. The paths do not decide
 * anything — the revision already did — but they are what tells an operator
 * whether the site gained real content or merely a new signed URL.
 */
function describeDifferenceSummary(differences) {
  if (differences === undefined) {
    return "This workspace kept no copy of the site's previous version, so there is nothing to compare it against.";
  }
  if (differences.paths.length === 0) {
    return differences.truncated
      ? "The two documents were too large to compare completely; no difference was found in the part compared."
      : "The site's document is identical to the copy this workspace last reconciled with, so the change is in the "
        + "page's title, path, or description rather than its body.";
  }
  return `Differs at: ${differences.paths.join(", ")}${differences.truncated ? ", and more" : ""}.`;
}

/**
 * Whether a workspace file still holds exactly the site's document.
 *
 * Compared the way `remoteHash` is computed — canonically — and deliberately
 * not byte for byte. `FreeFormData.body` is a `google.protobuf.Struct`, so two
 * reads of an unchanged page may serialize their members in different orders;
 * a byte comparison would read that as an authored edit, and the *next* remote
 * change would then raise a conflict naming a local edit that never happened,
 * whose offered remedy is to push the untouched file over the real one.
 *
 * A file that cannot be parsed is certainly not what pull wrote, so it counts
 * as authored and is kept rather than refreshed over.
 */
function holdsRemoteDocument(sourceBytes, remoteHash) {
  try {
    return canonicalDocumentHash(JSON.parse(sourceBytes.toString("utf8"))) === remoteHash;
  } catch {
    return false;
  }
}

/** A page document, or `undefined` when the bytes are not one. */
function parsePageDocument(bytes) {
  try {
    const parsed = JSON.parse(bytes.toString("utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The document this workspace last reconciled with, if it still holds one.
 *
 * Two places can hold it. Internal state holds it for a page whose own source
 * could not be rewritten from the site's document — every Markdown-tracked
 * page, and any ProseMirror source carrying unpushed edits. For a ProseMirror
 * source pull last refreshed, the source file *is* what pull wrote, so it is
 * the previous version; but only while it has not been edited since, because
 * an edited file is a mixture of local and remote work and diffing it would
 * attribute the author's own changes to the site.
 *
 * Every failure is "nothing to compare against", the way
 * `readObservedPageRevision` treats damaged internal state. This read exists to
 * make a message more legible and decides nothing; pull writes the preserved
 * body pretty-printed and under no per-file cap of its own, so a body large
 * enough to trip `documentBytes` on the way back in is reachable — and a throw
 * there would replace the `pages.pull_conflict` the caller is raising (skipping
 * the observed-revision write that keeps the recovery push reachable), or fail
 * an ordinary non-conflicting refresh outright. The conflict is still raised,
 * and reports that this workspace kept no copy of the previous version.
 */
async function readPreviousRemoteDocument({ workspaceDir, baselineFile, sourceBytes, markdown, localChanged }) {
  try {
    if (await workspaceFileExists(workspaceDir, baselineFile)) {
      const bytes = await readWorkspaceFile(workspaceDir, baselineFile, WORKSPACE_LIMITS.documentBytes);
      const preserved = parsePageDocument(bytes);
      if (preserved !== undefined) return preserved;
    }
  } catch {
    return undefined;
  }
  if (markdown || localChanged) return undefined;
  return parsePageDocument(sourceBytes);
}

/** The JSON paths at which the site's document moved, when that is knowable. */
async function describeRemoteMovement({ workspaceDir, baselineFile, sourceBytes, markdown, localChanged, body }) {
  const previous = await readPreviousRemoteDocument({
    workspaceDir,
    baselineFile,
    sourceBytes,
    markdown,
    localChanged,
  });
  return previous === undefined ? undefined : describeJsonDifferences(previous, body);
}

function bodyStatusFor(summary) {
  if (summary.hasDraft) return PAGE_STATUS_DRAFT;
  if (summary.status !== PAGE_STATUS_UNKNOWN) return summary.status;
  throw new SiteAuthoringError(
    "api.page_status",
    `Taproot returned page '${summary.pageId}' without a readable status, so its body cannot be requested.`,
    { field: summary.pageId },
  );
}

/**
 * Assigns one workspace file to every free-form page, before a single byte is
 * written.
 *
 * A page that already has a tracked source keeps it, whatever format it is in.
 * That is the whole of the one-source rule as pull sees it, and it is settled
 * here rather than at write time so the names a pull is about to use are known
 * before any of them is claimed.
 *
 * For the rest, two different pages can prefer the same file name — the home
 * page (path `""`) and a page whose path is literally `index` both want
 * `pages/index.pm.json` — and a later write would silently clobber the earlier
 * one, leaving one page's body on disk under the other's name and only one of
 * the two reachable from `pages push`. So names are settled up front against a
 * claimed set, with each page's own `pages/<pageId>.pm.json` reserved as a
 * fallback nothing else may take. That guarantees a unique file per page,
 * because page ids are unique.
 *
 * The order is deliberate rather than the server's: the seeded home page claims
 * `index` first — its path is immutable, so it is the one name that can never
 * move — and everything else settles in page-id order. The same site therefore
 * produces the same file names on every pull, whatever order the listing
 * arrives in. The manifest remains the authority on which page a file is.
 */
function assignPageFiles(pages, tracked) {
  const reserved = new Set(pages.map((summary) => `${PAGES_DIRECTORY}/${summary.pageId}.pm.json`));
  const claimed = new Set();
  const assigned = new Map();
  for (const summary of pages) {
    const source = tracked.get(summary.pageId);
    if (source === undefined) continue;
    claimed.add(source.file);
    assigned.set(summary.pageId, source.file);
  }
  const homeFirst = [...pages].sort((left, right) => {
    const leftRank = normalizePagePath(left.path) === "" ? 0 : 1;
    const rightRank = normalizePagePath(right.path) === "" ? 0 : 1;
    if (leftRank !== rightRank) return leftRank - rightRank;
    if (left.pageId === right.pageId) return 0;
    return left.pageId < right.pageId ? -1 : 1;
  });
  for (const summary of homeFirst) {
    if (assigned.has(summary.pageId)) continue;
    const fallback = `${PAGES_DIRECTORY}/${summary.pageId}.pm.json`;
    const preferred = `${PAGES_DIRECTORY}/${workspaceFileNameForPage(summary.path, summary.pageId)}.pm.json`;
    const available = preferred === fallback || (!claimed.has(preferred) && !reserved.has(preferred));
    const file = available ? preferred : fallback;
    // The page-id fallback is unique by construction, so the only way it is
    // already taken is a tracked source that was renamed onto another page's
    // reserved name by hand. Guessing which page owns it is exactly the
    // ambiguity this task exists to remove.
    if (claimed.has(file)) {
      throw new SiteAuthoringError(
        "pages.source_conflict",
        `Page ${summary.pageId} has no free workspace file: '${file}' is already the tracked source of another `
          + "page. Rename or remove that file, then run 'taproot-site pull' again.",
        { field: file },
      );
    }
    claimed.add(file);
    assigned.set(summary.pageId, file);
  }
  return assigned;
}

/**
 * The manifest entries for pages whose tracked source is still on disk.
 *
 * A tracked file that is gone is not an error: removing it and authoring the
 * other format beside it is the documented way to change a page's source
 * format, and this is the half of that transition pull sees. The page falls
 * back to an ordinary pulled `.pm.json`, and `pages push` re-registers
 * whichever source actually claims the path.
 */
async function resolveTrackedSources(workspaceDir, pages, registry, onProgress) {
  const tracked = new Map();
  for (const summary of pages) {
    // The system 404 is never authored locally: pull owns its bytes and
    // records their hash, and every other verb refuses to send them back.
    // Tracking it would offer to keep local edits to a file whose whole
    // contract is that local edits are a refusal.
    if (isSystemNotFound(summary.path)) continue;
    const entry = registry.get(summary.pageId);
    if (entry === undefined) continue;
    // One file cannot be two pages' source. Keeping either entry would hash
    // and refresh one file against two unrelated baselines and let a later
    // push send it to whichever page the manifest lookup happened to resolve;
    // ignoring both sends each page back through the collision-safe naming
    // below, which is what rewrites the ambiguity out of the manifest.
    if (entry.duplicateSource || entry.duplicateIdentity) {
      // Only the manifest is rewritten here. These files are authored content,
      // so pull will not delete them — and one still carrying front matter for
      // an affected path becomes a second source for it the moment the
      // reassigned documents land beside it. The two ambiguities are opposite
      // relationships, so they get their own wording: naming a page's extra
      // sources as "the source of more than one page" would send the author
      // looking for the wrong thing.
      onProgress(
        entry.duplicateIdentity
          ? `Page ${summary.pageId} is recorded with more than one source (${entry.sourceFiles.join(", ")}); this `
            + "pull gives it a single fresh file instead. None of those files is tracked any more: delete the ones "
            + "you do not want, or the next push refuses with pages.path_conflict."
          : `'${entry.file}' is recorded as the source of more than one page; this pull assigns each of them its own `
            + `file instead. '${entry.file}' is no longer tracked: delete it, or the next push refuses with `
            + "pages.path_conflict.",
      );
      continue;
    }
    if (!await workspaceFileExists(workspaceDir, entry.file)) {
      onProgress(`Tracked source '${entry.file}' is gone; page '${summary.path}' will be pulled as a document.`);
      continue;
    }
    if (entry.baselineDiscarded) {
      onProgress(
        `The recorded baseline for '${entry.file}' is unreadable; this pull re-establishes it from the site.`,
      );
    }
    tracked.set(summary.pageId, entry);
  }
  return tracked;
}

/**
 * Reads the previous manifest's source registry, tolerating everything a
 * strict read would refuse.
 *
 * `pull` is the verb that repairs a workspace, so refusing here would strand
 * one. It is also the only verb that reads a manifest it is about to replace:
 * a version-4 manifest still records the `pageId → file` mapping this needs,
 * and honoring it is what repairs an existing workspace in one pull instead of
 * by hand. Every other verb keeps refusing an old manifest outright — the site
 * binding is checked before this runs, so a foreign manifest never reaches it.
 *
 * What it does *not* honor is a comparison recorded under the superseded
 * scheme; see `withoutSupersededRemoteHashes`.
 */
async function readSourceRegistry(workspaceDir, siteId) {
  if (!await workspaceFileExists(workspaceDir, MANIFEST_FILE_NAME)) return new Map();
  let parsed;
  try {
    parsed = await readWorkspaceJson(workspaceDir, MANIFEST_FILE_NAME, WORKSPACE_LIMITS.manifestBytes);
  } catch {
    return new Map();
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || parsed.siteId !== siteId) {
    return new Map();
  }
  const registry = pageSourceRegistry(parsed);
  return parsed.manifestVersion === MANIFEST_VERSION ? registry : withoutSupersededRemoteHashes(registry);
}

/**
 * Forgets `baseline.remoteHash` on every entry of a registry read out of a
 * manifest that is not this version's.
 *
 * The hash answers "did the site's projected body change", which is the
 * question version 6 stopped asking: the projection moves on its own, and the
 * SHY home page's clean deploy is what proved it. On the first pull after the
 * upgrade there is no recorded revision yet, so the comparison would fall back
 * to that hash — and for a Markdown page, which is always kept and therefore
 * always conflicts on a remote change, a projection that had moved in the
 * meantime would refuse the pull *and* write no manifest. The documented
 * recovery, `pages push`, reads the manifest strictly and refuses a superseded
 * `manifestVersion` telling the operator to pull again, so the two verbs would
 * send each other in a circle with no way out but deleting the source.
 *
 * Dropping the hash makes the migration pull establish the revision baseline
 * instead, which is what every later pull compares. `sourceHash` is kept: it
 * answers a question that has not changed — whether the author has edited a
 * pulled ProseMirror source since — and losing it would let this same pull
 * refresh the file over unpushed work.
 *
 * This discards state; it does not migrate any. An older manifest is still
 * fully replaced by the pull that reads it.
 */
function withoutSupersededRemoteHashes(registry) {
  for (const record of registry.values()) {
    const baseline = record.baseline;
    if (baseline?.remoteHash === undefined) continue;
    const kept = {
      ...(baseline.sourceHash === undefined ? {} : { sourceHash: baseline.sourceHash }),
      ...(baseline.revision === undefined ? {} : { revision: baseline.revision }),
    };
    record.baseline = Object.keys(kept).length === 0 ? undefined : kept;
  }
  return registry;
}

/**
 * The page read is the same response that supplies the body and the
 * revision, so its title and path are the ones that revision describes. The
 * listing's are one round trip older: a rename that landed in between would
 * otherwise be recorded beside the newer revision, and the next push would
 * send the old title or path against a revision that matches — reverting the
 * rename with no conflict to report (TR00643).
 */
function titleFromRead(page, summary) {
  // Stripped the way the listing's title is (`roundTrippedText` in api.js):
  // control and bidi characters are terminal and diff safety, not fidelity.
  return typeof page.title === "string" ? sanitizeDiagnostic(page.title, "") : summary.title;
}

function pathFromRead(page, summary) {
  const normalized = typeof page.path === "string" ? normalizePagePath(page.path) : undefined;
  return normalized === undefined ? summary.path : normalized;
}

function freeFormBody(page) {
  const template = page.template;
  if (template === null || typeof template !== "object") return undefined;
  const data = template.freeFormData;
  if (data === null || typeof data !== "object") return undefined;
  const body = data.body;
  return body !== null && typeof body === "object" && !Array.isArray(body) ? body : undefined;
}

function notThisSite(message, field) {
  // One code for one situation: "this workspace is not provably this site's."
  // The remedy is the same for every branch below — a fresh directory — and an
  // agent branching on the code should not have to match four identities for
  // one decision. The message carries which branch it was.
  return new SiteAuthoringError("workspace.manifest_site_mismatch", message, { field });
}

/**
 * Refuses to pull into a workspace that already holds another site's work, or
 * whose ownership cannot be established at all.
 *
 * The hazard is one specific transplant. `pull` rewrites the manifest but not
 * the page sources beside it, so a workspace carrying site A's pages that
 * accepts a pull for site B ends up with a B-bound manifest that agrees with
 * itself, A's `.pm.json` files sitting untracked next to it, and a `pages push`
 * that creates A's bodies as brand-new pages on B. Every branch here is that
 * same failure reached by a different route:
 *
 * - A manifest naming another site says so outright.
 * - A manifest naming no site predates site binding and cannot be cleared.
 * - A manifest too damaged to parse cannot be cleared either. It may predate
 *   the atomic workspace writer, or have been damaged by an external tool or
 *   manual edit while the page sources survived intact.
 * - No manifest at all is the same accident one step earlier. `pull` writes
 *   page bodies first and the manifest last, so an interrupted first pull
 *   leaves a full `pages/` directory and nothing that says whose it is.
 *
 * What stays permitted is the workspace that is genuinely new, and the one
 * `media upload` legitimately created before any pull — a media manifest bound
 * to *this* site, with no page sources, is a workspace this site already owns.
 */
async function requireWorkspaceBelongsToSite(workspaceDir, siteId) {
  const binding = await inspectManifestSiteBinding(workspaceDir);
  if (binding.state === "bound") {
    if (binding.siteId === siteId) return;
    throw notThisSite(
      `This workspace was pulled from site ${binding.siteId.slice(0, 64)} and still holds its files, but this `
        + `configuration targets site ${siteId}. Pull into a workspace of its own for this site.`,
      MANIFEST_FILE_NAME,
    );
  }
  if (binding.state === "unbound") {
    throw notThisSite(
      `'${MANIFEST_FILE_NAME}' predates site binding: it records no siteId, so the site whose files this `
        + "workspace already holds cannot be established. Pull into a fresh directory instead.",
      MANIFEST_FILE_NAME,
    );
  }
  if (binding.state === "unreadable") {
    throw notThisSite(
      `'${MANIFEST_FILE_NAME}' cannot be read, so the site whose files this workspace already holds cannot be `
        + "established — an interrupted write leaves exactly this, with the page sources intact. Pull into a "
        + "fresh directory instead.",
      MANIFEST_FILE_NAME,
    );
  }

  // No manifest. Permitted only if nothing here belongs to a site already.
  const pageSources = await walkWorkspaceFiles(workspaceDir, PAGES_DIRECTORY, PAGE_SOURCE_EXTENSIONS);
  if (pageSources.length > 0) {
    throw notThisSite(
      `This workspace holds ${pageSources.length} page source(s) under '${PAGES_DIRECTORY}/' but no `
        + `'${MANIFEST_FILE_NAME}', so the site they came from cannot be established — an interrupted pull `
        + "leaves exactly this. Pull into a fresh directory instead.",
      PAGES_DIRECTORY,
    );
  }
  // These three do carry a site, so they can clear themselves.
  for (const artifact of [NAVIGATION_FILE_NAME, MEDIA_MANIFEST_FILE_NAME, REDIRECTS_FILE_NAME]) {
    const artifactBinding = await inspectArtifactSiteBinding(workspaceDir, artifact);
    if (artifactBinding.state === "absent") continue;
    if (artifactBinding.state === "bound" && artifactBinding.siteId === siteId) continue;
    throw notThisSite(
      `This workspace has no '${MANIFEST_FILE_NAME}', and '${artifact}' ${
        artifactBinding.state === "bound"
          ? `belongs to site ${artifactBinding.siteId.slice(0, 64)}`
          : "does not record a readable site"
      }, so this workspace is not provably site ${siteId}'s. Pull into a fresh directory instead.`,
      artifact,
    );
  }
}

export async function pull(invocation) {
  const { client, config, siteId, now, onProgress } = await openSession(invocation);
  await ensureWorkspaceRoot(config);

  await requireWorkspaceBelongsToSite(config.workspaceDir, siteId);

  const registry = await readSourceRegistry(config.workspaceDir, siteId);

  return await withRefusalGuidance(onProgress, "pull", async () => {
    onProgress("Listing the site's pages.");
    const { pages, truncated } = await listSitePages(client, siteId, { onProgress });
    const live = pages.filter((summary) => summary.status !== PAGE_STATUS_DELETED);
    const freeForm = live.filter((summary) => summary.templateType === TEMPLATE_TYPE_FREE_FORM);
    const tracked = await resolveTrackedSources(config.workspaceDir, freeForm, registry, onProgress);
    const pageFiles = assignPageFiles(freeForm, tracked);

    // The redirect map, with the revision a later push is fenced by (TR00702).
    // Read here, before the first workspace write, for the same reason the
    // settings groups below are: a failure must strand nothing. A Taproot that
    // predates the map answers the route with 404; that pull then records no
    // redirect baseline, and `redirects push` asks for a pull against a site
    // that has one rather than guessing.
    onProgress("Reading the redirect map.");
    let redirectMap;
    try {
      redirectMap = await getSiteRedirectMap(client, siteId);
    } catch (error) {
      if (
        error instanceof ApiError
        && error.refusalKind() === REFUSAL_UNCLASSIFIED
        && error.httpStatus === 404
      ) {
        onProgress(
          `This Taproot does not serve a redirect map yet; ${REDIRECTS_FILE_NAME} is not written and the manifest `
            + "records no redirect baseline.",
        );
      } else {
        throw error;
      }
    }

    // Project every settings response before the first workspace write. Theme
    // decoding is a wire-contract check and can fail on malformed stored data;
    // discovering that after page bodies were written would strand an
    // unbound workspace that the next pull must refuse for safety.
    const pulledSettings = [];
    const skippedSettings = [];
    const settingsDocuments = [];
    let pulledFooter;
    const pulledAppearance = {};
    for (const group of SETTINGS_GROUPS) {
      onProgress(`Reading settings group ${group.settingsType}.`);
      let response;
      try {
        response = await getSettingsGroup(client, siteId, group.settingsType);
      } catch (error) {
        if (
          error instanceof ApiError
          && (error.refusalKind() === REFUSAL_UNCLASSIFIED
            || error.refusalKind() === REFUSAL_CAPABILITY_MISSING)
          && UNAVAILABLE_SETTINGS_STATUSES.has(error.httpStatus)
        ) {
          onProgress(`Settings group ${group.settingsType} is not readable by this credential; skipping it.`);
          skippedSettings.push(group.settingsType);
          continue;
        }
        throw error;
      }
      const file = `${SETTINGS_DIRECTORY}/${group.file}`;
      const projected = projectSettingsGroup(group, response);
      settingsDocuments.push({
        file,
        value: {
          settingsType: group.settingsType,
          entityId: siteId,
          settings: projected,
        },
      });
      if (group.settingsType === SETTINGS_TYPE_SITE_PUBLISHING_PREFERENCES) {
        pulledFooter = projected.footerSettings;
      }
      if (APPEARANCE_SETTINGS_TYPES.includes(group.settingsType)) {
        pulledAppearance[group.settingsType] = projected;
      }
      pulledSettings.push({ settingsType: group.settingsType, file });
    }

    // Phase one: the pages whose source this workspace already tracks. They are
    // the only ones a remote edit can collide with, and the collision has to be
    // reported before the ordinary pulled documents below are written — a
    // refused pull must leave `pages/` exactly as it found it.
    const trackedPlans = new Map();
    const conflicts = [];
    let bufferedBytes = 0;
    for (const summary of freeForm) {
      const source = tracked.get(summary.pageId);
      if (source === undefined) continue;
      onProgress(`Reading free-form page '${summary.path}'.`);
      const page = await getPage(client, summary.pageId, bodyStatusFor(summary));
      const body = freeFormBody(page);
      const description = typeof page.shortDescription === "string" ? page.shortDescription : "";
      if (body === undefined) {
        // The site's body is unreadable, but the workspace file is still this
        // page's one source. Dropping it from the registry would let the next
        // pull mint the competing document all over again.
        onProgress(`Page '${summary.path}' has no readable free-form body; keeping '${source.file}' as its source.`);
        trackedPlans.set(summary.pageId, {
          description,
          title: titleFromRead(page, summary),
          path: pathFromRead(page, summary),
          file: source.file,
          sourceFormat: source.sourceFormat,
        });
        continue;
      }
      const baselineFile = internalPageBaselineFile(summary.pageId);
      if (baselineFile === undefined) {
        // `requireIdentifier` already narrows a page id to `[\w-]+`, so this
        // needs an id starting with `_` or `-`. Refusing beats tracking a page
        // whose remote body has nowhere to be preserved.
        throw new SiteAuthoringError(
          "workspace.page_id_unsupported",
          `Taproot reported a page id for '${source.file}' that cannot name a workspace file, so this workspace `
            + "cannot record what it last reconciled with.",
          { field: source.file },
        );
      }
      const serialized = Buffer.from(`${JSON.stringify(body, undefined, 2)}\n`, "utf8");
      bufferedBytes += serialized.byteLength;
      if (bufferedBytes > WORKSPACE_LIMITS.pulledBodyBytes) {
        throw new SiteAuthoringError(
          "pages.pulled_bodies_too_large",
          `The tracked pages of this site exceed ${WORKSPACE_LIMITS.pulledBodyBytes} bytes, which is more than one `
            + "pull can hold before deciding whether any of them conflict.",
          { field: PAGES_DIRECTORY },
        );
      }
      const remoteHash = canonicalDocumentHash(body);
      const sourceBytes = await readWorkspaceFile(config.workspaceDir, source.file, WORKSPACE_LIMITS.documentBytes);
      const sourceHash = workspaceContentHash(sourceBytes);
      const revision = normalizePageBodyRevision(page.bodyRevision);
      // The revision is the site's own statement about its stored state, so it
      // moves for a real edit to the body, title, path, or description and for
      // nothing else. The body hash cannot make that distinction: every read
      // re-projects image delivery and re-serializes component data, so a
      // signer rotation or a changed image reads as an edit — which is exactly
      // what refused the SHY home page's pull after a clean deploy. So the
      // hash is consulted only where there is no revision to compare: a
      // Taproot that predates the revision contract, where it is still strictly
      // better than assuming nothing moved.
      //
      // A site that *now* reports a revision establishes the revision baseline
      // instead of comparing a superseded hash, even when the manifest recorded
      // one. That manifest is this version's — `withoutSupersededRemoteHashes`
      // never touched it — but its hash was recorded against a Taproot that had
      // no revision to give, so it is the same superseded projected-body hash,
      // and honoring it would refuse forever every Markdown page whose image
      // projection moved across the API deploy. This costs one pull's detection
      // at the upgrade boundary, the same trade `withoutSupersededRemoteHashes`
      // accepts.
      const remoteChanged = revision !== undefined
        ? source.baseline?.revision !== undefined && source.baseline.revision !== revision
        : source.baseline?.remoteHash !== undefined && source.baseline.remoteHash !== remoteHash;
      // Markdown is one-way, so a Markdown source can never be rewritten from
      // the site's document and is always kept. A ProseMirror source can be
      // refreshed — but only over content the author has not edited since the
      // last pull, because that edit is work no push has sent yet.
      const markdown = source.sourceFormat === PAGE_SOURCE_FORMAT_MARKDOWN;
      // With no recorded hash to compare against, "unchanged" is not a safe
      // default for a ProseMirror source: it schedules a refresh straight over
      // whatever the file actually holds, and three states reach here — a
      // version-4 manifest, a baseline too damaged to read, and an entry kept
      // while the site's body was unreadable — in all of which an authored
      // edit would be invisible. The bytes settle it instead, because a pulled
      // ProseMirror source is exactly what pull wrote: one that still matches
      // the site's document was not edited, and one that does not must be
      // assumed to hold work, keeping its hash unknown so every later pull
      // decides the same way rather than drifting to "unchanged".
      //
      // A Markdown source has no such relationship to the site's document —
      // the formats differ, so the bytes never match — and pull never writes
      // one at all. There is nothing to protect and nothing to compare, so an
      // unrecorded hash simply establishes itself.
      const localKnown = source.baseline?.sourceHash !== undefined;
      const localChanged = localKnown
        ? source.baseline.sourceHash !== sourceHash
        : !markdown && !holdsRemoteDocument(sourceBytes, remoteHash);
      const keepLocal = markdown || localChanged;
      const conflicted = markdown ? remoteChanged : localChanged && remoteChanged;
      trackedPlans.set(summary.pageId, {
        description,
        title: titleFromRead(page, summary),
        path: pathFromRead(page, summary),
        file: source.file,
        sourceFormat: source.sourceFormat,
        // `sourceHash` records the source as of the last time it *agreed* with
        // the remote body recorded beside it — not merely what it looked like
        // on the most recent pull. The difference is the whole protection:
        // advancing it for an edit no push has sent would make the next pull
        // read that edit as already reconciled, find nothing diverged, and
        // refresh the file straight over it. So a kept-because-diverged source
        // carries its previous hash forward until a push records a new one or
        // a remote change turns the divergence into a conflict.
        baseline: keepLocal
          // The revision records what this workspace has reconciled with, and
          // a conflicted page reconciles with nothing: this manifest is never
          // written, because the refusal below is raised before it is. That is
          // what keeps the same conflict coming back until somebody resolves
          // it, rather than the site's new version being adopted by a pull
          // that refused to adopt it.
          ? {
            remoteHash,
            sourceHash: localChanged ? source.baseline?.sourceHash : sourceHash,
            ...(revision === undefined ? {} : { revision }),
          }
          : {
            remoteHash,
            sourceHash: workspaceContentHash(serialized),
            ...(revision === undefined ? {} : { revision }),
          },
        ...(keepLocal ? { baselineBody: serialized, baselineFile } : { refresh: serialized, baselineFile }),
      });
      if (remoteChanged) {
        // A refusal for this same version already worked this out, against a
        // baseline it then overwrote with the very version being compared.
        // Recomputing now would compare that version with itself, find nothing,
        // and report "the change is in the page's title, path, or description"
        // for what was a body edit. So a record naming exactly this version is
        // authoritative about what the operator was last shown — including its
        // having been unable to tell — and a page that has moved *again* names
        // a different one and is compared afresh, against the version that
        // refusal preserved.
        //
        // "This version" is the revision where the site reports one, and the
        // canonical body hash where it does not. Against a Taproot that
        // predates the revision contract — which the published CLI meets
        // whenever it runs ahead of the deployed API — the hash is the whole of
        // what the fallback comparison above is made against, so it is equally
        // the thing a record has to name.
        const observed = await readObservedPageRecord(config.workspaceDir, summary.pageId);
        const alreadyShown = observed !== undefined
          && (revision === undefined
            ? observed.revision === undefined && observed.remoteHash === remoteHash
            : observed.revision === revision);
        // Computed here, while both documents are in hand and before the
        // preserved baseline below is overwritten with the new one — after
        // that write the previous version is gone and nothing could say what
        // moved.
        const differences = alreadyShown
          ? observed.differences
          : await describeRemoteMovement({
            workspaceDir: config.workspaceDir,
            baselineFile,
            sourceBytes,
            markdown,
            localChanged,
            body,
          });
        // Sanitized as one message: the page path is server data and the paths
        // are drawn from an untrusted document, and the same strings reach
        // `error.differences` de-fanged. A progress line is the one place they
        // would otherwise reach a terminal raw.
        onProgress(
          sanitizeDiagnostic(`Page '${summary.path}' moved on the site. ${describeDifferenceSummary(differences)}`),
        );
        if (conflicted) {
          conflicts.push({
            pageId: summary.pageId,
            pagePath: normalizePagePath(summary.path) ?? summary.path,
            file: source.file,
            baselineFile,
            localChanged,
            differences,
            observedRevision: revision,
            observedRemoteHash: remoteHash,
            observedRevisionFile: internalPageObservedRevisionFile(summary.pageId),
          });
        }
      } else if (keepLocal && localChanged) {
        // Two different situations, and saying "kept your edits" for both
        // would be a guess dressed as a fact: with a recorded hash the
        // divergence is measured, without one it is only that the file and the
        // site's document disagree — which an edit and a since-moved remote
        // produce alike.
        onProgress(
          localKnown
            ? `Kept the local edits in '${source.file}'; the site's copy of this page has not moved.`
            : `'${source.file}' does not match the site's document, and this workspace has no record of what it last `
              + "reconciled with, so it is kept as authored. Push it, or delete it and pull again, to settle which "
              + "one wins.",
        );
      }
    }

    // Internal state, written before the refusal below on purpose: it is what
    // makes "the site's version is preserved at ..." true. Nothing here is a
    // page source, and rewriting it is idempotent.
    for (const plan of trackedPlans.values()) {
      if (plan.baselineBody === undefined) continue;
      await writeWorkspaceFile(config.workspaceDir, plan.baselineFile, plan.baselineBody);
    }
    if (conflicts.length > 0) {
      // Recorded beside the preserved body, and only for a page this pull is
      // about to refuse. It says "the operator has been shown this version",
      // which is what keeps the refusal's own recovery — push the local source
      // to make the site match it — reachable without weakening the push
      // refusal for a page that moved while nobody was looking.
      //
      // The differences ride along because the write above has just replaced
      // the only copy they could be computed from. Without them the second
      // refusal for an unchanged version would carry no `differences` at all
      // and claim the change was not in the body.
      //
      // Written for every conflict, not only for a site that reports a
      // revision. A site that does not is compared by body hash, and skipping
      // the record there left the second refusal recomputing against the copy
      // the first one overwrote — finding no difference, and reporting a body
      // edit as a metadata change every time.
      for (const conflict of conflicts) {
        if (conflict.observedRevisionFile === undefined) continue;
        await writeWorkspaceJson(config.workspaceDir, conflict.observedRevisionFile, {
          pageId: conflict.pageId,
          ...(conflict.observedRevision === undefined
            ? { remoteHash: conflict.observedRemoteHash }
            : { revision: conflict.observedRevision }),
          ...(conflict.differences === undefined ? {} : { differences: conflict.differences }),
        });
      }
      throw pullConflict(conflicts);
    }

    // Phase two: everything else, plus the tracked refreshes cleared above.
    const manifestPages = [];
    let bodies = 0;
    for (const summary of live) {
      const entry = {
        pageId: summary.pageId,
        resourceId: summary.resourceId,
        path: summary.path,
        title: summary.title,
        status: summary.status,
        templateType: summary.templateType,
        hasDraft: summary.hasDraft,
        isGenerated: summary.isGenerated,
        workspaceMode: PAGE_WORKSPACE_MODE_METADATA_ONLY,
      };
      if (summary.templateType === TEMPLATE_TYPE_FREE_FORM) {
        // This pull is reconciling the page, so the manifest below carries the
        // newer and stronger claim and the "what the operator was shown" record
        // is spent. Leaving it would let a push override a remote change this
        // workspace has since caught up with.
        const observedRevisionFile = internalPageObservedRevisionFile(summary.pageId);
        if (observedRevisionFile !== undefined) {
          await deleteWorkspaceFile(config.workspaceDir, observedRevisionFile);
        }
        const plan = trackedPlans.get(summary.pageId);
        if (plan !== undefined) {
          entry.description = plan.description;
          if (plan.title !== undefined) entry.title = plan.title;
          if (plan.path !== undefined) entry.path = plan.path;
          if (plan.file !== undefined) {
            entry.file = plan.file;
            entry.sourceFormat = plan.sourceFormat;
            entry.workspaceMode = PAGE_WORKSPACE_MODE_EDITABLE;
            // Absent when the site had no readable body to compare against;
            // the next pull that reads one establishes it.
            if (plan.baseline !== undefined) entry.baseline = plan.baseline;
            if (plan.refresh !== undefined) {
              await writeWorkspaceFile(config.workspaceDir, entry.file, plan.refresh);
              bodies += 1;
              // The page's own source now holds the site's document, so a
              // second copy of it under internal state is stale by
              // construction.
              await deleteWorkspaceFile(config.workspaceDir, plan.baselineFile);
            }
          }
          manifestPages.push(entry);
          continue;
        }
        onProgress(`Reading free-form page '${summary.path}'.`);
        const page = await getPage(client, summary.pageId, bodyStatusFor(summary));
        const body = freeFormBody(page);
        entry.description = typeof page.shortDescription === "string" ? page.shortDescription : "";
        entry.title = titleFromRead(page, summary);
        entry.path = pathFromRead(page, summary);
        if (body === undefined) {
          // The server accepts and stores a body it never validates, so an
          // unreadable one is a real state. It is reported rather than written
          // as an empty document that a later push would send back.
          onProgress(`Page '${summary.path}' has no readable free-form body; snapshotting metadata only.`);
        } else {
          entry.file = pageFiles.get(summary.pageId);
          const source = Buffer.from(`${JSON.stringify(body, undefined, 2)}\n`, "utf8");
          if (isSystemNotFound(summary.path)) {
            entry.workspaceMode = PAGE_WORKSPACE_MODE_READ_ONLY;
            entry.readOnlyReason = PAGE_READ_ONLY_REASON_SYSTEM_404;
            entry.workspaceContentHash = workspaceContentHash(source);
            onProgress(
              `Page '${summary.path}' is the system 404; writing an integrity-checked read-only projection.`,
            );
          } else {
            entry.workspaceMode = PAGE_WORKSPACE_MODE_EDITABLE;
            entry.sourceFormat = pageSourceFormat(entry.file);
            const revision = normalizePageBodyRevision(page.bodyRevision);
            entry.baseline = {
              remoteHash: canonicalDocumentHash(body),
              sourceHash: workspaceContentHash(source),
              ...(revision === undefined ? {} : { revision }),
            };
          }
          await writeWorkspaceFile(config.workspaceDir, entry.file, source);
          bodies += 1;
          const baselineFile = internalPageBaselineFile(summary.pageId);
          if (baselineFile !== undefined) await deleteWorkspaceFile(config.workspaceDir, baselineFile);
        }
      }
      manifestPages.push(entry);
    }

    onProgress("Reading the navigation tree.");
    const navItems = await getNavigation(client, siteId);
    await writeWorkspaceJson(config.workspaceDir, NAVIGATION_FILE_NAME, { siteId, navItems });

    if (redirectMap !== undefined) {
      await writeWorkspaceJson(
        config.workspaceDir,
        REDIRECTS_FILE_NAME,
        projectRedirectMapForWorkspace(siteId, redirectMap),
      );
    }

    for (const document of settingsDocuments) {
      await writeWorkspaceJson(config.workspaceDir, document.file, document.value);
    }

    const manifest = {
      manifestVersion: MANIFEST_VERSION,
      siteId,
      pulledAt: new Date(now()).toISOString(),
      pagesTruncated: truncated,
      navigation: { file: NAVIGATION_FILE_NAME, items: navItems.length },
      ...(redirectMap === undefined ? {} : { redirects: redirectsManifestEntry(redirectMap) }),
      settings: pulledSettings,
      settingsSkipped: skippedSettings,
      ...(pulledFooter === undefined ? {} : { footer: footerManifestEntry(pulledFooter) }),
      ...(
        APPEARANCE_SETTINGS_TYPES.every((settingsType) => pulledAppearance[settingsType] !== undefined)
          ? { appearance: appearanceManifestEntry(pulledAppearance) }
          : {}
      ),
      pages: manifestPages,
    };
    await writeManifest(config.workspaceDir, manifest);
    onProgress(`Wrote ${MANIFEST_FILE_NAME} describing ${manifestPages.length} pages.`);
    if (truncated) {
      onProgress("The page list was bounded before the site was fully enumerated; the manifest is partial.");
    }

    const reported = boundedList(
      manifestPages.map((entry) => ({
        pageId: entry.pageId,
        path: entry.path,
        status: entry.status,
        templateType: entry.templateType,
        file: entry.file,
        sourceFormat: entry.sourceFormat,
        workspaceMode: entry.workspaceMode,
      })),
      MAXIMUM_REPORTED,
    );
    return successResult(VERB_PULL, siteId, {
      manifestFile: MANIFEST_FILE_NAME,
      pages: {
        total: manifestPages.length,
        bodies,
        // How many pages kept a source this workspace already had, rather than
        // receiving a freshly written one. A caller that expected an authored
        // Markdown page to survive the pull can assert on it.
        tracked: tracked.size,
        readOnly: manifestPages.filter((entry) => entry.workspaceMode === PAGE_WORKSPACE_MODE_READ_ONLY).length,
        truncated,
        items: reported.items,
        ...(reported.truncated ? { itemsTruncated: true } : {}),
      },
      navigation: { file: NAVIGATION_FILE_NAME, items: navItems.length },
      // Absent, not zeroed, when the site served no map: an agent reading
      // `entries: 0` would take the site for one with no redirects.
      ...(redirectMap === undefined ? {} : {
        redirects: {
          file: REDIRECTS_FILE_NAME,
          revision: redirectMap.revision,
          entries: redirectMap.entries.length,
        },
      }),
      settings: {
        pulled: pulledSettings.map((entry) => entry.settingsType),
        skipped: skippedSettings,
        files: pulledSettings.map((entry) => entry.file),
      },
    });
  });
}
