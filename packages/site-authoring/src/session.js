import {
  CLI_BINARY_NAME,
  CLI_NAME,
  CLI_VERSION,
  DEFAULT_API_BASE_URL,
  EXTERNAL_WRITES_SETTING_KEY,
  EXTERNAL_WRITES_SETTING_LOCATION,
  PUBLISH_KEY_ENVIRONMENT_VARIABLE,
  REFUSAL_PLATFORM_PAUSED,
  RESULT_SCHEMA_VERSION,
  ROLLOUT_REFUSAL_FIELD,
  VERB_LOGIN,
  VERB_USE,
} from "./constants.js";
import { loadSiteConfig } from "./config.js";
import { cliOutdatedError, compareCliVersions, isBehindLatest } from "./cli-release.js";
import {
  credentialApiOrigin,
  readCredentialStore,
  selectCredential,
  updateCredentialMetadata,
} from "./credentials.js";
import { SiteAuthoringError } from "./errors.js";
import { exchangeSiteAuthoringToken, withRefusalGuidance } from "./api.js";
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

/**
 * What a session knows about the platform's authoring rollout switch when
 * nothing told it (TR00692).
 *
 * Three states, not two, and the third is the honest one: `TAPROOT_SITE_KEY`
 * skips the exchange entirely and no other read on the contract exposes the
 * switch, so those runs know nothing about it. Collapsing unknown into "paused"
 * would warn on every write against a healthy platform; collapsing it into
 * "enabled" would claim a fact nobody supplied.
 */
const UNKNOWN_PLATFORM = Object.freeze({ externalWritesEnabled: undefined });

/**
 * What a session knows about the latest published release when nothing told it
 * (TR00703) — the same three-state shape, and unknown for the same reasons: a
 * `TAPROOT_SITE_KEY` run never exchanges, and a Taproot that predates the field
 * answers with nothing.
 */
const UNKNOWN_CLI_RELEASE = Object.freeze({ latestVersion: undefined });

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
    // No exchange happens on this path, and nothing else on the contract reads
    // the platform switch — so its state is genuinely unknown here rather than
    // assumed. Reporting it as enabled would be a guess, and reporting it as
    // paused would warn on every write against a healthy platform.
    return {
      config,
      client,
      siteId: config.siteId,
      platform: UNKNOWN_PLATFORM,
      release: UNKNOWN_CLI_RELEASE,
      now,
      onProgress,
    };
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
    return {
      config,
      client: invocation.client,
      siteId: config.siteId,
      platform: UNKNOWN_PLATFORM,
      release: UNKNOWN_CLI_RELEASE,
      now,
      onProgress,
    };
  }

  const accountClient = new SiteApiClient(buildClientOptions(invocation, apiBaseUrl, signIn.key));
  // Announced here, not left to the generic failure line. The exchange is the
  // first request every site verb makes and it sits outside each verb's own
  // `withRefusalGuidance`, so a refusal raised by it used to reach the operator
  // as a field name and nothing else. That matters most for `cli_outdated`,
  // whose whole remedy is a command the operator has to be handed (TR00703),
  // but it is true of every classified refusal the exchange can raise.
  const exchanged = await withRefusalGuidance(
    onProgress,
    "sign-in token exchange",
    async () =>
      await exchangeSiteAuthoringToken(accountClient, {
        siteId: config.siteId,
        capabilities: invocation.capabilities ?? [],
      }),
  );
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
          // When this exchange happened, so `whoami` can date what it reports
          // rather than presenting a snapshot as current fact. Recorded for
          // every exchange, not only the ones that saw a platform state, so the
          // field has one meaning.
          at: new Date(now()).toISOString(),
          ...(exchanged.externalWritesEnabled === undefined
            ? {}
            : { externalWritesEnabled: exchanged.externalWritesEnabled }),
          // The latest published release Taproot named (TR00703). Recorded for
          // the offline verbs, which have no request to be refused and would
          // otherwise keep validating against a contract that has moved.
          ...(exchanged.latestCliVersion === undefined
            ? {}
            : { latestCliVersion: exchanged.latestCliVersion }),
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
    platform: Object.freeze({ externalWritesEnabled: exchanged.externalWritesEnabled }),
    release: Object.freeze({ latestVersion: exchanged.latestCliVersion }),
    now,
    onProgress,
  };
}

