import { replaceSiteRedirectMap, withRefusalGuidance } from "../api.js";
import { VERB_REDIRECTS_PUSH } from "../constants.js";
import { SiteAuthoringError } from "../errors.js";
import {
  projectRedirectMapForWorkspace,
  REDIRECT_KIND_GONE,
  REDIRECTS_FILE_NAME,
  validateRedirectsDocument,
} from "../redirects-contract.js";
import { advanceRedirectsManifest, readRedirectsWorkspaceContext } from "../redirects-workspace.js";
import { boundedList, openSession, successResult, warnIfExternalWritesPaused } from "../session.js";
import { ApiError } from "../transport.js";
import { readWorkspaceJson, WORKSPACE_LIMITS, writeWorkspaceJson } from "../workspace.js";

const MAXIMUM_REPORTED = 200;

/**
 * `redirects push` — replace the whole map from the workspace file.
 *
 * The revision travels with the write. A push whose baseline predates a page
 * rename is refused as a conflict rather than committing a map that silently
 * drops the rename's entry, and the guidance says to re-pull and reconcile
 * rather than to retry.
 */
function translateConflict(error) {
  if (error instanceof ApiError && error.hasField("ExpectedRevision")) {
    return new SiteAuthoringError(
      "redirects.concurrent_modification",
      "The redirect map changed after this workspace read it — most often a page or tag rename recorded its own "
        + `entry. Run 'taproot-site redirects pull', reconcile ${REDIRECTS_FILE_NAME}, and retry. Nothing was `
        + "written.",
      { field: "revision", status: error.status },
    );
  }
  return error;
}

export async function redirectsPush(invocation) {
  const session = await openSession(invocation);
  const { client, config, siteId, onProgress } = session;
  warnIfExternalWritesPaused(session, VERB_REDIRECTS_PUSH);
  const context = await readRedirectsWorkspaceContext(config.workspaceDir, siteId);
  const validated = validateRedirectsDocument(
    await readWorkspaceJson(config.workspaceDir, REDIRECTS_FILE_NAME, WORKSPACE_LIMITS.redirectsBytes),
    siteId,
    // The entry cap is scoped against the map this workspace pulled, the way
    // the site scopes it against the rows it holds: a site whose accumulated
    // path history is already over the cap can push its own map back, or a
    // smaller one, without deleting a live redirect to satisfy a number.
    { baselineEntries: context.redirects.entries },
  );
  onProgress(
    `Validated ${validated.entries.length} redirect entr${validated.entries.length === 1 ? "y" : "ies"}: `
      + "path normalization, targets, statuses, duplicates, chains, and loops.",
  );

  // The manifest baseline wins over the file's own `revision` field. The file
  // is authored by hand and its revision is a record of a read, not a claim a
  // caller gets to make; taking it from the manifest keeps a hand-edited value
  // from widening what a push may overwrite.
  const expectedRevision = context.redirects.revision;

  let map;
  try {
    map = await withRefusalGuidance(
      onProgress,
      "redirects push",
      async () => await replaceSiteRedirectMap(client, siteId, expectedRevision, validated.entries),
    );
  } catch (error) {
    throw translateConflict(error);
  }

  const document_ = projectRedirectMapForWorkspace(siteId, map);
  try {
    // The document lands before its baseline, exactly as `footer push` orders
    // its two writes: if the manifest write fails, a stale revision refuses the
    // next push rather than letting it overwrite the map just saved.
    await writeWorkspaceJson(config.workspaceDir, REDIRECTS_FILE_NAME, document_);
    await advanceRedirectsManifest(config.workspaceDir, siteId, map);
  } catch (error) {
    if (error instanceof SiteAuthoringError) throw error.withCompletedWrites(["redirects"]);
    throw error;
  }
  onProgress("Replaced the site's redirect map and recorded its new revision.");

  const reported = boundedList(document_.entries, MAXIMUM_REPORTED);
  return successResult(VERB_REDIRECTS_PUSH, siteId, {
    redirectsFile: REDIRECTS_FILE_NAME,
    revision: map.revision,
    redirects: {
      total: map.entries.length,
      gone: map.entries.filter((entry) => entry.kind === REDIRECT_KIND_GONE).length,
      items: reported.items,
      ...(reported.truncated ? { itemsTruncated: true } : {}),
    },
    written: { items: ["redirects"], count: 1 },
    nextStep: "deploy --staging",
  });
}
