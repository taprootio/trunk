import {
  listSitePages,
  PAGE_STATUS_DELETED,
  publishDrafts,
  TEMPLATE_TYPE_FREE_FORM,
  withRefusalGuidance,
} from "../api.js";
import { VERB_APPROVE } from "../constants.js";
import { SiteAuthoringError } from "../errors.js";
import { boundedList, openSession, successResult, warnIfExternalWritesPaused } from "../session.js";
import {
  normalizePagePath,
  readManifest,
  readOnlySystem404Projections,
  SYSTEM_PAGE_NOT_FOUND_PATH,
  writeManifest,
} from "../workspace.js";

/**
 * `approve` — publish the site's drafts.
 *
 * `PublishDrafts` *stages*: it moves a page's draft into the approved candidate
 * pool. Nothing reaches an audience until `deploy` runs, and this verb says so
 * rather than letting an agent read "publish" as "live".
 *
 * The selection is the workspace's own: pages that the manifest knows about and
 * that Taproot currently reports as carrying a draft. Restricting to the
 * manifest is deliberate — a site can have drafts an owner is still working on
 * in the browser, and an agent's approve step must not sweep those into the
 * next deployment.
 */

const MAXIMUM_REPORTED = 200;
// `PublishDrafts` resolves the credential from the first page id in the batch,
// so batches stay one-site and bounded rather than unbounded and clever.
const MAXIMUM_BATCH = 100;

