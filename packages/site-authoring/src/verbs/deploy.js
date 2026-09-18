import {
  DEPLOYMENT_ENVIRONMENT_PRODUCTION,
  DEPLOYMENT_ENVIRONMENT_STAGING,
  DEPLOYMENT_REQUEST_OUTCOME_COALESCED,
  DEPLOYMENT_STATUS_COMPLETED,
  deploySite,
  getDeploySelection,
  getPublishingReadiness,
  listDeployments,
  mintStagingPreviewHandoff,
  waitForDeployment,
  withRefusalGuidance,
} from "../api.js";
import {
  DEPLOY_TARGET_PRODUCTION,
  DEPLOY_TARGET_STAGING,
  REFUSAL_CAPABILITY_MISSING,
  REFUSAL_CREDENTIAL_REJECTED,
  REFUSAL_UNCLASSIFIED,
  SURFACE_DOCS_PRESENTATION,
  VERB_DEPLOY,
} from "../constants.js";
import { SiteAuthoringError } from "../errors.js";
import { boundedList, openSession, successResult, warnIfExternalWritesPaused } from "../session.js";
import { checkStagingRedirects } from "../staging-check.js";
import { ApiError } from "../transport.js";
import { readManifest, writeManifest } from "../workspace.js";

/**
 * What a deploy does not finish (TR00702).
 *
 * A deploy writes the site's redirect and gone entries into the edge's
 * key-value store as part of syncing routing. That store is eventually
 * consistent, so a spot-check run the second a deploy reports success can
 * briefly read the previous map, and taking that for "the redirect did not
 * land" is the wrong conclusion to reach in front of a customer waiting to cut
 * DNS over.
 *
 * No number is quoted, because there is none to quote: the coordinator holds
 * nothing back for a standard site's redirects. Its propagation grace governs
 * only the *deletion* of a superseded Docs pointer namespace; a standard site's
 * rows are written and removed immediately.
 */
const REDIRECT_PROPAGATION_NOTE =
  "Redirect and gone entries are written to the edge's key-value store when this deploy syncs routing. That "
  + "store is eventually consistent, so a spot-check run immediately afterwards can briefly still see the "
  + "previous map; re-check before concluding an entry is missing.";

/**
 * `deploy --staging` / `deploy --production` — readiness, deploy, poll to
 * completion.
 *
 * Staging publishes a *candidate*: approved pages, navigation, and the
 * changed candidate-selectable settings groups. The server refuses an empty candidate,
 * so the CLI refuses it first and says what to do about it.
 *
 * Production is a promotion and only a promotion. `DeploySite` rejects a
 * production request that carries both a `stagingDeploymentId` and explicit
 * candidate changes ("Choose either a completed staging deployment or explicit
 * candidate changes, not both"), so the CLI never sends a selection alongside
 * one — and refuses locally if a caller supplies both.
 *
 * Completion is observed by polling `GET /v1/sites/{id}/deployments`. The SSE
 * deployment stream is user-session-scoped and therefore unreachable from a
 * key-authorized CLI; the repo's no-polling rule governs UX surfaces and does
 * not reach this one. proto3 omits zero-valued enums, so a deployment listed
 * without a status is queued, not unknown.
 *
 * The published-page quota has no pre-flight read anywhere on the contract. It
 * surfaces here, at deploy time, as an `UpgradePrompt` field violation —
 * classified `plan_limit` and announced prominently by `announceRefusal` — and
 * the CLI never invents the numeric limit it was not told.
 */

const MAXIMUM_REPORTED_BLOCKERS = 50;
// Staged page ids ride in the readiness query string, so a very large candidate
// is checked at site level instead of pushing an unbounded URL at the API.
const MAXIMUM_READINESS_PAGE_IDS = 100;

function usageError(code, message, field) {
  return new SiteAuthoringError(code, message, { field, exitCode: 2 });
}

/**
 * One line when this request coalesced into an already in-flight or recently
 * anchored identical deployment (TR00839), instead of creating a new one.
 */
function announceOutcome(created, onProgress) {
  if (created.outcome === DEPLOYMENT_REQUEST_OUTCOME_COALESCED) {
    onProgress(`An identical deployment request is already in progress; reusing deployment ${created.id}.`);
  }
}

function explicitSelection(invocation) {
  const stagedPageIds = Array.isArray(invocation.stagedPageIds) ? invocation.stagedPageIds : undefined;
  const selectedSettingsTypes = Array.isArray(invocation.selectedSettingsTypes)
    ? invocation.selectedSettingsTypes
    : undefined;
  const includeNavigation = typeof invocation.includeNavigation === "boolean"
    ? invocation.includeNavigation
    : undefined;
  const present = (stagedPageIds !== undefined && stagedPageIds.length > 0)
    || (selectedSettingsTypes !== undefined && selectedSettingsTypes.length > 0)
    || includeNavigation === true;
  return { stagedPageIds, selectedSettingsTypes, includeNavigation, present };
}

