import {
  listSitePages,
  PAGE_STATUS_APPROVED,
  PAGE_STATUS_DELETED,
  publishDrafts,
  withRefusalGuidance,
} from "../api.js";
import { VERB_APPROVE } from "../constants.js";
import { SiteAuthoringError } from "../errors.js";
import { boundedByBytes, boundedList, openSession, successResult, warnIfExternalWritesPaused } from "../session.js";
import { displayPagePath, normalizePagePath, readManifest, writeManifest } from "../workspace.js";

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
// Room for the unknown-path list inside the 64 KiB result, beside the envelope.
const ALTERNATIVES_BYTES = 16 * 1024;
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
    const pathOf = (summary) => normalizePagePath(summary.path) ?? summary.path;
    const candidates = pages.filter((summary) =>
      summary.status !== PAGE_STATUS_DELETED
      && summary.hasDraft
      && manifestByPageId.has(summary.pageId)
      && (requestedPaths === undefined || requestedPaths.has(pathOf(summary))));

    // A requested page with nothing to approve is reported, not refused, so
    // one already-approved path does not stop the rest of the batch. A path
    // that names no page this workspace tracks is still refused by name.
    const skipped = [];
    if (requestedPaths !== undefined) {
      const matched = new Set(candidates.map(pathOf));
      const unknown = [];
      for (const requested of [...requestedPaths].filter((value) => !matched.has(value)).sort()) {
        const summary = pages.find((page) => page.status !== PAGE_STATUS_DELETED && pathOf(page) === requested);
        if (summary === undefined || !manifestByPageId.has(summary.pageId)) {
          unknown.push(displayPagePath(requested));
          continue;
        }
        skipped.push({
          pageId: summary.pageId,
          path: displayPagePath(requested),
          status: summary.status,
          reason: summary.status === PAGE_STATUS_APPROVED ? "already_approved" : "no_pending_draft",
        });
      }
      if (unknown.length > 0) {
        // Every path is named on progress, since the message and the
        // alternatives list are both bounded.
        for (const value of unknown) onProgress(`No page this workspace tracks is at '${value}'.`);
        const shown = unknown.slice(0, 5).map((value) => `'${value}'`).join(", ");
        const listed = boundedByBytes(unknown.slice(0, 100), ALTERNATIVES_BYTES).items;
        throw new SiteAuthoringError(
          "approve.page_not_found",
          `${unknown.length} requested path(s) name no page this workspace tracks. The first ${listed.length} are `
            + "in alternatives and every one is on progress output. Nothing was approved. Run 'taproot-site pull' if "
            + `a page was created elsewhere. ${shown}${unknown.length > 5 ? ", …" : ""}`,
          { field: unknown[0], alternatives: listed },
        );
      }
      for (const item of skipped) {
        onProgress(`${item.path} has no pending draft (${item.reason.replaceAll("_", " ")}); skipping it.`);
      }
    }
    const reportedSkipped = boundedList(skipped, MAXIMUM_REPORTED);
    const skippedResult = skipped.length > 0
      ? {
        skipped: {
          total: skipped.length,
          items: reportedSkipped.items,
          ...(reportedSkipped.truncated ? { itemsTruncated: true } : {}),
        },
      }
      : {};

    if (candidates.length === 0) {
      onProgress(
        skipped.length > 0
          ? "Nothing to approve: the requested page(s) have no pending draft."
          : "No page in this workspace is carrying a draft; there is nothing to approve.",
      );
      return successResult(VERB_APPROVE, siteId, {
        approved: { total: 0, items: [] },
        ...skippedResult,
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
          approved.push({ pageId: summary.pageId, path: displayPagePath(summary.path), status: summary.status });
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
      ...skippedResult,
      // Said explicitly so a caller cannot read "approve" as "live".
      stagedNotDeployed: true,
      nextStep: "deploy --staging",
    });
  });
}
