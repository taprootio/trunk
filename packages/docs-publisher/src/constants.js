export const PUBLISHER_NAME = "@taprootio/docs-publisher";
export const PUBLISHER_VERSION = "1.5.0";
export const PUBLISH_RESULT_SCHEMA_VERSION = 2;
export const CONFIG_FILE_NAME = "taproot-docs-publisher.json";
export const CONFIG_VERSION = 2;
export const SUPPORTED_CONFIG_VERSIONS = Object.freeze([1, CONFIG_VERSION]);
export const ARTIFACT_SCHEMA_VERSION = 1;
export const ARTIFACT_PACKAGE_VERSION = "1.2.0";

// The two publication modes are selected explicitly and never inferred from an
// artifact directory, a manifest field, a site, or a hostname. Managed remains
// the default so an existing configuration keeps its exact behavior.
export const MODE_MANAGED = "managed";
export const MODE_PREBUILT = "prebuilt";
export const DEFAULT_PUBLICATION_MODE = MODE_MANAGED;

export const ARCHIVE_FORMAT_NAME = "taproot-docs-tar-gzip-v1";
export const PREBUILT_ARCHIVE_FORMAT_NAME = "taproot-docs-prebuilt-tar-gzip-v1";

export const PUBLICATION_MODE_WIRE_VALUES = Object.freeze({
  [MODE_MANAGED]: "DOCS_PUBLICATION_MODE_MANAGED",
  [MODE_PREBUILT]: "DOCS_PUBLICATION_MODE_PREBUILT",
});
export const ARCHIVE_FORMAT_WIRE_VALUES = Object.freeze({
  [MODE_MANAGED]: "DOCS_ARCHIVE_FORMAT_TAPROOT_DOCS_TAR_GZIP_V1",
  [MODE_PREBUILT]: "DOCS_ARCHIVE_FORMAT_TAPROOT_DOCS_PREBUILT_TAR_GZIP_V1",
});
export const ARCHIVE_FORMAT_NAMES = Object.freeze({
  [MODE_MANAGED]: ARCHIVE_FORMAT_NAME,
  [MODE_PREBUILT]: PREBUILT_ARCHIVE_FORMAT_NAME,
});

// An absent or UNSPECIFIED echoed mode is how a row or server that predates
// explicit mode identity reports managed. It never satisfies a prebuilt intent.
export const UNSTAMPED_WIRE_MODES = Object.freeze([
  undefined,
  null,
  "",
  "DOCS_PUBLICATION_MODE_UNSPECIFIED",
]);

export function isPublicationMode(value) {
  return value === MODE_MANAGED || value === MODE_PREBUILT;
}

export const ARCHIVE_CONTENT_TYPE = "application/gzip";
export const PUBLISH_KEY_ENVIRONMENT_VARIABLE = "TAPROOT_DOCS_PUBLISH_KEY";
export const DEFAULT_API_BASE_URL = "https://app.taproot.io/api";

export const LIMITS = Object.freeze({
  configBytes: 16 * 1024,
  configPathBytes: 4 * 1024,
  configDiscoveryParents: 32,
  artifactDirectoryPathBytes: 4 * 1024,
  compressedArchiveBytes: 256 * 1024 * 1024,
  apiResponseBytes: 1024 * 1024,
  requestMilliseconds: 60_000,
  uploadMilliseconds: 5 * 60_000,
  validationMilliseconds: 15 * 60_000,
  deploymentMilliseconds: 30 * 60_000,
  pollIntervalMilliseconds: 2_000,
  requestAttempts: 4,
  uploadIntents: 3,
  diagnosticScalars: 2_000,
  githubOutputBytes: 64 * 1024,
});

/**
 * The `google.rpc.ErrorInfo` reasons a Stage or Promote carries when the site
 * has hit a commercial ceiling no retry can clear (TR00445, TR01201): the
 * pages-generated-per-billing-period allowance, or the bandwidth pause. Wire identities matched
 * exactly, within the `sites.taproot.io` domain. The refusal names its class
 * `plan_limit` so a workflow can tell "upgrade or wait for the reset" from a
 * rejected request.
 */
export const PLAN_LIMIT_REFUSAL_DOMAIN = "sites.taproot.io";
export const PLAN_LIMIT_REFUSAL_REASONS = Object.freeze({
  DEPLOYMENT_PERIOD_ALLOWANCE_EXCEEDED: "the site's pages-generated allowance for this billing period is used",
  BANDWIDTH_ALLOWANCE_EXCEEDED: "new deployments are paused because the site used more than its monthly bandwidth for two months in a row",
});
export const REFUSAL_PLAN_LIMIT = "plan_limit";
