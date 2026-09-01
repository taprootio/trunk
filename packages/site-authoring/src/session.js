import {
  CLI_BINARY_NAME,
  CLI_NAME,
  CLI_VERSION,
  DEFAULT_API_BASE_URL,
  PUBLISH_KEY_ENVIRONMENT_VARIABLE,
  RESULT_SCHEMA_VERSION,
  VERB_LOGIN,
  VERB_USE,
} from "./constants.js";
import { loadSiteConfig } from "./config.js";
import {
  credentialApiOrigin,
  readCredentialStore,
  selectCredential,
  updateCredentialMetadata,
} from "./credentials.js";
import { SiteAuthoringError } from "./errors.js";
import { exchangeSiteAuthoringToken } from "./api.js";
import { SiteApiClient } from "./transport.js";
import { readStoredApiBaseUrl } from "./settings.js";

/**
 * The two things every verb does at its edges: open a credentialed session, and
 * shape the one machine-readable result that reaches stdout.
 *
 * Since TR00645 the credential a verb runs on is usually not the credential on
 * disk. What is stored is an account-scoped sign-in that authorizes nothing;
 * what a verb needs is a site credential, minted on demand by exchanging that
 * sign-in for one. The exchange happens here so no verb has to know it happened.
 *
 * The exchanged credential is held in memory for the life of the process and
 * never written down. That is deliberate: it expires within the hour, it is
 * cheap to mint again, and a short-lived secret in a file is a long-lived
 * secret in a backup.
 */

/** The optional seams a test (or a future caller) may inject. */
const CLIENT_OPTION_KEYS = ["fetch", "signal", "sleep", "now", "timeoutSignal"];

function progressSink(invocation) {
  return typeof invocation.onProgress === "function" ? invocation.onProgress : () => {};
}

function keyMissingError() {
  return new SiteAuthoringError(
    "auth.key_missing",
    `No Taproot sign-in is available. Run '${CLI_BINARY_NAME} ${VERB_LOGIN}' to authorize this CLI, `
      + `or set ${PUBLISH_KEY_ENVIRONMENT_VARIABLE} to a site-scoped Taproot site authoring key.`,
  );
}

function siteMissingError() {
  return new SiteAuthoringError(
    "config.site_missing",
    `No site is selected. Run '${CLI_BINARY_NAME} ${VERB_USE} <site>' to choose one, `
      + "or set siteId in taproot-site.json.",
  );
}

async function loadConfig(invocation) {
  return await loadSiteConfig({
    cwd: invocation.cwd ?? process.cwd(),
    configPath: invocation.configPath,
  });
}

function buildClientOptions(invocation, apiBaseUrl, token) {
  const clientOptions = { apiBaseUrl, ...(token === undefined ? {} : { token }) };
  for (const key of CLIENT_OPTION_KEYS) {
    if (invocation[key] !== undefined) clientOptions[key] = invocation[key];
  }
  return clientOptions;
}

/**
 * The stored sign-in for the configured origin, or a refusal naming `login`.
 *
 * Read before the configuration, and that ordering is load bearing: "there is
 * no credential anywhere" is knowable without a configuration, and answering it
 * first preserves the long-standing promise that a credential-less invocation
 * stops before reading config, resolving a workspace path, or building a
 * request.
 */
async function requireSignIn(environment, resolveApiBaseUrl) {
  const store = await readCredentialStore(environment);
  // Emptiness is answered before the configuration is resolved at all. That
  // ordering is a promise, not an optimization: a credential-less invocation
  // must stop before reading config, resolving a workspace path, or building a
  // request, and answering "no credential anywhere" needs none of those.
  if (store.credentials.length === 0) throw keyMissingError();
  const stored = selectCredential(store.credentials, credentialApiOrigin(await resolveApiBaseUrl()));
  if (stored === undefined) throw keyMissingError();
  return stored;
}

/**
 * Opens an account-authorized session: the sign-in credential itself, used for
 * the two things it can do. Never used to author.
 */
