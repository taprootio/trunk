import {
  DEPLOYMENT_ENVIRONMENT_PRODUCTION,
  DEPLOYMENT_ENVIRONMENT_STAGING,
  DEPLOYMENT_STATUS_COMPLETED,
  deploySite,
  getPublishingReadiness,
  getStagingPreviewStatus,
  listDeployments,
  listSitePages,
  PAGE_STATUS_APPROVED,
  waitForDeployment,
  withRefusalGuidance,
} from "../api.js";
import {
  DEPLOY_TARGET_PRODUCTION,
  DEPLOY_TARGET_STAGING,
  VERB_DEPLOY,
} from "../constants.js";
import { SiteAuthoringError } from "../errors.js";
import { boundedList, openSession, successResult, warnIfExternalWritesPaused } from "../session.js";
import { CANDIDATE_SELECTABLE_SETTINGS_TYPES } from "../settings-catalog.js";
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
 * candidate-selectable settings groups. The server refuses an empty candidate,
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
const STAGING_ROUTE_PROBE_MILLISECONDS = 5_000;
// Staged page ids ride in the readiness query string, so a very large candidate
// is checked at site level instead of pushing an unbounded URL at the API.
const MAXIMUM_READINESS_PAGE_IDS = 100;

function usageError(code, message, field) {
  return new SiteAuthoringError(code, message, { field, exitCode: 2 });
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

function manifestSettingsTypes(manifest) {
  const pulled = Array.isArray(manifest?.settings)
    ? manifest.settings.map((entry) => entry?.settingsType).filter((value) => typeof value === "string")
    : [];
  return CANDIDATE_SELECTABLE_SETTINGS_TYPES.filter((type) => pulled.includes(type));
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
    blockers: blockers.items,
    ...(blockers.truncated ? { blockersTruncated: true } : {}),
  };
}

function stagingWarning(message) {
  return { routeCheck: "unresolved", warning: message };
}

async function inspectStagingPreview(client, siteId, onProgress) {
  let status;
  try {
    status = await getStagingPreviewStatus(client, siteId);
  } catch {
    const warning = "The staging deployment completed, but Taproot could not report its staging URL."
      + " Check the site's staging-host configuration before treating the deployment as viewable.";
    onProgress(`Warning: ${warning}`);
    return { url: "", ...stagingWarning(warning) };
  }
  if (!status.ready) {
    const warning = "The staging deployment completed, but Taproot does not report a ready staging URL.";
    onProgress(`Warning: ${warning}`);
    return { url: "", ...stagingWarning(warning) };
  }

  const stagingUrl = status.stagingUrl;
  onProgress(`Staging URL: ${stagingUrl}`);
  let response;
  try {
    const timeout = client.timeoutSignal(STAGING_ROUTE_PROBE_MILLISECONDS);
    const signal = client.signal ? AbortSignal.any([client.signal, timeout]) : timeout;
    response = await client.fetch(stagingUrl, {
      method: "GET",
      redirect: "manual",
      signal,
      headers: {
        accept: "text/html",
        "user-agent": "taproot-site/staging-route-check",
      },
    });
  } catch {
    const warning = `The staging deployment completed at ${stagingUrl}, but the host could not be reached.`;
    onProgress(`Warning: ${warning}`);
    return { url: stagingUrl, ...stagingWarning(warning) };
  }

  const location = response.headers.get("location");
  await response.body?.cancel().catch(() => {});
  let handoff;
  try {
    handoff = location ? new URL(location, stagingUrl) : undefined;
  } catch {
    handoff = undefined;
  }
  const stagingHost = new URL(stagingUrl).hostname;
  const resolvesToSite = response.status >= 300
    && response.status < 400
    && handoff?.protocol === "https:"
    && handoff.username === ""
    && handoff.password === ""
    && handoff.hash === ""
    && handoff.pathname === "/api/v1/staging-preview/handoff"
    && handoff.searchParams.getAll("siteId").length === 1
    && handoff.searchParams.get("siteId") === siteId
    && handoff.searchParams.getAll("host").length === 1
    && handoff.searchParams.get("host") === stagingHost;
  if (resolvesToSite) return { url: stagingUrl, routeCheck: "resolved" };

  const warning = `The staging deployment completed at ${stagingUrl}, but the host returned HTTP ${response.status}`
    + " instead of this site's staging gate. The deployment artifacts are complete, but the URL is not viewable.";
  onProgress(`Warning: ${warning}`);
  return { url: stagingUrl, ...stagingWarning(warning) };
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
  const { client, config, siteId, now, onProgress } = session;
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
      });
      onProgress(`Production deployment ${created.id} accepted; waiting for it to complete.`);
      const completed = await waitForDeployment(client, {
        siteId,
        deploymentId: created.id,
        environment: DEPLOYMENT_ENVIRONMENT_PRODUCTION,
        onProgress,
        now,
      });
      await recordDeployment(config, manifest, "production", completed);
      onProgress(REDIRECT_PROPAGATION_NOTE);
      return successResult(VERB_DEPLOY, siteId, {
        target,
        environment: DEPLOYMENT_ENVIRONMENT_PRODUCTION,
        promotedStagingDeploymentId: stagingDeploymentId,
        deployment: completed,
        readiness: reportReadiness(readiness),
      });
    }

    onProgress("Listing approved pages for the staging candidate.");
    const { pages, truncated } = await listSitePages(client, siteId, { onProgress });
    if (truncated) {
      // The candidate is built from this list, so a partial one silently
      // publishes a subset of what was approved — and the deployment that
      // follows reports success.
      throw new SiteAuthoringError(
        "deploy.live_list_truncated",
        "The site has more pages than this CLI can enumerate, so the staging candidate would omit approved "
          + "pages without saying so. Nothing was deployed.",
        { field: "stagedPageIds" },
      );
    }
    const stagedPageIds = selection.stagedPageIds
      ?? pages.filter((summary) => summary.status === PAGE_STATUS_APPROVED).map((summary) => summary.pageId);
    const selectedSettingsTypes = selection.selectedSettingsTypes ?? manifestSettingsTypes(manifest);
    const includeNavigation = selection.includeNavigation ?? manifest?.navigation !== undefined;
    if (stagedPageIds.length === 0 && selectedSettingsTypes.length === 0 && !includeNavigation) {
      throw new SiteAuthoringError(
        "deploy.empty_selection",
        "A staging deployment needs at least one approved page, settings group, or navigation change. "
          + "Run 'taproot-site approve' (and 'taproot-site pull' to pick up navigation and settings) first.",
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
    });
    onProgress(`Staging deployment ${created.id} accepted; waiting for it to complete.`);
    const completed = await waitForDeployment(client, {
      siteId,
      deploymentId: created.id,
      environment: DEPLOYMENT_ENVIRONMENT_STAGING,
      onProgress,
      now,
    });
    await recordDeployment(config, manifest, "staging", completed);
    const stagingPreview = await inspectStagingPreview(client, siteId, onProgress);
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
      readiness: reportReadiness(readiness),
      stagingPreview,
      nextStep: "deploy --production",
    });
  });
}
