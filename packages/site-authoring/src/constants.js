export const CLI_NAME = "@taprootio/site-authoring";
export const CLI_VERSION = "0.3.0";
export const CLI_BINARY_NAME = "taproot-site";
export const RESULT_SCHEMA_VERSION = 1;
export const CONFIG_FILE_NAME = "taproot-site.json";
export const CONFIG_VERSION = 1;
export const CANONICAL_TIMESTAMP =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{3}|\.\d{6}|\.\d{9})?Z$/u;

// The site-scoped authoring key is read only from the environment. There is no
// flag, no config field, and no prompt: a credential on the command line lands
// in shell history, `ps` output, and CI logs, and a credential in the config
// file lands in the repository.
export const PUBLISH_KEY_ENVIRONMENT_VARIABLE = "TAPROOT_SITE_KEY";
export const DEFAULT_API_BASE_URL = "https://app.taproot.io/api";

// The one other Taproot that exists. `env` names these rather than making an
// operator type a URL, because the two of them are the whole set and a typo in
// the third component of a hostname is the kind of mistake that silently
// authors against the wrong place.
export const LOCAL_API_BASE_URL = "https://app.taproot.test/api";
export const ENVIRONMENT_PRODUCTION = "production";
export const ENVIRONMENT_LOCAL = "local";

// Which Taproot the CLI talks to, remembered per machine rather than per
// project (TR00645).
//
// It was a `taproot-site.json` field first, and that was the wrong home. The
// endpoint has to be known *before* any project exists — `login`, `sites`, and
// `use` all run before the file `use` writes — so pinning it in the project
// meant hand-writing a configuration purely to say "talk to local", including
// a `workspaceDir` that none of those verbs use. It is a property of the
// machine an operator is sitting at, not of the site they happen to be
// authoring, so it lives with the credential it is meaningless without.
export const SETTINGS_FILE_NAME = "settings.json";
export const SETTINGS_VERSION = 1;
export const SETTINGS_FILE_MODE = 0o644;

// The credential `login` writes and `logout` removes. It lives under the user's
// configuration directory, never in the repository: a credential inside the
// working tree is one `git add -A` away from being published, and one shared
// checkout away from being someone else's.
export const CREDENTIAL_DIRECTORY_NAME = "taproot-site";
export const CREDENTIAL_FILE_NAME = "credentials.json";
// Bumped by TR00645: the store went from many site credentials to one
// account sign-in per origin, which is a different record entirely. A v1
// store is refused with a message naming `login` rather than migrated —
// the CLI is unpublished, so the only v1 stores are in this repository, and
// a migration path would be code that exists for nobody.
export const CREDENTIAL_STORE_VERSION = 2;
export const CREDENTIAL_DIRECTORY_MODE = 0o700;
export const CREDENTIAL_FILE_MODE = 0o600;

// The browser page the CLI prints. It is composed from the reviewed API origin
// and never taken from a response, so a compromised or misconfigured server
// cannot steer an owner to somewhere else to approve a credential.
export const AUTHORIZE_CLI_PATH = "/authorize-cli";

/**
 * The workspace directory `use` writes into a configuration it creates
 * (TR00645).
 *
 * A real child directory rather than ".", because `validateWorkspaceDirectoryText`
 * rejects a "." segment: the workspace must be *beneath* the configuration, so
 * that pulling a site can never scatter page files over whatever else lives
 * beside taproot-site.json.
 */
export const DEFAULT_WORKSPACE_DIR = "site";
export const DEFAULT_LOGIN_KEY_NAME = "Site authoring CLI";
export const LOGIN_KEY_NAME_MAXIMUM = 100;

export const GITHUB_OUTPUT_RESULT_KEY = "taproot_site_result";
export const GITHUB_OUTPUT_KEY_PREFIX = "taproot_site";

// The verbs this binary accepts, in help order. The CLI matches the longest
// token sequence, so a two-token family ("pages push") never collides with a
// one-token verb.
export const VERB_PULL = "pull";
export const VERB_HELP = "help";
export const VERB_VALIDATE = "validate";
export const VERB_LOGIN = "login";
export const VERB_LOGOUT = "logout";
export const VERB_PAGES_PUSH = "pages push";
export const VERB_NAV_PUSH = "nav push";
export const VERB_THEME_PUSH = "theme push";
export const VERB_FOOTER_PUSH = "footer push";
export const VERB_MEDIA_UPLOAD = "media upload";
export const VERB_APPROVE = "approve";
export const VERB_DEPLOY = "deploy";
export const VERB_PREVIEW_PAGE = "preview page";
export const VERB_PREVIEW_REVOKE = "preview revoke";
export const VERB_STATUS = "status";
export const VERB_SITES = "sites";
export const VERB_USE = "use";
export const VERB_WHOAMI = "whoami";
export const VERB_ENV = "env";

