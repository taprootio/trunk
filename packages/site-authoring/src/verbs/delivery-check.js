import {
  DEPLOYMENT_ENVIRONMENT_PRODUCTION,
  DEPLOYMENT_ENVIRONMENT_STAGING,
  DEPLOYMENT_STATUS_COMPLETED,
  getStagingPreviewStatus,
  listDeployments,
  mintStagingPreviewHandoff,
  withRefusalGuidance,
} from "../api.js";
import { DEPLOY_TARGET_PRODUCTION, DEPLOY_TARGET_STAGING, VERB_DELIVERY_CHECK } from "../constants.js";
import { probeDeliveryWithBrowser } from "../delivery-browser.js";
import { checkDelivery, DELIVERY_LIMITS } from "../delivery-check.js";
import { SiteAuthoringError } from "../errors.js";
import { openSession, successResult } from "../session.js";
import { authorizeStagingHandoff } from "../staging-check.js";
import { readManifest } from "../workspace.js";

/**
 * `delivery check (--staging | --production)` — verify what a visitor
 * receives after a deployment completed (TR00824).
 *
 * The deployment log says the job finished. This verb reads the target the
 * way a visitor does and reports three dimensions separately: the completed
 * deployment (from the site's deployment log and the workspace record), HTTP
 * delivery of the authored routes, their assets and the declared runtime, and
 * — only when a browser is available — what a fresh and a returning browser
 * actually loaded. Nothing is purged, republished, rolled back or mutated.
 */

function usageError(code, message, field) {
  return new SiteAuthoringError(code, message, { field, exitCode: 2 });
}

function environmentFor(target) {
  return target === DEPLOY_TARGET_STAGING ? DEPLOYMENT_ENVIRONMENT_STAGING : DEPLOYMENT_ENVIRONMENT_PRODUCTION;
}

async function resolveTarget(client, siteId, target, invocation, onProgress, now) {
  if (typeof invocation.deliveryUrl === "string" && invocation.deliveryUrl !== "") {
    if (target === DEPLOY_TARGET_STAGING) {
      // The staging edge serves only an authorized preview session bound to
      // the acknowledged host, so another origin could not be checked as
      // staging; refusing is truer than an unauthenticated probe.
      throw usageError(
        "delivery.url_not_for_staging",
        "--url applies to --production; --staging always checks the site's acknowledged staging host with an "
          + "authorized preview session.",
        "url",
      );
    }
    return { baseUrl: invocation.deliveryUrl, source: "option" };
  }
  if (target === DEPLOY_TARGET_STAGING) {
    const status = await getStagingPreviewStatus(client, siteId);
    if (!status.ready) {
      throw new SiteAuthoringError(
        "delivery.staging_unavailable",
        "The site has no acknowledged staging host yet, so there is nothing a visitor could receive. Wait for the "
          + "staging hostname to become ready (taproot-site status), then run delivery check again.",
        { field: "stagingUrl" },
      );
    }
    // The staging edge serves nothing without the preview cookie; the
    // handoff is consumed here, once, and the cookie never leaves this run.
    onProgress("Authorizing a staging preview session for the check.");
    const handoff = await mintStagingPreviewHandoff(client, siteId, { now });
    const cookie = await authorizeStagingHandoff(client, handoff, client.timeoutSignal(90_000));
    // The cookie is bound to the host the handoff was minted for; if the
    // acknowledged host moved between the status read and the mint, that
    // host — not the earlier status — is the only origin the cookie may reach.
    if (handoff.stagingUrl !== status.stagingUrl) {
      onProgress(`The acknowledged staging host changed to ${handoff.stagingUrl} while the check started; checking that host.`);
    }
    return { baseUrl: handoff.stagingUrl, source: "staging-status", cookie };
  }
  throw usageError(
    "delivery.production_url_required",
    "delivery check --production needs the site's public origin: pass --url https://<published-domain>/ using the "
      + "primaryDomain that 'taproot-site sites' reports. A site-authoring key cannot read hosting configuration, so "
      + "the CLI does not guess it.",
    "url",
  );
}