export async function openAccountSession(invocation = {}) {
  const environment = invocation.environment ?? process.env;
  // Tolerates a missing configuration for the same reason `login` does: `sites`
  // and `use` are what an operator runs *before* there is one, and requiring
  // the file they exist to produce would be a loop.
  let resolved;
  const signIn = await requireSignIn(environment, async () => {
    resolved = await openAnonymousSession({ ...invocation, client: null });
    return resolved.apiBaseUrl;
  });
  const { config, apiBaseUrl } = resolved;
  const client = invocation.client
    ?? new SiteApiClient(buildClientOptions(invocation, apiBaseUrl, signIn.key));
  return {
    config,
    apiBaseUrl,
    client,
    signIn,
    now: invocation.now ?? Date.now,
    onProgress: progressSink(invocation),
  };
}

/**
 * Opens a site-authorized session for the configured site.
 *
 * Two credential sources, in the one order that keeps existing automation
 * unaffected:
 *
 * `TAPROOT_SITE_KEY` wins outright and byte-for-byte, and skips the exchange
 * entirely. CI and non-interactive agents set it deliberately, and a stored
 * sign-in silently overriding it would be the worst kind of surprise. Presence
 * is authoritative even when the value is empty or malformed — including CI
 * that masked a missing secret into an empty string — because an operator who
 * set the variable meant that credential and no other; falling through would
 * run the command as a different identity. The transport rejects an unusable
 * value with a clear code instead.
 *
 * There is deliberately no second environment variable for the sign-in
 * credential. One override, one precedence rule.
 */
/**
 * Which Taproot to talk to. Machine state, then the production default — the
 * project has no say since TR00645, so every session path resolves it here
 * rather than reaching into a config field that no longer exists.
 */
export async function resolveApiBaseUrl(environment) {
  return (await readStoredApiBaseUrl(environment)) ?? DEFAULT_API_BASE_URL;
}

export async function openSession(invocation = {}) {
  const environment = invocation.environment ?? process.env;
  const onProgress = progressSink(invocation);
  const now = invocation.now ?? Date.now;

  // The endpoint is resolved inside each branch, not ahead of both. The
  // stored-sign-in branch promises to answer "no credential anywhere" before
  // it reads anything else, and the machine settings file is something else:
  // resolving it first would turn an empty store plus a malformed settings
  // file into a settings error, in front of the one answer that needs no file
  // at all.
  const environmentToken = environment?.[PUBLISH_KEY_ENVIRONMENT_VARIABLE];
  if (environmentToken !== undefined) {
    const apiBaseUrl = await resolveApiBaseUrl(environment);
    const config = await loadConfig(invocation);
    if (!config.siteId) throw siteMissingError();
    const client = invocation.client
      ?? new SiteApiClient(buildClientOptions(invocation, apiBaseUrl, environmentToken));
    return { config, client, siteId: config.siteId, now, onProgress };
  }

  let config;
  let apiBaseUrl;
  const signIn = await requireSignIn(environment, async () => {
    apiBaseUrl = await resolveApiBaseUrl(environment);
    config = await loadConfig(invocation);
    return apiBaseUrl;
  });
  if (!config.siteId) throw siteMissingError();

  // The server is the authority on expiry, so an expired sign-in is still sent
  // — the clock here may simply be wrong. What is worth saying out loud is that
  // the credential is already past the expiry it recorded, so a refusal that
  // follows is explained rather than mysterious.
  if (signIn.keyExpiresAt !== undefined && Date.parse(signIn.keyExpiresAt) <= now()) {
    onProgress(
      `The stored sign-in expired at ${signIn.keyExpiresAt}. `
        + `If Taproot refuses it, run '${CLI_BINARY_NAME} ${VERB_LOGIN}' again.`,
    );
  }

  // A caller may supply the site client directly (tests, and the verbs that
  // already hold one); otherwise the sign-in is exchanged for one.
  if (invocation.client) {
    return { config, client: invocation.client, siteId: config.siteId, now, onProgress };
  }

  const accountClient = new SiteApiClient(buildClientOptions(invocation, apiBaseUrl, signIn.key));
  const exchanged = await exchangeSiteAuthoringToken(accountClient, {
    siteId: config.siteId,
    capabilities: invocation.capabilities ?? [],
  });
  // Two non-secret facts the store should now carry: the sign-in's slid
  // deadline, and what this exchange actually produced — the latter is the only
  // thing that lets `whoami` answer offline with the real grant rather than the
  // ceiling.
  //
  // A compare-and-set, not a save: the record was read before a network round
  // trip, and in that window a concurrent logout may have removed it or a
  // login replaced it. Writing the pre-flight copy back would resurrect a
  // discarded credential or overwrite a newer one.
  //
  // Best-effort: failing a command because its *metadata* could not be recorded
  // would trade a working run for a cosmetic accuracy, and the next exchange
  // tries again.
  try {
    await updateCredentialMetadata(
      environment,
      credentialApiOrigin(apiBaseUrl),
      signIn.keyId,
      {
        ...(exchanged.signInExpiresAt === undefined ? {} : { keyExpiresAt: exchanged.signInExpiresAt }),
        lastExchange: {
          siteId: exchanged.siteId,
          capabilities: exchanged.capabilities,
          expiresAt: exchanged.expiresAt,
        },
      },
    );
  } catch {
    // Deliberately swallowed; see above.
  }

  const client = new SiteApiClient(buildClientOptions(invocation, apiBaseUrl, exchanged.key));
  return {
    config,
    client,
    siteId: config.siteId,
    exchanged: {
      keyId: exchanged.keyId,
      keyPrefix: exchanged.keyPrefix,
      expiresAt: exchanged.expiresAt,
      capabilities: exchanged.capabilities,
    },
    now,
    onProgress,
  };
}

