import { getSiteRedirectMap, withRefusalGuidance } from "../api.js";
import { REFUSAL_UNCLASSIFIED, VERB_REDIRECTS_PULL } from "../constants.js";
import { SiteAuthoringError } from "../errors.js";
import {
  projectRedirectMapForWorkspace,
  REDIRECT_KIND_GONE,
  REDIRECT_ORIGIN_AUTHORED,
  REDIRECTS_FILE_NAME,
} from "../redirects-contract.js";
import { redirectsManifestEntry } from "../redirects-workspace.js";
import { boundedList, openSession, successResult } from "../session.js";
import { ApiError } from "../transport.js";
import { readManifest, writeManifest, writeWorkspaceJson } from "../workspace.js";

const MAXIMUM_REPORTED = 200;

/**
 * `redirects pull` — snapshot the site's whole redirect map.
 *
 * It writes `redirects.json` and records the map's revision in the pull
 * manifest, because a whole-map push has to be fenced against the state it was
 * built from: the map holds entries nobody typed — one per page or tag rename —
 * and a stale replace would delete them.
 *
 * It is a verb of its own as well as part of `pull` so an agent can re-read
 * just the map after a rename, or after a conflicting push, without re-pulling
 * every page.
 */
export async function redirectsPull(invocation) {
  const { client, config, siteId, onProgress } = await openSession(invocation);
  // The manifest is required rather than optional: without one there is no
  // pulled workspace for this file to belong to, and the same refusal `pages
  // push` gives is the right one here.
  const manifest = await readManifest(config.workspaceDir, siteId);

  const map = await withRefusalGuidance(
    onProgress,
    "redirects pull",
    async () => await readRedirectMapOrRefuse(client, siteId),
  );

  const document_ = projectRedirectMapForWorkspace(siteId, map);
  await writeWorkspaceJson(config.workspaceDir, REDIRECTS_FILE_NAME, document_);
  manifest.redirects = redirectsManifestEntry(map);
  await writeManifest(config.workspaceDir, manifest);
  onProgress(
    `Wrote ${REDIRECTS_FILE_NAME} with ${map.entries.length} entr${map.entries.length === 1 ? "y" : "ies"} `
      + "and recorded the map revision.",
  );

  const authored = map.entries.filter((entry) => entry.origin === REDIRECT_ORIGIN_AUTHORED).length;
  const reported = boundedList(document_.entries, MAXIMUM_REPORTED);
  return successResult(VERB_REDIRECTS_PULL, siteId, {
    redirectsFile: REDIRECTS_FILE_NAME,
    revision: map.revision,
    redirects: {
      total: map.entries.length,
      // Split so an agent can tell what it declared from what a rename
      // recorded, which is the difference between "mine to edit" and "the
      // site's own history, delete it only on purpose".
      authored,
      pathHistory: map.entries.length - authored,
      gone: map.entries.filter((entry) => entry.kind === REDIRECT_KIND_GONE).length,
      items: reported.items,
      ...(reported.truncated ? { itemsTruncated: true } : {}),
    },
  });
}

/**
 * A Taproot that predates the redirect map answers the route with a bare 404.
 * Named here rather than surfaced as an unclassified status, because the
 * refusal `redirects push` gives for a missing baseline sends the operator to
 * this verb (TR00702).
 */
async function readRedirectMapOrRefuse(client, siteId) {
  try {
    return await getSiteRedirectMap(client, siteId);
  } catch (error) {
    if (error instanceof ApiError && error.refusalKind() === REFUSAL_UNCLASSIFIED && error.httpStatus === 404) {
      throw new SiteAuthoringError(
        "redirects.not_served",
        "This Taproot does not serve a redirect map yet. Wait for the deploy that adds it, then run "
          + "'taproot-site redirects pull' again.",
        { status: error.status },
      );
    }
    throw error;
  }
}