export async function deliveryCheck(invocation) {
  const target = invocation.deployTarget;
  if (target !== DEPLOY_TARGET_STAGING && target !== DEPLOY_TARGET_PRODUCTION) {
    throw usageError("delivery.target_missing", "delivery check requires exactly one of --staging or --production.", "deployTarget");
  }
  const session = await openSession(invocation);
  const { client, config, siteId, now, onProgress } = session;
  const environment = environmentFor(target);
  const manifest = await readManifest(config.workspaceDir, siteId, { required: false });
  const recorded = manifest?.deployments?.[target];

  return await withRefusalGuidance(onProgress, "delivery check", async () => {
    onProgress("Reading the deployment log.");
    const { deployments } = await listDeployments(client, siteId, { environment });
    const completed = deployments.find((deployment) => deployment.status === DEPLOYMENT_STATUS_COMPLETED);
    if (completed === undefined) {
      throw new SiteAuthoringError(
        "delivery.no_completed_deployment",
        `No completed ${target} deployment exists for this site, so there is no delivery to verify. Run `
          + `'taproot-site deploy --${target}' first.`,
        { field: "deploymentId" },
      );
    }
    const deployment = {
      id: completed.id,
      completedAt: completed.completedAt,
      recordedInWorkspace: typeof recorded?.id === "string" ? recorded.id === completed.id : undefined,
      ...(typeof recorded?.id === "string" && recorded.id !== completed.id ? { workspaceRecordedId: recorded.id } : {}),
    };
    if (deployment.recordedInWorkspace === false) {
      onProgress(
        `Note: the workspace recorded ${target} deployment ${recorded.id}, but the latest completed ${target} deployment is ${completed.id}; the latest one is what visitors receive and is what this check verifies.`,
      );
    }

    const resolved = await resolveTarget(client, siteId, target, invocation, onProgress, now);
    const routes = (manifest?.pages ?? [])
      .filter((page) => page !== null && typeof page === "object" && typeof page.path === "string")
      .map((page) => (page.path === "" ? "/" : `/${page.path.replace(/^\/+/u, "")}/`.replace(/\/\/$/u, "/")));
    onProgress(`Checking ${resolved.baseUrl} (${Math.min(routes.length + 1, DELIVERY_LIMITS.routes)} route(s), assets, runtime).`);
    const report = await checkDelivery({
      fetch: client.fetch,
      timeoutSignal: client.timeoutSignal,
      baseUrl: resolved.baseUrl,
      routes,
      cookie: resolved.cookie,
      propagationWaitSeconds: invocation.propagationWaitSeconds ?? 0,
      now,
    });
    for (const failure of report.failures) onProgress(`Delivery: ${failure}`);

    let browser;
    if (invocation.browser === false) {
      browser = { status: "unchecked", reason: "disabled", note: "Browser verification was not requested." };
    } else {
      onProgress("Browser dimension: probing with Playwright when it is installed.");
      browser = await probeDeliveryWithBrowser({
        baseUrl: resolved.baseUrl,
        expectedEntryUrl: report.runtime.entry?.url ?? "",
        capabilities: report.runtime.capabilities,
        cookie: resolved.cookie,
        importPlaywright: invocation.importPlaywright,
      });
    }
    if (browser.status === "unchecked") onProgress(`Browser dimension unchecked: ${browser.reason}.`);
    else if (browser.status === "checked" && !browser.ok) onProgress("Browser dimension: a load did not match the declared runtime or left the site origin; see browser.fresh and browser.returning.");
    if (browser.status === "checked" && browser.returningCache?.status !== "checked") onProgress("Browser dimension: cache reuse on the returning load could not be observed; it is unchecked.");

    const verdict = report.verdict === "delivered" && browser.status === "checked" && !browser.ok ? "degraded" : report.verdict;
    onProgress(
      verdict === "delivered"
        ? "Delivery verified over HTTP" + (browser.status === "checked" ? " and in a browser." : "; browser behaviour unchecked.")
        : `Delivery ${verdict}: ${report.failures.length} HTTP finding(s)` + (browser.status === "checked" && !browser.ok ? " and a browser mismatch." : "."),
    );
    return successResult(VERB_DELIVERY_CHECK, siteId, {
      environment,
      target: { ...report.target, resolvedFrom: resolved.source },
      deployment,
      verdict,
      routes: report.routes,
      assets: report.assets,
      links: report.links,
      localOnlyReferences: report.localOnlyReferences,
      ...(report.localOnlyReferencesTotal === undefined ? {} : { localOnlyReferencesTotal: report.localOnlyReferencesTotal }),
      runtime: report.runtime,
      browser,
      failures: report.failures,
      ...(report.failuresTruncated ? { failuresTruncated: true, failuresTotal: report.failuresTotal } : {}),
      propagation: report.propagation,
      limits: report.limits,
      checkedAt: report.checkedAt,
      doesNotProve: [
        "a full visual or accessibility audit",
        "member-only content delivery, which stays behind the member boundary",
        ...(browser.status === "checked" && browser.returningCache?.status === "checked"
          ? []
          : ["what a returning browser loads from its own cache"]),
      ],
    });
  });
}