export async function approve(invocation) {
  const session = await openSession(invocation);
  const { client, config, siteId, onProgress } = session;
  // One advisory line before this verb does any work, and only when the
  // exchange said the platform is paused. It changes nothing else: the write
  // still runs and its refusal still classifies as platform_paused (TR00692).
  warnIfExternalWritesPaused(session, VERB_APPROVE);
  const manifest = await readManifest(config.workspaceDir, siteId);
  const manifestByPageId = new Map(
    manifest.pages.filter((entry) => typeof entry?.pageId === "string").map((entry) => [entry.pageId, entry]),
  );
  const readOnlyProjections = readOnlySystem404Projections(manifest);

  // Positional arguments narrow the selection to those page paths; `cli.js`
  // hands them over as `pagePaths`, and a programmatic caller can supply the
  // same key directly. With none, every draft the manifest tracks is staged.
  //
  // A path this CLI cannot use is refused by name rather than dropped. Dropping
  // it silently is the worst available outcome: the remaining selection would
  // narrow — possibly to nothing — and the verb would exit 0 reporting the work
  // done, telling an agent that asked to stage a page that it had been staged.
  const requestedPaths = Array.isArray(invocation.pagePaths)
    ? new Set(invocation.pagePaths.map((value) => {
      const normalized = normalizePagePath(value);
      if (normalized === undefined) {
        throw new SiteAuthoringError(
          "approve.page_path_invalid",
          `'${typeof value === "string" ? value : String(value)}' is not a usable page path. `
            + "Use the path as 'pull' records it in the manifest — no '.', '..', empty, or backslash segments.",
          { field: typeof value === "string" ? value : undefined, exitCode: 2 },
        );
      }
      return normalized;
    }))
    : undefined;

  return await withRefusalGuidance(onProgress, "approve", async () => {
    onProgress("Listing the site's pages to find approvable drafts.");
    const { pages, truncated } = await listSitePages(client, siteId, { onProgress });
    if (truncated) {
      // The selection *is* this list. A partial one stages a subset and then
      // reports success, which reads as "everything is approved".
      throw new SiteAuthoringError(
        "approve.live_list_truncated",
        "The site has more pages than this CLI can enumerate, so the drafts to approve cannot be determined. "
          + "Nothing was approved.",
        { field: "pages" },
      );
    }
    const pagesById = new Map(pages.map((summary) => [summary.pageId, summary]));
    for (const projection of readOnlyProjections) {
      const summary = pagesById.get(projection.pageId);
      if (
        summary?.status === PAGE_STATUS_DELETED
        || normalizePagePath(summary?.path)?.toLowerCase() !== SYSTEM_PAGE_NOT_FOUND_PATH
        || summary?.templateType !== TEMPLATE_TYPE_FREE_FORM
      ) {
        const index = manifest.pages.indexOf(projection);
        throw new SiteAuthoringError(
          "workspace.manifest_invalid",
          `The read-only page projection at pages[${index}] does not identify the live free-form system 404. `
            + "Nothing was approved; run 'taproot-site pull' again.",
          { field: `pages[${index}].pageId` },
        );
      }
    }
    const readOnlyPageIds = new Set(readOnlyProjections.map((entry) => entry.pageId));
    if (requestedPaths !== undefined) {
      const requestedReadOnly = readOnlyProjections.find((entry) =>
        requestedPaths.has(normalizePagePath(entry.path) ?? entry.path));
      if (requestedReadOnly !== undefined) {
        const pagePath = normalizePagePath(requestedReadOnly.path) ?? requestedReadOnly.path;
        throw new SiteAuthoringError(
          "approve.page_read_only",
          `Page path '${pagePath}' is the pulled read-only system 404 projection and cannot be approved.`,
          { field: pagePath },
        );
      }
    }
    const candidates = pages.filter((summary) =>
      summary.status !== PAGE_STATUS_DELETED
      && summary.hasDraft
      && manifestByPageId.has(summary.pageId)
      && !readOnlyPageIds.has(summary.pageId)
      && (requestedPaths === undefined || requestedPaths.has(normalizePagePath(summary.path) ?? summary.path)));

    if (requestedPaths !== undefined) {
      const matched = new Set(candidates.map((summary) => normalizePagePath(summary.path) ?? summary.path));
      const missing = [...requestedPaths].filter((value) => !matched.has(value)).sort();
      if (missing.length > 0) {
        // The homepage normalizes to the empty path, which the result
        // emitters drop as falsy; name it by its documented '/' spelling so
        // the stable error contract keeps a field for every unknown path.
        throw new SiteAuthoringError(
          "approve.page_not_found",
          `No approvable draft was found for page path '${missing[0] || "/"}'.`,
          { field: missing[0] || "/" },
        );
      }
    }

    if (candidates.length === 0) {
      onProgress("No page in this workspace is carrying a draft; there is nothing to approve.");
      return successResult(VERB_APPROVE, siteId, {
        approved: { total: 0, items: [] },
        stagedNotDeployed: true,
        nextStep: "deploy --staging",
      });
    }

    const approved = [];
    let manifestDirty = false;
    try {
      for (let offset = 0; offset < candidates.length; offset += MAXIMUM_BATCH) {
        const batch = candidates.slice(offset, offset + MAXIMUM_BATCH);
        onProgress(`Approving ${batch.length} draft page(s).`);
        const summaries = await publishDrafts(client, batch.map((summary) => summary.pageId));
        manifestDirty = true;
        for (const summary of summaries) {
          approved.push({ pageId: summary.pageId, path: summary.path, status: summary.status });
          const entry = manifestByPageId.get(summary.pageId);
          if (entry !== undefined) {
            entry.status = summary.status;
            entry.hasDraft = summary.hasDraft;
            entry.pendingApproval = false;
          }
        }
      }
    } finally {
      if (manifestDirty) await writeManifest(config.workspaceDir, manifest);
    }

    const reported = boundedList(approved, MAXIMUM_REPORTED);
    onProgress(`Approved ${approved.length} page(s). Nothing is published until 'taproot-site deploy' runs.`);
    return successResult(VERB_APPROVE, siteId, {
      approved: {
        total: approved.length,
        items: reported.items,
        ...(reported.truncated ? { itemsTruncated: true } : {}),
      },
      // Said explicitly so a caller cannot read "approve" as "live".
      stagedNotDeployed: true,
      nextStep: "deploy --staging",
    });
  });
}
