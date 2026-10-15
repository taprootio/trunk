import {
  DEPLOYMENT_ENVIRONMENT_STAGING,
  DEPLOYMENT_PENDING_STATUSES,
  DEPLOYMENT_STATUS_COMPLETED,
  DEPLOYMENT_STATUS_FAILED,
  listDeployments,
  mintStagingPreviewHandoff,
  poll,
} from "./api.js";
import { LIMITS } from "./constants.js";
import { isCanonicalUuid, SiteAuthoringError } from "./errors.js";
import { authorizeStagingHandoff, fetchStagingPage } from "./staging-check.js";
import { ApiError } from "./transport.js";

/**
 * Which release the staging host serves right now (TR01236).
 *
 * A staging deployment reports completed once the platform has asked Cloudflare
 * to write the host's route. The edge then needs up to about two minutes to
 * serve it: the route propagates through Workers KV, and the Worker keeps its
 * own KV read cache and per-isolate cache on top. A cache-busting query cannot
 * help, because the release comes from the route entry and not the URL. The
 * Worker stamps the release it served into every staged page, so the CLI reads
 * that stamp and waits until it changes, instead of letting a reviewer open the
 * previous version.
 *
 * The CLI cannot learn the new deployment's release id (the public deployment
 * record does not carry a Standard site's), so it compares against what staging
 * served before the deployment was sent. That comparison is only sound when the
 * edge had settled on the previous release, which the caller checks.
 */

const IDENTITY_ATTRIBUTE = /\sdata-review-identity="([^"]{1,200})"/u;
// The read before the deploy is bounded so a slow host cannot hold up sending it.
const BEFORE_READ_MILLISECONDS = 15_000;
// The deployments listing that tells whether the previous deployment has settled has its own budget.
const PREVIOUS_DEPLOYMENT_MILLISECONDS = 10_000;

/** The release a staged HTML document says it came from, or null when it names none. */
export function parseServedStagingRelease(html) {
  const attribute = IDENTITY_ATTRIBUTE.exec(html)?.[1];
  if (attribute === undefined) return null;
  try {
    const identity = JSON.parse(attribute.replaceAll("&quot;", "\""));
    if (Array.isArray(identity) && identity.length === 2 && identity[0] === "staging" && isCanonicalUuid(identity[1])) {
      return identity[1];
    }
  } catch {
    // An unreadable stamp is the same as no stamp.
  }
  return null;
}

/**
 * The release a staged response names, reading at most `maximumBytes` of its body and
 * stopping at the first stamp. A body past the bound is cut, which loses the stamp rather
 * than memory.
 */
export async function readServedStagingRelease(response, maximumBytes = LIMITS.stagingServedPageBytes) {
  return parseServedStagingRelease(await readBoundedText(response, maximumBytes));
}

async function readBoundedText(response, maximumBytes) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
      if (bytes >= maximumBytes || IDENTITY_ATTRIBUTE.test(text)) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return text;
}

// Every network step of a read ends by the read's deadline, not only the API call.
function deadlineSignal(client, now, deadline) {
  return deadline === undefined ? undefined : client.timeoutSignal(Math.max(1, deadline - now()));
}

async function openSession(client, siteId, now, deadline) {
  const handoff = await mintStagingPreviewHandoff(client, siteId, { now, deadline });
  const cookie = await authorizeStagingHandoff(client, handoff, deadlineSignal(client, now, deadline));
  return { cookie, origin: new URL(handoff.stagingUrl).origin };
}

/**
 * One read of the staging host's served release, inside `deadline`.
 *
 * Returns `{ kind: "release", releaseId }` when the host served a staged page,
 * `{ kind: "none" }` when it has no staged release to show yet (the site's
 * first staging deployment has no host until it completes, or the host answered
 * with a page that carries no stamp), and `{ kind: "unknown" }` when the read
 * itself failed. A failed read never says which release is served.
 */
export async function observeStagingRelease(client, siteId, now, session, deadline) {
  try {
    const open = session.current ?? await openSession(client, siteId, now, deadline);
    session.current = open;
    const response = await fetchStagingPage(
      client,
      `${open.origin}/`,
      open.cookie,
      deadlineSignal(client, now, deadline),
    );
    if (response.status !== 200 && response.status !== 404) {
      await response.body?.cancel().catch(() => {});
      // A redirect or refusal means the gate did not let the read through, not that nothing is served.
      return { kind: "unknown" };
    }
    const releaseId = await readServedStagingRelease(response);
    return releaseId === null ? { kind: "none" } : { kind: "release", releaseId };
  } catch (error) {
    if (client.signal?.aborted) throw error;
    // The first staging deployment has no acknowledged host to mint a handoff for.
    if (error instanceof ApiError && error.hasField("Host")) return { kind: "none" };
    return { kind: "unknown" };
  }
}

