import {
  AUTHORING_PREVIEW_STATUS_REVOKED,
  revokeAuthoringPreview,
  translateAuthoringPreviewApiError,
  withRefusalGuidance,
} from "../api.js";
import { VERB_PREVIEW_REVOKE } from "../constants.js";
import { isCanonicalUuid, SiteAuthoringError } from "../errors.js";
import { openSession, successResult, warnIfExternalWritesPaused } from "../session.js";

export async function previewRevoke(invocation) {
  if (!Array.isArray(invocation.previewIds) || invocation.previewIds.length !== 2) {
    throw new SiteAuthoringError(
      "preview.identity_invalid",
      "preview revoke requires one canonical lowercase page UUID and one canonical lowercase snapshot UUID.",
      { field: "snapshotId", exitCode: 2 },
    );
  }
  if (!isCanonicalUuid(invocation.previewIds[0])) {
    throw new SiteAuthoringError(
      "preview.identity_invalid",
      "preview revoke requires a canonical lowercase page UUID.",
      { field: "pageId", exitCode: 2 },
    );
  }
  if (!isCanonicalUuid(invocation.previewIds[1])) {
    throw new SiteAuthoringError(
      "preview.identity_invalid",
      "preview revoke requires a canonical lowercase snapshot UUID.",
      { field: "snapshotId", exitCode: 2 },
    );
  }
  const [pageId, snapshotId] = invocation.previewIds;
  const session = await openSession(invocation);
  const { client, siteId, onProgress } = session;
  // One advisory line before this verb does any work, and only when the
  // exchange said the platform is paused. It changes nothing else: the write
  // still runs and its refusal still classifies as platform_paused (TR00692).
  warnIfExternalWritesPaused(session, VERB_PREVIEW_REVOKE);
  try {
    return await withRefusalGuidance(onProgress, "authoring preview revocation", async () => {
      onProgress("Revoking the authoring preview and scheduling its artifacts for cleanup.");
      const revoked = await revokeAuthoringPreview(client, { siteId, pageId, snapshotId });
      if (revoked.status !== AUTHORING_PREVIEW_STATUS_REVOKED) {
        throw new SiteAuthoringError(
          "preview.status_contract",
          "Taproot returned an unexpected authoring-preview status after revocation.",
          { field: "status", status: revoked.status },
        );
      }
      return successResult(VERB_PREVIEW_REVOKE, siteId, {
        pageId: revoked.pageId,
        snapshotId: revoked.snapshotId,
        status: revoked.status,
        expiresAt: revoked.expiresAt,
      });
    });
  } catch (error) {
    throw translateAuthoringPreviewApiError(error);
  }
}
