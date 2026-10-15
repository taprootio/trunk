/**
 * Site paths the platform reserves on every site host.
 *
 * The published-site Worker ships the immutable runtime as static assets at
 * `/taproot/<semver>/...` (TR01144), and Cloudflare answers a matching request
 * before the Worker runs, so a page or redirect authored there could never be
 * reached. This is the one place the package owns that prefix; page push and
 * the redirect map both ask here. The API is the authority
 * (`PublishedOutputPaths.IsRuntimeMirrorPath`); both pass the site-check corpus.
 */
// The rule itself lives in the shared site-check source, which the redirect source rules also read.
export { isRuntimeMirrorPath } from "./site-checks.js";

export const RUNTIME_MIRROR_PATH_REASON =
  "'/taproot/<version>/' is reserved for the published-site runtime, which the platform answers before any page "
  + "or redirect, so nothing under it can be authored.";