/**
 * Whether the edge has settled on the newest completed staging deployment, and which
 * deployment that is: state "none" (the site has never completed one, so any release
 * staging serves is new), "recent" (it completed inside the propagation ceiling, so
 * the edge may still be moving to it), "settled", or "unknown" (the listing could not
 * be read, or its answer cannot be trusted). Only "none" and "settled" allow a
 * comparison. `id` is that newest completed deployment, or null.
 */
async function previousStagingDeployment(client, siteId, now) {
  const result = (state, id = null) => ({ state, id });
  try {
    const { deployments, truncated } = await listDeployments(
      client,
      siteId,
      { environment: DEPLOYMENT_ENVIRONMENT_STAGING, pageSize: 5 },
      { deadline: now() + PREVIOUS_DEPLOYMENT_MILLISECONDS, now },
    );
    // A deployment still under way (another terminal's, with a different candidate) will move the edge
    // before this one does, so a change from the baseline could be its release.
    if (deployments.some((deployment) => DEPLOYMENT_PENDING_STATUSES.includes(deployment.status))) return result("unknown");
    const completed = deployments.find((deployment) => deployment.status === DEPLOYMENT_STATUS_COMPLETED);
    if (completed === undefined) return truncated ? result("unknown") : result("none");
    const completedAt = Date.parse(completed.completedAt ?? "");
    if (!Number.isFinite(completedAt)) return result("unknown");
    // A completion ahead of this machine's clock is treated as recent: the clocks disagree, so
    // the age cannot be trusted and the wait should not claim to know.
    return result(
      now() - completedAt < LIMITS.stagingPropagationCeilingSeconds * 1000 ? "recent" : "settled",
      completed.id,
    );
  } catch (error) {
    if (client.signal?.aborted) throw error;
    return result("unknown");
  }
}

/**
 * True when another staging deployment, not this one, may have moved the edge since the
 * baseline was taken: any non-failed deployment newer than the baseline's newest completed
 * one (another terminal's, submitted after the baseline listing and before this request).
 * A listing that cannot show where the baseline sits, or cannot be read, is ambiguous too.
 */
async function interveningStagingDeployment(client, siteId, now, { baselineDeploymentId, deploymentId }) {
  try {
    // A wider page than the baseline's, so this request's own row cannot push the baseline off it.
    const { deployments, truncated } = await listDeployments(
      client,
      siteId,
      { environment: DEPLOYMENT_ENVIRONMENT_STAGING, pageSize: 20 },
      { deadline: now() + PREVIOUS_DEPLOYMENT_MILLISECONDS, now },
    );
    const baselineAt = baselineDeploymentId === null
      ? deployments.length
      : deployments.findIndex((deployment) => deployment.id === baselineDeploymentId);
    if (baselineAt < 0 || (baselineDeploymentId === null && truncated)) return true;
    return deployments.slice(0, baselineAt).some((deployment) =>
      deployment.id !== deploymentId && deployment.status !== DEPLOYMENT_STATUS_FAILED
    );
  } catch (error) {
    if (client.signal?.aborted) throw error;
    return true;
  }
}

/**
 * The release staging serves before a deployment is sent, to tell when it
 * changes. `unsettled` marks a read taken when the previous staging deployment may
 * still be propagating (or could not be checked): what it saw can be that
 * deployment's predecessor, so a later change cannot be attributed to this one.
 */
export async function readStagingReleaseBefore(client, siteId, now) {
  // Listed first, so the previous deployment's age is judged no later than the read it qualifies.
  const { state: previous, id: baselineDeploymentId } = await previousStagingDeployment(client, siteId, now);
  const observed = await observeStagingRelease(client, siteId, now, {}, now() + BEFORE_READ_MILLISECONDS);
  // A site that never completed a staging deployment serves nothing yet, whether its host
  // has no route (a derived address) or refuses a handoff for want of one.
  if (previous === "none" && observed.kind !== "release") return { kind: "none", unsettled: false, baselineDeploymentId };
  const unsettled = previous === "recent" || previous === "unknown";
  // A site that has served a release and gave no readable baseline has nothing to compare against.
  if (observed.kind === "none") return { kind: "unknown", unsettled, baselineDeploymentId };
  return { ...observed, unsettled, baselineDeploymentId };
}

/**
 * What a deployment reports when the served release cannot be confirmed: only
 * the ceiling is known. `reason` says why, so a skipped check does not read as a
 * failed one.
 */