async function recordDeployment(config, manifest, key, deployment) {
  if (manifest === undefined) return;
  manifest.deployments = { ...(manifest.deployments ?? {}) };
  manifest.deployments[key] = {
    id: deployment.id,
    status: deployment.status,
    completedAt: deployment.completedAt,
  };
  await writeManifest(config.workspaceDir, manifest);
}

async function resolveStagingDeploymentId(client, siteId, invocation, manifest, onProgress) {
  if (typeof invocation.stagingDeploymentId === "string" && invocation.stagingDeploymentId !== "") {
    return invocation.stagingDeploymentId;
  }
  const recorded = manifest?.deployments?.staging;
  if (recorded !== null && typeof recorded === "object" && typeof recorded.id === "string" && recorded.id !== "") {
    return recorded.id;
  }
  onProgress("Looking for the most recent completed staging deployment to promote.");
  const { deployments } = await listDeployments(client, siteId, { environment: DEPLOYMENT_ENVIRONMENT_STAGING });
  const completed = deployments.find((deployment) => deployment.status === DEPLOYMENT_STATUS_COMPLETED);
  if (completed === undefined) {
    throw new SiteAuthoringError(
      "deploy.staging_required",
      "Production promotes a completed staging deployment, and this site has none. "
        + "Run 'taproot-site deploy --staging' first.",
      { field: "stagingDeploymentId" },
    );
  }
  return completed.id;
}

function reportReadiness(readiness) {
  const blockers = boundedList(readiness.blockers, MAXIMUM_REPORTED_BLOCKERS);
  return {
    state: readiness.state,
    approvedPageCount: readiness.approvedPageCount,
    selectedPageCount: readiness.selectedPageCount,
    blockedPageCount: readiness.blockedPageCount,
    hasCandidateChanges: readiness.hasCandidateChanges,
    hasSuccessfulStagingDeployment: readiness.hasSuccessfulStagingDeployment,
    blockers: blockers.items,
    ...(blockers.truncated ? { blockersTruncated: true } : {}),
  };
}

async function inspectStagingPreview(client, siteId, onProgress, now) {
  let checks;
  try {
    checks = await checkStagingRedirects(client, siteId, onProgress, now);
    if (!checks.redirects.verified) {
      onProgress(
        "Warning: staging redirects are not all verified. Edge propagation may still be pending; run 'taproot-site redirects check' again.",
      );
    }
  } catch {
    onProgress(
      "Warning: the deployment completed, but authenticated staging redirect checks could not finish. Run 'taproot-site redirects check' again.",
    );
    checks = { routeCheck: "unresolved", redirects: { verified: false, covered: false } };
  }
  try {
    // Mint after checks so the final single-use URL has never been consumed.
    const handoff = await mintStagingPreviewHandoff(client, siteId, { now });
    return { ...checks, ...handoff };
  } catch {
    onProgress("Warning: the deployment completed, but a staging handoff could not be minted.");
    return { ...checks, url: "", warning: "Staging handoff unavailable; run redirects check to retry." };
  }
}

const PRESENTATION_REVIEW_GUIDANCE = "Open the URL once in a browser, then switch the site's theme toggle between "
  + "light and dark to review both schemes; no page draft is needed to preview a presentation change.";

/**
 * Why a managed Docs staging handoff could not be minted, as a stable reason
 * the caller can act on. The recovery never points at production or at a host
 * the CLI has not been told about.
 */
function presentationHandoffUnavailable(error) {
  if (error instanceof ApiError) {
    const refusal = error.refusalKind();
    if (refusal === REFUSAL_CREDENTIAL_REJECTED || refusal === REFUSAL_CAPABILITY_MISSING) {
      return {
        reason: "staging.authority_denied",
        recovery: "This credential cannot view staging for this site. Re-issue a site-authoring key that carries "
          + "the Deployments capability, then run 'taproot-site staging review' for a handoff.",
      };
    }
    if (refusal === REFUSAL_UNCLASSIFIED && error.hasField("SiteId")) {
      return {
        reason: "staging.surface_refused",
        recovery: "The site no longer accepts external presentation authoring (its Docs source is prebuilt). "
          + "Run 'taproot-site use' to re-record the site's surface; a prebuilt Docs site stages nothing.",
      };
    }
    if (refusal === REFUSAL_UNCLASSIFIED && error.hasField("Host")) {
      return {
        reason: "staging.host_unavailable",
        recovery: "The site has no acknowledged staging host yet. Wait for the staging hostname to become ready "
          + "(check 'taproot-site status'), then run 'taproot-site staging review' to mint a review handoff.",
      };
    }
  }
  return {
    reason: "staging.handoff_unavailable",
    recovery: "Run 'taproot-site staging review' to mint a fresh review handoff; the staged presentation is "
      + "already deployed and waits for review.",
  };
}

