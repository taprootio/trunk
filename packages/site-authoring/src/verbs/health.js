import { getSiteHealth, listSiteImagesByIds, withRefusalGuidance } from "../api.js";
import {
  CLI_BINARY_NAME,
  DEPLOY_TARGET_PRODUCTION,
  DEPLOY_TARGET_STAGING,
  SURFACE_DOCS_PRESENTATION,
  VERB_HEALTH,
} from "../constants.js";
import { SiteAuthoringError } from "../errors.js";
import { boundedByBytes, openSession, successResult } from "../session.js";
import {
  altsFromDocument,
  buildImageFinding,
  buildPageFindings,
  filesByPageId,
  mergeAlts,
  productionKeys,
  reportHealthProgress,
  resolveAffectedPages,
} from "../site-health-findings.js";
import { readManifest, readMediaManifest } from "../workspace.js";
import { convertWorkspacePageSource, readWorkspacePageSource, requireCompletePageMetadata } from "./pages-push.js";

/**
 * `health --staging | --production` — the stored Site Health report of one release (TR01363).
 *
 * Site Health is compiled when a release is generated, so this reads what the release stored and never
 * recomputes it. It marks the findings that are new since production, and gives each an exact fix. Read-only.
 */

/** About the findings a `health` result carries; a full 200 and 200 report still fits the 64 KiB result bound. */
export const HEALTH_BUDGETS = Object.freeze({ findings: 32 * 1024, imageFindings: 16 * 1024 });
/** `deploy --staging` also carries readiness, redirects and the staging preview, so its share is smaller. */
export const DEPLOY_HEALTH_BUDGETS = Object.freeze({ findings: 12 * 1024, imageFindings: 8 * 1024 });

export const DOCS_SITE_HEALTH_NOT_COVERED =
  "This is a managed Docs site: its pages come from the Docs artifact, so Site Health does not apply and no "
  + "report was read.";

/**
 * Why a health read failed, as a short code for a warning: `deploy` and `status` never fail a command on a read
 * that comes after the work they report, so every error but a cancelled run is reduced to this. An error that is
 * not the CLI's own is named only as unexpected, because its text is not ours to print.
 */
export function readFailureCode(error) {
  if (error instanceof SiteAuthoringError && error.code === "site.cancelled") throw error;
  return error instanceof SiteAuthoringError ? error.code : "unexpected";
}

const INCOMPLETE_NOTE = "Coverage is incomplete, so this report is not a pass; the findings below are all it holds.";

const UNAVAILABLE_REASONS = Object.freeze({
  not_checked: {
    [DEPLOY_TARGET_PRODUCTION]: "Production has no stored report yet. A report is created when a release is generated.",
    [DEPLOY_TARGET_STAGING]:
      "No stored report exists for the staged release. If one was just staged, run "
      + `'${CLI_BINARY_NAME} health --staging' again shortly (nothing here waits); otherwise run '${CLI_BINARY_NAME} deploy --staging'.`,
  },
  unsupported: "Site Health does not support this site type, so there is no report.",
  incomplete: "The stored report could not be read as a complete report, so it has no deployment identity to show.",
  unknown: "Taproot returned a report with a status this CLI does not know.",
});

function unavailable(status, environment) {
  const reason = status === "not_checked"
    ? UNAVAILABLE_REASONS.not_checked[environment]
    : UNAVAILABLE_REASONS[status] ?? UNAVAILABLE_REASONS.unknown;
  return { available: false, status, environment, unpublishedChangesAssessed: false, reason };
}

/**
 * The alt text the workspace places for each image, read offline with the conversion `validate` uses.
 *
 * A page that cannot be read, converted or walked contributes nothing, so this never fails a verb. `files` are the
 * page sources to read, tracked or not; the default is every tracked source. Returns a Map from lowercase image id
 * to its distinct trimmed non-empty alts, in file order (see `altsFromDocument` for what counts).
 */
export async function collectPlacementAlts({ workspaceDir, manifest, mediaManifest, files, content }) {
  const entryByFile = new Map();
  for (const entry of manifest?.pages ?? []) {
    if (typeof entry?.file === "string") entryByFile.set(entry.file, entry);
  }
  const alts = new Map();
  for (const file of files ?? [...entryByFile.keys()]) {
    let found;
    try {
      const source = requireCompletePageMetadata(
        await readWorkspacePageSource({ workspaceDir, file, manifestEntry: entryByFile.get(file) }),
      );
      found = altsFromDocument(await convertWorkspacePageSource({ source, mediaManifest, content }));
    } catch {
      continue;
    }
    mergeAlts(alts, found);
  }
  return alts;
}

/** A media manifest that cannot be read only costs alt suggestions; it never fails a health read. */
async function readMediaManifestOrEmpty(workspaceDir, siteId, onProgress) {
  try {
    return await readMediaManifest(workspaceDir, siteId);
  } catch {
    onProgress("Warning: the workspace's media manifest could not be read, so no alt text is suggested for images.");
    return { media: {}, videos: {} };
  }
}

/**
 * Reads one release's stored report and shapes it for a result. Shared by `health` and `deploy --staging`, so
 * both return the same object. Production is read first, for the comparison and for the staged release's id;
 * `deploy` passes the id of the deployment it just staged, so its read never depends on what production names.
 */
