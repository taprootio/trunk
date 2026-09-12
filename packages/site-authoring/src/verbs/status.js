import {
  getDeploySelection,
  getPublishingReadiness,
  getSiteBrokenReferences,
  IMAGE_PROCESSING_STATE_COMPLETE,
  IMAGE_PROCESSING_STATE_FAILED,
  listDeployments,
  listSiteImages,
  withRefusalGuidance,
} from "../api.js";
import { isBehindLatest } from "../cli-release.js";
import {
  CLI_UPGRADE_COMMAND,
  CLI_VERSION,
  EXTERNAL_WRITES_SETTING_KEY,
  EXTERNAL_WRITES_SETTING_LOCATION,
  PUBLISH_KEY_ENVIRONMENT_VARIABLE,
  REFUSAL_CLI_OUTDATED,
  REFUSAL_PLATFORM_PAUSED,
  SURFACE_DOCS_PRESENTATION,
  VERB_STATUS,
} from "../constants.js";
import { boundedList, openSession, successResult } from "../session.js";

/**
 * `status` — the platform authoring switch, CLI release, deployments,
 * publishing readiness, image processing, and broken-reference pages.
 */
const MAXIMUM_DEPLOYMENTS = 20;
const MAXIMUM_FAILED_IMAGES = 50;
const MAXIMUM_BLOCKERS = 50;
const MAXIMUM_BROKEN_REFERENCE_PAGES = 50;
const MAXIMUM_MISSING_TARGETS = 50;

const PLATFORM_UNKNOWN_NOTE =
  "Taproot never reported the platform authoring switch on this run: either no sign-in token exchange happened "
  + `(${PUBLISH_KEY_ENVIRONMENT_VARIABLE} supplies the site credential directly and skips it), or the Taproot that `
  + "answered the exchange predates the field.";

const CLI_RELEASE_UNKNOWN_NOTE =
  "Taproot never named the latest published CLI release on this run: either no sign-in token exchange happened "
  + `(${PUBLISH_KEY_ENVIRONMENT_VARIABLE} supplies the site credential directly and skips it), or the Taproot that `
  + "answered the exchange predates the field.";

/**
 * Which release this CLI is against the latest Taproot named (TR00703).
 *
 * The same three-state shape as the platform switch, and reported the same way:
 * a known answer carries `latestVersion`, an unknown one carries
 * `latestKnown: false` and the reason. It is named `cliRelease` rather than
 * `cli` because every result already carries a top-level `cli` naming this
 * package and its version, and shadowing that would change what a field means
 * depending on which verb produced it.
 *
 * `behind: true` is not reachable through a live exchange, and deliberately not
 * removed: the exchange that supplies this value refuses an outdated CLI before
 * it answers, so a run that gets here was accepted. What the branch protects is
 * the case where those two facts ever come apart — a server that reports a
 * latest it does not enforce — where reporting `behind: false` would be a
 * confident lie rather than a missing field.
 */
function reportCliRelease(release, onProgress) {
  const latestVersion = release?.latestVersion;
  if (latestVersion === undefined) {
    onProgress(`CLI release: ${CLI_VERSION}. Latest not known on this run. ${CLI_RELEASE_UNKNOWN_NOTE}`);
    return { version: CLI_VERSION, latestKnown: false, reason: CLI_RELEASE_UNKNOWN_NOTE };
  }
  const behind = isBehindLatest(latestVersion);
  onProgress(
    behind
      ? `CLI release: ${CLI_VERSION} is BEHIND the latest published release ${latestVersion}, and Taproot accepts `
        + `only the latest, so every online verb is refused (refusal=${REFUSAL_CLI_OUTDATED}). Upgrade with: `
        + CLI_UPGRADE_COMMAND
      : `CLI release: ${CLI_VERSION}; latest published release ${latestVersion}.`,
  );
  return { version: CLI_VERSION, latestVersion, behind };
}

/**
 * The rollout switch as `status` reports it (TR00692), on both channels.
 *
 * Three states, and the JSON says which it is by shape rather than by a
 * three-valued boolean: a known state carries `externalWritesEnabled`, and an
 * unknown one carries `externalWritesKnown: false` and the reason. An
 * automation reading `platform.externalWritesEnabled === false` is therefore
 * never reading an absent field as "paused".
 */
function reportPlatform(platform, onProgress) {
  const enabled = platform?.externalWritesEnabled;
  if (enabled === undefined) {
    onProgress(`Platform authoring switch: not known on this run. ${PLATFORM_UNKNOWN_NOTE}`);
    return { externalWritesKnown: false, reason: PLATFORM_UNKNOWN_NOTE };
  }
  onProgress(
    enabled
      ? "Platform authoring switch: external site authoring writes are enabled."
      : "Platform authoring switch: external site authoring writes are PAUSED platform-wide, so every write verb "
        + `is refused (refusal=${REFUSAL_PLATFORM_PAUSED}). A Taproot administrator re-enables the platform `
        + `setting '${EXTERNAL_WRITES_SETTING_KEY}' (${EXTERNAL_WRITES_SETTING_LOCATION}).`,
  );
  return { externalWritesEnabled: enabled };
}