/**
 * Refuses an offline verb when the last exchange said a newer CLI exists
 * (TR00703).
 *
 * **Only for the verbs that make no request.** `help`, `validate`, and `whoami`
 * are the whole set: every other verb reaches the server, and the server's own
 * refusal is both authoritative and better informed than this recording. Gating
 * them here would only duplicate an answer — and gating `login`, `logout`, or
 * `env` would break the commands an operator needs *while* they are outdated.
 *
 * **Best effort, and silent on every uncertainty.** Nothing recorded proceeds,
 * so a clean machine can still validate a fixture. A store this process cannot
 * read or parse proceeds too: an unreadable file is not evidence that this CLI
 * is behind, and turning a corrupt store into a refusal to run `help` would
 * take away the command that explains how to fix it. Only a recorded version
 * this side can parse and compare stops anything.
 *
 * The store holds one record per API origin, and the highest recorded version
 * across all of them is what counts. npm publishes one package: whichever
 * Taproot last answered, it was naming the same registry, so the newest answer
 * is the current fact rather than a per-origin opinion. Taking the maximum also
 * keeps a stale development Taproot from masking production's answer.
 */
export async function assertCliCurrent(environment = process.env) {
  let store;
  try {
    store = await readCredentialStore(environment);
  } catch {
    // Deliberately swallowed; see above.
    return undefined;
  }
  let latest;
  for (const credential of store.credentials) {
    const recorded = credential.lastExchange?.latestCliVersion;
    if (recorded === undefined) continue;
    if (latest === undefined || (compareCliVersions(recorded, latest) ?? 0) > 0) latest = recorded;
  }
  if (latest === undefined || !isBehindLatest(latest)) return undefined;
  throw cliOutdatedError(latest);
}

/**
 * The one pre-write warning: the platform has external site authoring paused,
 * so this verb's write is going to be refused (TR00692).
 *
 * **Advisory, never a gate.** The value is a snapshot the token exchange took
 * before this run did any work, and the authority is still the transactional
 * freeze inside the write itself — so a paused platform warns and then proceeds
 * exactly as before, and the refusal that follows keeps its `platform_paused`
 * classification for automation to branch on. An operator who flipped the
 * switch back on between the exchange and the write gets their write.
 *
 * Silent in the two cases that are not "paused": enabled, and unknown. Unknown
 * is the `TAPROOT_SITE_KEY` path, which never exchanges and therefore was never
 * told — see {@link UNKNOWN_PLATFORM}.
 *
 * **Contract.** Call it once, immediately after `openSession` and before any
 * validation, reading, or wire work, passing the whole session object and the
 * verb's own name (its `VERB_*` constant). It prints at most one progress line
 * and returns whether it printed one; it never throws, never reads, and never
 * changes what the verb does next.
 *
 * @param {{ platform?: { externalWritesEnabled?: boolean }, onProgress?: (message: string) => void }} session
 *   The session `openSession` returned.
 * @param {string} [verb] The verb's display name, for the warning's first clause.
 * @returns {boolean} Whether a warning was printed.
 */
export function warnIfExternalWritesPaused(session, verb = "This write") {
  // The guard settles both questions: only a session object can carry `false`
  // here, so nothing below needs to defend against a missing one.
  if (session?.platform?.externalWritesEnabled !== false) return false;
  const onProgress = progressSink(session);
  onProgress(
    `WARNING: Taproot has external site authoring paused platform-wide, so '${verb}' is expected to be refused `
      + `at the write (refusal=${REFUSAL_PLATFORM_PAUSED}, field=${ROLLOUT_REFUSAL_FIELD}). The credential and the `
      + `request are both fine. A Taproot administrator re-enables it with the platform setting `
      + `'${EXTERNAL_WRITES_SETTING_KEY}' (${EXTERNAL_WRITES_SETTING_LOCATION}). Continuing anyway: this is what `
      + "Taproot reported when this run's credential was exchanged, and the write itself is the authority.",
  );
  return true;
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
