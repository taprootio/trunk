import {
  getPublishingReadiness,
  IMAGE_PROCESSING_STATE_COMPLETE,
  IMAGE_PROCESSING_STATE_FAILED,
  listDeployments,
  listSiteImages,
  withRefusalGuidance,
} from "../api.js";
import { VERB_STATUS } from "../constants.js";
import { boundedList, openSession, successResult } from "../session.js";

/**
 * `status` — deployments, publishing readiness, and image processing.
 *
 * Broken references are deliberately absent. `GetSiteBrokenReferences` is
 * session-only under TR00602's read list, and TR00604 adds no server surface,
 * so there is no key-authorized way to read them. The verb says that out loud —
 * on the human channel and as a field in the JSON result — rather than
 * reporting a clean site and implying a coverage it does not have.
 */

const MAXIMUM_DEPLOYMENTS = 20;
const MAXIMUM_FAILED_IMAGES = 50;
const MAXIMUM_BLOCKERS = 50;

const BROKEN_REFERENCES_NOTE =
  "GetSiteBrokenReferences is session-only on the shipped contract, so a key-authorized CLI cannot read it.";

export async function status(invocation) {
  const { client, siteId, onProgress } = await openSession(invocation);

  return await withRefusalGuidance(onProgress, "status check", async () => {
    onProgress("Reading publishing readiness.");
    const readiness = await getPublishingReadiness(client, siteId);
    onProgress("Reading the deployment log.");
    const {
      deployments,
      truncated: deploymentsTruncated,
    } = await listDeployments(client, siteId, { pageSize: MAXIMUM_DEPLOYMENTS });
    onProgress("Reading image processing state.");
    const { images, summary, truncated } = await listSiteImages(client, siteId);

    const byState = {};
    for (const image of images) {
      byState[image.processingState] = (byState[image.processingState] ?? 0) + 1;
    }
    const failedImages = boundedList(
      images
        .filter((image) => image.processingState === IMAGE_PROCESSING_STATE_FAILED)
        .map((image) => ({
          imageId: image.imageId,
          uploadedName: image.uploadedName,
          reason: image.processingFailureReason,
        })),
      MAXIMUM_FAILED_IMAGES,
    );
    const reportedDeployments = boundedList(deployments, MAXIMUM_DEPLOYMENTS);
    const blockers = boundedList(readiness.blockers, MAXIMUM_BLOCKERS);

    onProgress(`Broken references are not reported: ${BROKEN_REFERENCES_NOTE}`);

    return successResult(VERB_STATUS, siteId, {
      readiness: {
        state: readiness.state,
        approvedPageCount: readiness.approvedPageCount,
        blockedPageCount: readiness.blockedPageCount,
        hasCandidateChanges: readiness.hasCandidateChanges,
        hasSuccessfulStagingDeployment: readiness.hasSuccessfulStagingDeployment,
        blockers: blockers.items,
        ...(blockers.truncated ? { blockersTruncated: true } : {}),
      },
      deployments: {
        // One page of the log, not the site's history. `listTruncated` says so
        // rather than letting `total` read as a count of every deployment the
        // site has ever had.
        total: deployments.length,
        items: reportedDeployments.items,
        ...(reportedDeployments.truncated ? { itemsTruncated: true } : {}),
        ...(deploymentsTruncated ? { listTruncated: true } : {}),
      },
      images: {
        total: summary.totalImages,
        processing: summary.processingImages,
        complete: byState[IMAGE_PROCESSING_STATE_COMPLETE] ?? 0,
        failed: byState[IMAGE_PROCESSING_STATE_FAILED] ?? 0,
        byState,
        failedItems: failedImages.items,
        ...(failedImages.truncated ? { failedItemsTruncated: true } : {}),
        ...(truncated ? { listTruncated: true } : {}),
      },
      brokenReferences: { covered: false, reason: BROKEN_REFERENCES_NOTE },
    });
  });
}