/**
 * The credential-free half of the session seam, for the verbs that manage the
 * credential rather than use it.
 *
 * Since TR00645 `login` needs no site and therefore no configuration at all:
 * the account sign-in is addressed by API origin, which has a default. So the
 * configuration is loaded when one is discoverable and quietly skipped when it
 * is not — which is what lets `npm i -g` then `login` work in any directory.
 */
export async function openAnonymousSession(invocation = {}) {
  let config;
  try {
    config = await loadConfig(invocation);
  } catch (error) {
    // Only "there is no configuration here" is tolerated, and only when the
    // caller did not name one. Every other config failure — malformed JSON, a
    // duplicate key, an unsafe workspace path, an unreviewed API origin —
    // surfaces. Swallowing those would silently fall back to the production
    // origin and let  overwrite a configuration written for another one.
    if (invocation.configPath !== undefined) throw error;
    if (!(error instanceof SiteAuthoringError) || error.code !== "config.not_found") throw error;
    config = undefined;
  }

  // The endpoint comes from the machine, not the project (TR00645). It has to:
  // `login`, `sites`, and `use` all run before a project configuration exists,
  // so a project-pinned endpoint could never have told the first of them where
  // to go.
  const apiBaseUrl = await resolveApiBaseUrl(invocation.environment ?? process.env);
  // `client: null` is how openAccountSession borrows the config resolution
  // without paying for an anonymous client it will immediately replace.
  const client = invocation.client === null
    ? undefined
    : invocation.client ?? SiteApiClient.anonymous(buildClientOptions(invocation, apiBaseUrl));
  return {
    config,
    apiBaseUrl,
    client,
    now: invocation.now ?? Date.now,
    onProgress: progressSink(invocation),
  };
}

/**
 * Bounds a list that is about to travel in a result. The result must fit
 * `LIMITS.githubOutputBytes`, and an unbounded per-item report over a large
 * site would blow that bound and turn a successful run into an
 * `output.too_large` failure — losing the record of work that already
 * happened. Truncation is reported, never silent.
 */
export function boundedList(values, maximum) {
  const items = values.slice(0, maximum);
  return items.length === values.length
    ? { items, count: values.length }
    : { items, count: values.length, truncated: true };
}

export function successResult(verb, siteId, payload = {}) {
  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    ok: true,
    cli: { name: CLI_NAME, version: CLI_VERSION },
    verb,
    ...(siteId === undefined ? {} : { siteId }),
    ...payload,
  };
}
