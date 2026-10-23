import { HEX_DIGEST } from "./constants.js";
import { SiteAuthoringError } from "./errors.js";
import { NAVIGATION_FILE_NAME, readManifest, writeManifest } from "./workspace.js";

/**
 * The navigation tree's workspace baseline (TR01231).
 *
 * `nav push` replaces the whole tree, so a push built on a stale read would
 * silently delete an item added in the app since. The manifest therefore
 * records the revision the tree was read at, exactly as it does for the
 * redirect map, and a push that cannot produce one refuses toward pull rather
 * than guessing.
 */

export function isNavigationRevision(value) {
  return typeof value === "string" && HEX_DIGEST.test(value);
}

function pullRequired(message, field) {
  return new SiteAuthoringError("nav.pull_required", message, { field });
}

/** The manifest entry `pull` writes for a freshly read tree. */
export function navigationManifestEntry({ navItems, revision }) {
  return { file: NAVIGATION_FILE_NAME, items: navItems.length, ...(isNavigationRevision(revision) ? { revision } : {}) };
}

/** The recorded revision, or a refusal that says to pull. */
export function requireNavigationBaseline(manifest) {
  const navigation = manifest.navigation;
  if (navigation === null || typeof navigation !== "object" || Array.isArray(navigation)) {
    throw pullRequired(
      "The pull manifest does not record the navigation tree. Run 'taproot-site pull' again.",
      "navigation",
    );
  }
  if (!isNavigationRevision(navigation.revision)) {
    throw pullRequired(
      "The pull manifest records no navigation revision, so a push could not tell whether the tree changed on the "
        + "site since. Run 'taproot-site pull' again.",
      "navigation.revision",
    );
  }
  return navigation.revision;
}

/** The refusal for a tree that moved since the pull; nothing was written. */
export function navigationMovedRefusal() {
  return new SiteAuthoringError(
    "nav.concurrent_modification",
    "The navigation changed on the site after this workspace read it, so nothing was written. Keep a copy of the "
      + `edited ${NAVIGATION_FILE_NAME}, run 'taproot-site pull' to refresh it, re-apply the edits, and push again.`,
    { field: "revision" },
  );
}

/**
 * Records the revision the site reported after a successful save, so the next
 * push is fenced against that state rather than the one before it.
 */
export async function advanceNavigationManifest(workspaceDir, siteId, { navItems, revision }) {
  const manifest = await readManifest(workspaceDir, siteId);
  requireNavigationBaseline(manifest);
  if (!isNavigationRevision(revision)) {
    throw new SiteAuthoringError(
      "api.navigation_contract",
      "Taproot returned a navigation tree whose revision could not be recorded.",
      { field: "revision" },
    );
  }
  manifest.navigation = navigationManifestEntry({ navItems, revision });
  await writeManifest(workspaceDir, manifest);
}