/**
 * A managed Docs site deploys settings only, so there are no page drafts or
 * redirects to inspect on staging; the review handoff is the whole handoff.
 * It is minted after the deployment completed, bound by the server to the
 * site's exact acknowledged staging host, and single-use like every other.
 */
async function mintPresentationStagingHandoff(client, siteId, onProgress, now) {
  try {
    const handoff = await mintStagingPreviewHandoff(client, siteId, { now });
    onProgress(`Staging review handoff minted for ${handoff.stagingUrl}. ${PRESENTATION_REVIEW_GUIDANCE}`);
    return { ...handoff, review: PRESENTATION_REVIEW_GUIDANCE };
  } catch (error) {
    if (error instanceof SiteAuthoringError && !(error instanceof ApiError)) throw error;
    const unavailable = presentationHandoffUnavailable(error);
    onProgress(`Warning: the deployment completed, but a staging review handoff could not be minted (${unavailable.reason}). ${unavailable.recovery}`);
    return { url: "", stagingUrl: "", ...unavailable };
  }
}

export async function deploy(invocation) {
  const target = invocation.deployTarget;
  if (target !== DEPLOY_TARGET_STAGING && target !== DEPLOY_TARGET_PRODUCTION) {
    throw usageError(
      "deploy.target_missing",
      "deploy requires exactly one of --staging or --production.",
      "deployTarget",
    );
  }
  const session = await openSession(invocation);
  const { client, config, siteId, surface, now, onProgress } = session;
  // A managed Docs site deploys its settings and nothing else (TR00790): the
  // Docs shell takes pages, navigation, and redirects from the artifact, so
  // the staging redirect inspection that follows a standard deployment has
  // nothing to inspect and the handoff it mints is refused there.
  const presentationOnly = surface === SURFACE_DOCS_PRESENTATION;
  // One advisory line before this verb does any work, and only when the
  // exchange said the platform is paused. It changes nothing else: the write
  // still runs and its refusal still classifies as platform_paused (TR00692).
  warnIfExternalWritesPaused(session, VERB_DEPLOY);
  const manifest = await readManifest(config.workspaceDir, siteId, { required: false });
  const selection = explicitSelection(invocation);

  return await withRefusalGuidance(onProgress, "deploy", async () => {
    if (target === DEPLOY_TARGET_PRODUCTION) {
      if (selection.present) {
        throw usageError(
          "deploy.production_selection",
          "deploy --production promotes a completed staging deployment and cannot also carry an explicit page, "
            + "settings, or navigation selection. Deploy the selection to staging first, then promote it.",
          "stagingDeploymentId",
        );
      }
      const stagingDeploymentId = await resolveStagingDeploymentId(client, siteId, invocation, manifest, onProgress);
      onProgress(`Checking publishing readiness before promoting staging deployment ${stagingDeploymentId}.`);
      const readiness = await getPublishingReadiness(client, siteId);
      const created = await deploySite(client, siteId, {
        siteId,
        environment: DEPLOYMENT_ENVIRONMENT_PRODUCTION,
        stagingDeploymentId,
        ...(invocation.allowFailedPreview === true ? { allowFailedPreview: true } : {}),
      });
      onProgress(`Production deployment ${created.id} accepted; waiting for it to complete.`);
      announceOutcome(created, onProgress);
      const completed = await waitForDeployment(client, {
        siteId,
        deploymentId: created.id,
        environment: DEPLOYMENT_ENVIRONMENT_PRODUCTION,
        onProgress,
        now,
      });
      await recordDeployment(config, manifest, "production", completed);
      if (!presentationOnly) onProgress(REDIRECT_PROPAGATION_NOTE);
      return successResult(VERB_DEPLOY, siteId, {
        target,
        environment: DEPLOYMENT_ENVIRONMENT_PRODUCTION,
        ...(presentationOnly ? { authoringSurface: SURFACE_DOCS_PRESENTATION } : {}),
        promotedStagingDeploymentId: stagingDeploymentId,
        deployment: completed,
        outcome: created.outcome,
        readiness: reportReadiness(readiness),
      });
    }

    // An explicit page or navigation selection on a managed Docs site is
    // refused before the review is read: the caller asked for something the
    // site cannot take. The review's own defaults are a different matter,
    // handled below.
    if (
      presentationOnly
      && ((selection.stagedPageIds?.length ?? 0) > 0 || selection.includeNavigation === true)
    ) {
      throw usageError(
        "deploy.presentation_only",
        "A managed Docs site deploys settings only: its pages and navigation come from the Docs artifact, so a "
          + "candidate naming pages or navigation cannot be staged from here.",
        "Candidate",
      );
    }
    onProgress("Reading the changed release set shown on the Deployments page.");
    const defaults = await getDeploySelection(client, siteId);
    // The review is site-type-blind, and a Docs site's settings-only
    // production manifest makes any draft navigation row read as a change
    // forever. The Deployments page zeroes pages and navigation for a Docs
    // site rather than refusing on them, and this does the same (TR00790).
    const stagedPageIds = presentationOnly ? [] : selection.stagedPageIds ?? defaults.stagedPageIds;
    const selectedSettingsTypes = selection.selectedSettingsTypes ?? defaults.selectedSettingsTypes;
    const includeNavigation = presentationOnly ? false : selection.includeNavigation ?? defaults.includeNavigation;
    if (stagedPageIds.length === 0 && selectedSettingsTypes.length === 0 && !includeNavigation) {
      throw new SiteAuthoringError(
        "deploy.empty_selection",
        presentationOnly
          ? "A staging deployment on a managed Docs site needs at least one settings change; it stages settings "
            + "only. Change a theme, brand, header, or footer setting first."
          : "A staging deployment needs at least one approved page, settings group, or navigation change. "
            + "Run 'taproot-site approve' or change staged settings/navigation first.",
        { field: "Candidate" },
      );
    }

    const candidate = {
      stagedPageIds,
      selectedSettingsTypes,
      includeNavigation,
    };
    onProgress(
      `Checking publishing readiness for ${stagedPageIds.length} page(s), `
        + `${selectedSettingsTypes.length} settings group(s), `
        + `navigation ${includeNavigation ? "included" : "excluded"}.`,
    );
    const readiness = await getPublishingReadiness(client, siteId, {
      ...candidate,
      stagedPageIds: stagedPageIds.length > MAXIMUM_READINESS_PAGE_IDS ? undefined : stagedPageIds,
    });
    if (readiness.blockers.length > 0) {
      throw new SiteAuthoringError(
        "deploy.media_blocked",
        `Taproot reports ${readiness.blockers.length} media blocker(s) on this candidate, starting with '${
          readiness.blockers[0].uploadedName || readiness.blockers[0].imageId
        }': ${readiness.blockers[0].message || readiness.blockers[0].state}.`,
        { field: readiness.blockers[0].imageId || "blockers", status: readiness.blockers[0].state },
      );
    }
    if (!readiness.hasCandidateChanges) {
      onProgress("Taproot reports this candidate contains no changes; deploying it anyway would be a no-op.");
    }

    const created = await deploySite(client, siteId, {
      siteId,
      environment: DEPLOYMENT_ENVIRONMENT_STAGING,
      ...candidate,
      ...(invocation.allowFailedPreview === true ? { allowFailedPreview: true } : {}),
    });
    onProgress(`Staging deployment ${created.id} accepted; waiting for it to complete.`);
    announceOutcome(created, onProgress);
    const completed = await waitForDeployment(client, {
      siteId,
      deploymentId: created.id,
      environment: DEPLOYMENT_ENVIRONMENT_STAGING,
      onProgress,
      now,
    });
    await recordDeployment(config, manifest, "staging", completed);
    if (presentationOnly) {
      const stagingPreview = await mintPresentationStagingHandoff(client, siteId, onProgress, now);
      return successResult(VERB_DEPLOY, siteId, {
        target,
        environment: DEPLOYMENT_ENVIRONMENT_STAGING,
        authoringSurface: SURFACE_DOCS_PRESENTATION,
        selection: {
          stagedPageCount: 0,
          selectedSettingsTypes,
          includeNavigation: false,
        },
        deployment: completed,
        outcome: created.outcome,
        readiness: reportReadiness(readiness),
        stagingPreview,
        nextStep: stagingPreview.url === "" ? "staging review" : "deploy --production",
      });
    }
    const stagingPreview = await inspectStagingPreview(client, siteId, onProgress, now);
    onProgress(REDIRECT_PROPAGATION_NOTE);
    return successResult(VERB_DEPLOY, siteId, {
      target,
      environment: DEPLOYMENT_ENVIRONMENT_STAGING,
      selection: {
        stagedPageCount: stagedPageIds.length,
        selectedSettingsTypes,
        includeNavigation,
      },
      deployment: completed,
      outcome: created.outcome,
      readiness: reportReadiness(readiness),
      stagingPreview,
      nextStep: stagingPreview.redirects?.verified === true ? "deploy --production" : "redirects check",
    });
  });
}