export const DEPLOY_TARGET_STAGING = "staging";
export const DEPLOY_TARGET_PRODUCTION = "production";

/**
 * The refusal vocabulary TR00602/TR00603/TR00691 speak, collapsed into the five
 * distinct client behaviors plus an explicit "we do not know" value. The CLI
 * keeps these apart because an agent's correct next move differs for each:
 * see `ApiError.refusalKind()` in transport.js.
 */
export const REFUSAL_PLATFORM_PAUSED = "platform_paused";
export const REFUSAL_CREDENTIAL_REJECTED = "credential_rejected";
export const REFUSAL_PLAN_LIMIT = "plan_limit";
export const REFUSAL_THROTTLED = "throttled";
export const REFUSAL_CAPABILITY_MISSING = "capability_missing";
export const REFUSAL_UNCLASSIFIED = "unclassified";

export const REFUSAL_KINDS = Object.freeze([
  REFUSAL_PLATFORM_PAUSED,
  REFUSAL_CREDENTIAL_REJECTED,
  REFUSAL_PLAN_LIMIT,
  REFUSAL_THROTTLED,
  REFUSAL_CAPABILITY_MISSING,
  REFUSAL_UNCLASSIFIED,
]);

// The validation field names the API refuses with. They are wire identities,
// not display strings, so they are matched case-insensitively but never
// reworded.
export const ROLLOUT_REFUSAL_FIELD = "SiteAuthoringRollout";
export const CREDENTIAL_REFUSAL_FIELD = "ExternalApiKey";
export const PLAN_LIMIT_REFUSAL_FIELD = "UpgradePrompt";

/**
 * The `google.rpc.ErrorInfo` reason a key-mode permission denial carries
 * (TR00691, `SiteAuthoringKeyDenial` on the server). A wire identity, matched
 * exactly.
 */
export const CAPABILITY_REFUSAL_REASON = "SITE_AUTHORING_CAPABILITY_MISSING";

/**
 * The `field` a capability refusal reports on the JSON error.
 *
 * The server sends this refusal as `ErrorInfo`, not as a field violation — the
 * request is well formed and the credential is too narrow, so a `BadRequest`
 * would misstate the status. Automation still wants one shape to branch on, so
 * the CLI names the field itself, exactly as `platform_paused` carries
 * `SiteAuthoringRollout`. It is the CLI's own label rather than a value read
 * off the wire, which is why nothing matches an incoming field against it.
 */
export const CAPABILITY_REFUSAL_FIELD = "GrantedCapabilities";

// gRPC `ResourceExhausted`. Transcoded responses carry the numeric code in the
// body; the HTTP mapping is 429.
export const GRPC_RESOURCE_EXHAUSTED = 8;
export const HTTP_TOO_MANY_REQUESTS = 429;

// gRPC `Unauthenticated`, and its HTTP mapping. The authority resolver refuses
// a bad credential with a bare status and no field violation at all, so status
// is the only thing there is to classify on: see `ApiError.refusalKind()`.
export const GRPC_UNAUTHENTICATED = 16;
export const HTTP_UNAUTHORIZED = 401;

export const LIMITS = Object.freeze({
  configBytes: 16 * 1024,
  configPathBytes: 4 * 1024,
  // One version and one URL. Anything larger is not this file.
  settingsBytes: 4 * 1024,
  configDiscoveryParents: 32,
  workspacePathBytes: 4 * 1024,
  apiResponseBytes: 1024 * 1024,
  requestMilliseconds: 60_000,
  uploadMilliseconds: 5 * 60_000,
  deploymentMilliseconds: 30 * 60_000,
  previewMilliseconds: 5 * 60_000,
  pollIntervalMilliseconds: 2_000,
  requestAttempts: 4,
  uploadAttempts: 4,
  diagnosticScalars: 2_000,
  githubOutputBytes: 64 * 1024,
  credentialsBytes: 64 * 1024,
  // The store's read-modify-write is serialized by an exclusive lock file so two
  // overlapping logins (or a login racing a logout) cannot discard each other's
  // records — the store holds one record per API origin, so concurrent writes
  // across origins are real. Contention is human-scale and brief; the bound
  // exists so a crashed process's leftover lock fails loudly instead of hanging.
  credentialLockAttempts: 20,
  credentialLockRetryMilliseconds: 100,
  // The login poll takes its wait and its cadence from the authorization the
  // server actually issued (`expiresInSeconds`, `pollIntervalSeconds`) rather
  // than from a constant here, because the server owns that policy. These are
  // the walls that value is clamped between, so a wrong or hostile response
  // cannot turn one interactive sign-in into an unbounded wait or a poll fast
  // enough to trip the endpoint's own rate limiter.
  loginMaximumMilliseconds: 30 * 60_000,
  loginPollIntervalMinimumMilliseconds: 2_000,
  loginPollIntervalMaximumMilliseconds: 60_000,
});