export async function readSiteHealthReport({
  client,
  config,
  siteId,
  onProgress,
  environment,
  stagedDeploymentId,
  budgets,
}) {
  const production = await getSiteHealth(client, siteId);
  let report = production;
  if (environment === DEPLOY_TARGET_STAGING) {
    const releaseId = stagedDeploymentId ?? production.stagedDeploymentId;
    if (releaseId === undefined) return unavailable("not_checked", environment);
    report = await getSiteHealth(client, siteId, { deploymentId: releaseId });
  }
  const available = ["complete", "incomplete"].includes(report.status) && Boolean(report.deploymentId);
  if (!available) return unavailable(report.status, environment);

  const manifest = await readManifest(config.workspaceDir, siteId, { required: false });
  const fileByPageId = filesByPageId(manifest);
  const staging = environment === DEPLOY_TARGET_STAGING;
  const keys = staging ? productionKeys(production) : undefined;
  const findings = buildPageFindings(report, { fileByPageId, keys, environment });

  // Image reads and page sources are only needed when there is an image finding to fix.
  let imageFindings = [];
  if (report.images.length > 0) {
    const read = await listSiteImagesByIds(client, siteId, report.images.map((image) => image.imageId));
    if (read.failedIds.length > 0) {
      onProgress(
        `Warning: ${read.failedIds.length} image(s) could not be read, so their fixes lack the description revision; `
          + `run '${CLI_BINARY_NAME} media images get <image-id>' for it.`,
      );
    }
    const records = new Map(read.images.map((image) => [image.imageId, image]));
    const failed = new Set(read.failedIds);
    // In manifest order, so the first usable alt for an image is the same whichever finding names a page first.
    const affected = new Set(
      report.images.flatMap((image) => image.affectedPages.map((page) => fileByPageId.get(page.pageId))),
    );
    const affectedFiles = (manifest?.pages ?? []).map((entry) => entry?.file)
      .filter((file) => typeof file === "string" && affected.has(file));
    const alts = affectedFiles.length === 0
      ? new Map()
      : await collectPlacementAlts({
        workspaceDir: config.workspaceDir,
        manifest,
        mediaManifest: await readMediaManifestOrEmpty(config.workspaceDir, siteId, onProgress),
        files: affectedFiles,
      });
    imageFindings = report.images.map((stored) => {
      const record = records.get(stored.imageId);
      const isFailed = failed.has(stored.imageId);
      return {
        ...buildImageFinding({
          imageId: stored.imageId,
          name: stored.name || record?.name || "",
          descriptionRevision: isFailed ? undefined : record?.descriptionRevision,
          hasDefault: record !== undefined && record.defaultDescription !== undefined,
          available: isFailed || record !== undefined,
          alts: alts.get(stored.imageId) ?? [],
          affectedPages: resolveAffectedPages(stored.affectedPages, fileByPageId),
          environment,
        }),
        ...(keys === undefined ? {} : { newSinceProduction: !keys.images.has(stored.imageId) }),
      };
    });
  }

  const compared = keys !== undefined;
  reportHealthProgress(onProgress, {
    environment,
    checkedAt: report.checkedAt,
    status: report.status,
    findings,
    imageFindings,
    compared: staging ? compared : undefined,
  });
  const keptFindings = boundedByBytes(findings, budgets.findings);
  const keptImages = boundedByBytes(imageFindings, budgets.imageFindings);
  return {
    available: true,
    status: report.status,
    environment,
    deploymentId: report.deploymentId,
    outputReleaseId: report.outputReleaseId,
    checkedAt: report.checkedAt,
    ruleVersion: report.ruleVersion,
    coverage: report.coverage,
    assessedPageCount: report.assessedPageCount,
    errorCount: report.errorCount,
    warningCount: report.warningCount,
    truncated: report.truncated,
    // The report covers the named release only; drafts and approvals made after it are outside it.
    unpublishedChangesAssessed: false,
    ...(report.status === "incomplete" ? { note: INCOMPLETE_NOTE } : {}),
    ...(staging
      ? {
        comparison: compared
          ? {
            comparedTo: "production",
            compared: true,
            newFindings: findings.filter((item) => item.newSinceProduction).length,
            newImageFindings: imageFindings.filter((item) => item.newSinceProduction).length,
          }
          : {
            comparedTo: "production",
            compared: false,
            reason: "Production has no complete, untruncated report to compare with, so every finding is listed as not compared.",
          },
      }
      : {}),
    findingsTotal: findings.length,
    imageFindingsTotal: imageFindings.length,
    findings: keptFindings.items,
    imageFindings: keptImages.items,
    ...(keptFindings.truncated ? { findingsTruncated: true } : {}),
    ...(keptImages.truncated ? { imageFindingsTruncated: true } : {}),
  };
}

export async function health(invocation) {
  const target = invocation.deployTarget;
  if (target !== DEPLOY_TARGET_STAGING && target !== DEPLOY_TARGET_PRODUCTION) {
    throw new SiteAuthoringError("health.target_missing", "health requires exactly one of --staging or --production.", {
      field: "deployTarget",
      exitCode: 2,
    });
  }
  const { client, config, siteId, surface, onProgress } = await openSession(invocation);
  return await withRefusalGuidance(onProgress, "health", async () => {
    if (surface === SURFACE_DOCS_PRESENTATION) {
      onProgress(DOCS_SITE_HEALTH_NOT_COVERED);
      return successResult(VERB_HEALTH, siteId, {
        environment: target,
        covered: false,
        reason: DOCS_SITE_HEALTH_NOT_COVERED,
      });
    }
    onProgress(`Reading the stored ${target} Site Health report.`);
    const report = await readSiteHealthReport({
      client,
      config,
      siteId,
      onProgress,
      environment: target,
      budgets: HEALTH_BUDGETS,
    });
    if (!report.available) onProgress(`Site health (${target}): ${report.reason}`);
    return successResult(VERB_HEALTH, siteId, report);
  });
}