export function unverifiedStagingServed(startedAt, reason = "The CLI could not confirm that staging serves the new release.") {
  const ceiling = LIMITS.stagingPropagationCeilingSeconds;
  const expectedBy = new Date(startedAt + ceiling * 1000).toISOString();
  return {
    state: "unverified",
    ceilingSeconds: ceiling,
    expectedBy,
    message: `${reason} The edge can serve the previous release for up to ${ceiling} seconds after a deployment completes; wait until ${expectedBy} before reviewing.`,
  };
}

/**
 * Waits, within a bound, until staging serves a release other than `before`, and
 * says what it found. It never fails the deployment: the deployment completed,
 * and what is uncertain is only when the edge catches up.
 *
 * States: `served` (a different release answered twice in a row), `propagating`
 * (the last read at the bound still showed the previous release), and
 * `unverified` (the answer cannot be attributed to this deployment, or the last
 * read did not name the previous release, so only the ceiling is known).
 */
export async function confirmStagingServed(client, siteId, { before, deploymentId, coalesced = false, onProgress, now }) {
  const startedAt = now();
  const ceiling = LIMITS.stagingPropagationCeilingSeconds;
  if (before.kind === "unknown") return unverifiedStagingServed(startedAt);
  if (before.unsettled) {
    return unverifiedStagingServed(
      startedAt,
      "The previous staging deployment completed moments ago, so a change in what staging serves cannot be attributed to this one.",
    );
  }
  if (coalesced) {
    return unverifiedStagingServed(
      startedAt,
      "This request joined a deployment that was already under way, which may already be served.",
    );
  }
  onProgress(
    `Deployment completed. The edge can serve the previous release for up to ${ceiling} seconds; waiting for staging to serve the new one.`,
  );
  const session = {};
  let streak = 0;
  // Whether the latest read still named the baseline release: the only evidence of "still the previous release".
  let stillBaseline = false;
  let lastReported = startedAt;
  try {
    await poll({
      client,
      now,
      onProgress,
      timeoutMilliseconds: LIMITS.stagingServedMilliseconds,
      intervalMilliseconds: LIMITS.stagingServedPollMilliseconds,
      read: async ({ deadline }) => await observeStagingRelease(client, siteId, now, session, deadline),
      evaluate: (observed) => {
        stillBaseline = observed.kind === "release" && before.kind === "release"
          && observed.releaseId === before.releaseId;
        const isNew = observed.kind === "release"
          && (before.kind !== "release" || observed.releaseId !== before.releaseId);
        streak = isNew ? streak + 1 : 0;
        if (streak >= LIMITS.stagingServedConfirmations) return { done: true, value: true };
        // One line every fifteen seconds: enough to show it is alive, not a scrolling log.
        if (stillBaseline && now() - lastReported >= 15_000) {
          lastReported = now();
          return { done: false, progress: "Staging is still serving the previous release; checking again." };
        }
        return { done: false };
      },
      timeoutCode: "staging.served_timeout",
    });
  } catch (error) {
    if (!(error instanceof SiteAuthoringError) || error.code !== "staging.served_timeout") throw error;
    const waited = Math.round((now() - startedAt) / 1000);
    if (!stillBaseline) {
      // The wait outlasted the ceiling, so there is no later time to wait for.
      return {
        state: "unverified",
        waitedSeconds: waited,
        ceilingSeconds: ceiling,
        message: `The CLI could not confirm which release staging serves after ${waited} seconds, which is past the ${ceiling}-second ceiling. Open the handoff and confirm the release before reviewing.`,
      };
    }
    return {
      state: "propagating",
      waitedSeconds: waited,
      ceilingSeconds: ceiling,
      message: `Staging was still serving the previous release ${waited} seconds after the deployment completed. Wait a minute and run 'taproot-site staging review' for a fresh handoff before reviewing.`,
    };
  }
  // The baseline was read before this request was sent; a deployment another terminal completed
  // in between could be the release that answered, so check the history again before claiming it.
  if (
    await interveningStagingDeployment(client, siteId, now, {
      baselineDeploymentId: before.baselineDeploymentId ?? null,
      deploymentId,
    })
  ) {
    return unverifiedStagingServed(
      now(),
      "Another staging deployment ran around this one, so a change in what staging serves cannot be attributed to it.",
    );
  }
  const seconds = Math.round((now() - startedAt) / 1000);
  onProgress(`Staging serves the new release (${seconds} seconds after the deployment completed).`);
  return { state: "served", servedAfterSeconds: seconds, ceilingSeconds: ceiling };
}
