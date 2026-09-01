import {
  createAuthoringPreview,
  mintAuthoringPreviewHandoff,
  translateAuthoringPreviewApiError,
  waitForAuthoringPreview,
  withRefusalGuidance,
} from "../api.js";
import { VERB_PREVIEW_PAGE } from "../constants.js";
import { asSiteAuthoringError, isCanonicalUuid, SiteAuthoringError } from "../errors.js";
import { openSession, successResult } from "../session.js";
import { normalizePagePath, readManifest } from "../workspace.js";

/**
 * Creates an immutable page preview, observes the generator-owned render, and
 * mints the short browser handoff only after the snapshot is ready.
 *
 * A canonical UUID selects directly. A page path resolves through the pulled
 * manifest, giving push, approve, and preview one human-facing selector. The
 * URL is emitted only in
 * the final success object — never in progress or failure text — because its
 * query value is a two-minute bearer capability.
 */
export async function previewPage(invocation) {
  if (typeof invocation.pageSelector !== "string" && !isCanonicalUuid(invocation.pageId)) {
    throw new SiteAuthoringError(
      "preview.page_id_invalid",
      "preview page requires one canonical lowercase page UUID when called programmatically with pageId.",
      { field: "pageId", exitCode: 2 },
    );
  }
  const selector = invocation.pageSelector ?? invocation.pageId;
  if (
    typeof selector === "string"
    && !isCanonicalUuid(selector)
    && isCanonicalUuid(selector.toLowerCase())
  ) {
    throw new SiteAuthoringError(
      "preview.page_selector_invalid",
      "preview page UUID selectors must use canonical lowercase characters.",
      { field: "pageSelector", exitCode: 2 },
    );
  }
  const { client, config, siteId, now, onProgress } = await openSession(invocation);
  let pageId = selector;
  if (!isCanonicalUuid(selector)) {
    const pagePath = normalizePagePath(selector);
    if (pagePath === undefined) {
      throw new SiteAuthoringError(
        "preview.page_selector_invalid",
        `'${selector}' is not a usable page path or canonical lowercase page UUID.`,
        { field: "pageSelector", exitCode: 2 },
      );
    }
    const manifest = await readManifest(config.workspaceDir, siteId);
    const matches = manifest.pages.filter((entry) =>
      typeof entry?.pageId === "string" && normalizePagePath(entry.path) === pagePath);
    if (matches.length !== 1 || !isCanonicalUuid(matches[0].pageId)) {
      throw new SiteAuthoringError(
        "preview.page_not_found",
        `No unique manifest page was found for path '${pagePath || "/"}'. Run 'taproot-site pull' and try again.`,
        // The homepage normalizes to the empty path, which the emitters drop
        // as falsy; name it by its documented spelling so the stable error
        // contract keeps a field for every unknown path.
        { field: pagePath || "/" },
      );
    }
    pageId = matches[0].pageId;
    onProgress(`Resolved page path '${pagePath}' to pageId=${pageId}.`);
  }
  let created;
  try {
    return await withRefusalGuidance(onProgress, "authoring preview", async () => {
      onProgress("Requesting an immutable authoring preview snapshot.");
      created = await createAuthoringPreview(client, siteId, pageId);
      onProgress(
        `Authoring preview created: pageId=${created.pageId} snapshotId=${created.snapshotId} expiresAt=${created.expiresAt} storedPreviews=${created.storedPreviewCount}/${created.storedPreviewCap}.`,
      );
      for (const evicted of created.evictedPreviews) {
        onProgress(
          `Authoring preview evicted at the stored-preview cap: pageId=${evicted.pageId} snapshotId=${evicted.snapshotId} capturedAt=${evicted.capturedAt}.`,
        );
      }
      onProgress("The authoring preview was accepted; waiting for the render to become ready.");
      const ready = await waitForAuthoringPreview(client, { created, onProgress, now });
      onProgress("The authoring preview is ready; minting a short-lived browser handoff.");
      const handoff = await mintAuthoringPreviewHandoff(client, ready, { now });
      return successResult(VERB_PREVIEW_PAGE, siteId, {
        pageId: ready.pageId,
        snapshotId: ready.snapshotId,
        status: ready.status,
        draftRevision: ready.draftRevision,
        capturedAt: ready.capturedAt,
        stagingHost: ready.stagingHost,
        url: handoff.url,
        expiresAt: ready.expiresAt,
        handoffExpiresAt: handoff.handoffExpiresAt,
        storedPreviewCap: created.storedPreviewCap,
        storedPreviewCount: created.storedPreviewCount,
        evictedPreviews: created.evictedPreviews,
      });
    });
  } catch (error) {
    const translated = asSiteAuthoringError(translateAuthoringPreviewApiError(error));
    if (created) translated.withPreviewRecovery(created);
    throw translated;
  }
}
