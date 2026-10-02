/**
 * Site paths the platform reserves on every site host.
 *
 * The published-site Worker ships the immutable runtime as static assets at
 * `/taproot/<semver>/...` (TR01144), and Cloudflare answers a matching request
 * before the Worker runs, so a page or redirect authored there could never be
 * reached. This is the one place the package owns that prefix; page push and
 * the redirect map both ask here. The API is the authority and mirrors the rule
 * in `PublishedOutputPaths.IsRuntimeMirrorPath`; both are pinned by the same
 * test vectors.
 */
const RUNTIME_MIRROR_PATH =
  /^taproot\/[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\/|$)/iu;

/** Whether a site-relative path (no leading slash) is `taproot/<semver>` or under it. */
export function isRuntimeMirrorPath(path) {
  return RUNTIME_MIRROR_PATH.test(path);
}

export const RUNTIME_MIRROR_PATH_REASON =
  "'/taproot/<version>/' is reserved for the published-site runtime, which the platform answers before any page "
  + "or redirect, so nothing under it can be authored.";