/**
 * What a managed Docs site's status leaves out (TR00790), said the same way
 * the platform switch says "unknown": by shape. The image library and the
 * broken-reference report are page-authoring reads a Docs site refuses, so
 * they are reported as not covered rather than as empty — an automation
 * reading `failed: 0` off a report that was never made would be reading a lie.
 */
const DOCS_SITE_NOT_COVERED_NOTE =
  "This is a managed Docs site: its pages come from the Docs artifact, so the image library and broken-reference "
  + "reads do not apply and were not made.";

export async function status(invocation) {
  const { client, siteId, surface, platform, release, onProgress } = await openSession(invocation);
  const presentationOnly = surface === SURFACE_DOCS_PRESENTATION;
  // Said first, and before any wire read: an operator running `status` because
  // writes are being refused should not have to wait on network calls to
  // learn that the platform is paused — and this answer needs none of them.
  const platformReport = reportPlatform(platform, onProgress);
  const cliReleaseReport = reportCliRelease(release, onProgress);

  return await withRefusalGuidance(onProgress, "status check", async () => {
    onProgress("Reading publishing readiness.");
    const reviewed = await getDeploySelection(client, siteId);
    // The review is site-type-blind: a managed Docs site's settings-only
    // production manifest makes any draft navigation row read as changed
    // forever. Readiness is asked about the candidate `deploy` would actually
    // send there — settings only — so hasCandidateChanges answers for it
    // (TR00790).
    const selection = presentationOnly
      ? { ...reviewed, stagedPageIds: [], includeNavigation: false }
      : reviewed;
    const readiness = await getPublishingReadiness(client, siteId, {
      ...selection,
      stagedPageIds: selection.stagedPageIds.length > 100 ? undefined : selection.stagedPageIds,
    });
    onProgress("Reading the deployment log.");
    const {
      deployments,
      truncated: deploymentsTruncated,
    } = await listDeployments(client, siteId, { pageSize: MAXIMUM_DEPLOYMENTS });
    if (presentationOnly) {
      onProgress(DOCS_SITE_NOT_COVERED_NOTE);
    }
    let images = [];
    let summary = { totalImages: 0, processingImages: 0 };
    let truncated = false;
    let brokenReferencePages = [];
    if (!presentationOnly) {
      onProgress("Reading image processing state.");
      ({ images, summary, truncated } = await listSiteImages(client, siteId));
      onProgress("Reading broken references.");
      brokenReferencePages = await getSiteBrokenReferences(client, siteId);
    }
    const reportedBrokenPages = boundedList(brokenReferencePages, MAXIMUM_BROKEN_REFERENCE_PAGES);
    const brokenPages = reportedBrokenPages.items.map((page) => {
      const images = boundedList(page.missingImageIds, MAXIMUM_MISSING_TARGETS);
      const paths = boundedList(page.missingPagePaths, MAXIMUM_MISSING_TARGETS);
      return {
        ...page,
        missingImageIds: images.items,
        missingPagePaths: paths.items,
        ...(images.truncated ? { missingImageIdsTruncated: true } : {}),
        ...(paths.truncated ? { missingPagePathsTruncated: true } : {}),
      };
    });

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

    if (!presentationOnly) {
      onProgress(`Broken references: ${brokenReferencePages.length} page(s) with missing targets.`);
    }

    return successResult(VERB_STATUS, siteId, {
      platform: platformReport,
      cliRelease: cliReleaseReport,
      ...(presentationOnly ? { authoringSurface: SURFACE_DOCS_PRESENTATION } : {}),
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
      images: presentationOnly ? { covered: false, reason: DOCS_SITE_NOT_COVERED_NOTE } : {
        covered: true,
        total: summary.totalImages,
        processing: summary.processingImages,
        complete: byState[IMAGE_PROCESSING_STATE_COMPLETE] ?? 0,
        failed: byState[IMAGE_PROCESSING_STATE_FAILED] ?? 0,
        byState,
        failedItems: failedImages.items,
        ...(failedImages.truncated ? { failedItemsTruncated: true } : {}),
        ...(truncated ? { listTruncated: true } : {}),
      },
      brokenReferences: presentationOnly ? { covered: false, reason: DOCS_SITE_NOT_COVERED_NOTE } : {
        covered: true,
        totalPages: brokenReferencePages.length,
        pages: brokenPages,
        ...(reportedBrokenPages.truncated ? { pagesTruncated: true } : {}),
      },
    });
  });
}
