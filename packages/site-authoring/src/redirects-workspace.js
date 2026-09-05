import { SiteAuthoringError } from "./errors.js";
import { isRedirectMapRevision, REDIRECTS_FILE_NAME } from "./redirects-contract.js";
import { readManifest, writeManifest } from "./workspace.js";

/**
 * The redirect map's workspace baseline (TR00702).
 *
 * `nav.json` needs no baseline because navigation is last-write-wins; the
 * redirect map cannot be, because it holds entries nobody typed. Every page and
 * tag rename records one, so a whole-map push built on a stale read would
 * delete the entry that keeps the renamed page's old URL alive. The manifest
 * therefore records the revision the map was read at, exactly as it records the
 * footer's draft hash, and a push that cannot produce one refuses toward pull
 * rather than guessing.
 */

export const REDIRECTS_MANIFEST_KEY = "redirects";

function pullRequired(message, field) {
  return new SiteAuthoringError("redirects.pull_required", message, { field });
}

function requireRedirectsMetadata(manifest) {
  const redirects = manifest[REDIRECTS_MANIFEST_KEY];
  if (redirects === null || typeof redirects !== "object" || Array.isArray(redirects)) {
    throw pullRequired(
      "The pull manifest does not record a redirect-map baseline. Run 'taproot-site redirects pull' "
        + "(or 'taproot-site pull') again.",
      REDIRECTS_MANIFEST_KEY,
    );
  }
  if (redirects.file !== REDIRECTS_FILE_NAME || !isRedirectMapRevision(redirects.revision)) {
    throw pullRequired(
      "The pull manifest has an invalid redirect-map baseline. Run 'taproot-site redirects pull' again.",
      `${REDIRECTS_MANIFEST_KEY}.revision`,
    );
  }
  return redirects;
}

export async function readRedirectsWorkspaceContext(workspaceDir, siteId) {
  const manifest = await readManifest(workspaceDir, siteId);
  return { manifest, redirects: requireRedirectsMetadata(manifest) };
}

/** The manifest entry `pull` writes for a freshly read map. */
export function redirectsManifestEntry(map) {
  return {
    file: REDIRECTS_FILE_NAME,
    revision: map.revision,
    entries: map.entries.length,
  };
}

/**
 * Records the revision the site reported after a successful replace, so the
 * next push is fenced against that state rather than the one before it.
 */
export async function advanceRedirectsManifest(workspaceDir, siteId, map) {
  const manifest = await readManifest(workspaceDir, siteId);
  requireRedirectsMetadata(manifest);
  if (!isRedirectMapRevision(map.revision)) {
    throw new SiteAuthoringError(
      "api.redirects_contract",
      "Taproot returned a redirect map whose revision could not be recorded.",
      { field: "revision" },
    );
  }
  manifest[REDIRECTS_MANIFEST_KEY] = redirectsManifestEntry(map);
  await writeManifest(workspaceDir, manifest);
  return map.revision;
}
