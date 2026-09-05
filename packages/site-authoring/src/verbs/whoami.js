import {
  CLI_BINARY_NAME,
  CLI_UPGRADE_COMMAND,
  CLI_VERSION,
  EXTERNAL_WRITES_SETTING_KEY,
  EXTERNAL_WRITES_SETTING_LOCATION,
  PUBLISH_KEY_ENVIRONMENT_VARIABLE,
  VERB_LOGIN,
  VERB_STATUS,
  VERB_USE,
  VERB_WHOAMI,
} from "../constants.js";
import { isBehindLatest } from "../cli-release.js";
import { credentialApiOrigin, findCredential } from "../credentials.js";
import { SITE_AUTHORING_CAPABILITIES } from "../capabilities.js";
import { openAnonymousSession, successResult } from "../session.js";
import { environmentNameFor } from "../settings.js";

/**
 * What the last exchange recorded about the platform authoring switch, dated
 * with that exchange (TR00692).
 *
 * Never presented as the current state: this verb makes no request, so the
 * value is as old as the last exchange, and `status` is where a current answer
 * comes from. A record written before the field existed says so plainly rather
 * than reading as "enabled".
 */
function platformLine(lastExchange) {
  const when = lastExchange.at === undefined ? "at that exchange" : `as of ${lastExchange.at}`;
  if (lastExchange.externalWritesEnabled === undefined) {
    return `Platform authoring switch: not recorded by that exchange. Run '${CLI_BINARY_NAME} ${VERB_STATUS}' `
      + "for a current answer.";
  }
  return lastExchange.externalWritesEnabled
    ? `Platform authoring switch ${when}: external site authoring writes were enabled. This is a recording, not a `
      + `live read; run '${CLI_BINARY_NAME} ${VERB_STATUS}' for the current answer.`
    : `Platform authoring switch ${when}: external site authoring writes were PAUSED platform-wide. A Taproot `
      + `administrator re-enables the platform setting '${EXTERNAL_WRITES_SETTING_KEY}' `
      + `(${EXTERNAL_WRITES_SETTING_LOCATION}). This is a recording, not a live read; run `
      + `'${CLI_BINARY_NAME} ${VERB_STATUS}' for the current answer.`;
}

/**
 * The latest published CLI release that exchange recorded (TR00703), dated the
 * same way and for the same reason.
 *
 * A run that is actually behind never reaches here — the gate in `runCli`
 * refuses `whoami` outright — so this line is what a *current* CLI reads as
 * confirmation, and what a CLI whose store predates the field reads as "not
 * recorded". It is still stated as a recording rather than as live fact,
 * because that is what it is.
 */
function cliReleaseLine(lastExchange) {
  if (lastExchange.latestCliVersion === undefined) {
    return `Latest CLI release: not recorded by that exchange. This CLI is ${CLI_VERSION}; run `
      + `'${CLI_BINARY_NAME} ${VERB_STATUS}' for a current answer.`;
  }
  const when = lastExchange.at === undefined ? "at that exchange" : `as of ${lastExchange.at}`;
  return isBehindLatest(lastExchange.latestCliVersion)
    ? `Latest CLI release ${when}: ${lastExchange.latestCliVersion}. This CLI is ${CLI_VERSION} and is behind it; `
      + `Taproot accepts only the latest. Upgrade with: ${CLI_UPGRADE_COMMAND}`
    : `Latest CLI release ${when}: ${lastExchange.latestCliVersion}. This CLI is ${CLI_VERSION}.`;
}

/**
 * `taproot-site whoami` — which Taproot, which account, which site, until when.
 *
 * Answers offline, on purpose. Everything it reports is already known locally:
 * the sign-in record carries the account, the credential id, its display
 * prefix, and its expiry; the configuration carries the site; and what an
 * exchanged credential may do is a property of the shipped envelope rather than
 * of any particular credential. Asking the server would make the one command an
 * operator reaches for when something is wrong depend on the thing that might
 * be wrong.
 *
 * The credential itself is never printed — only its id and display prefix,
 * which are the values an owner needs to find and revoke it.
 */
export async function whoami(invocation) {
  const environment = invocation.environment ?? process.env;
  const { config, apiBaseUrl, onProgress } = await openAnonymousSession({ ...invocation, client: null });
  const apiOrigin = credentialApiOrigin(apiBaseUrl);
  const { path: credentialPath, credential } = await findCredential(environment, apiOrigin);

  // Reported, not resolved. An operator debugging a permission surprise needs
  // to know the environment override is in play; printing its value would put
  // a live credential in a terminal and a scrollback buffer.
  const environmentOverride = environment?.[PUBLISH_KEY_ENVIRONMENT_VARIABLE] !== undefined;

  const now = (invocation.now ?? Date.now)();
  const expired = credential?.keyExpiresAt !== undefined && Date.parse(credential.keyExpiresAt) <= now;

  onProgress(`Taproot: ${apiOrigin} (${environmentNameFor(apiBaseUrl)})`);
  if (environmentOverride) {
    onProgress(
      `${PUBLISH_KEY_ENVIRONMENT_VARIABLE} is set, so commands use that site credential and skip the sign-in.`,
    );
  }
  if (credential === undefined) {
    onProgress(`Not signed in. Run '${CLI_BINARY_NAME} ${VERB_LOGIN}'.`);
  } else {
    onProgress(`Account: ${credential.accountId}`);
    onProgress(`Sign-in: ${credential.keyPrefix} (id ${credential.keyId})`);
    onProgress(
      credential.keyExpiresAt === undefined
        ? "Sign-in expiry: none recorded."
        : `Sign-in ${expired ? "expired" : "expires"}: ${credential.keyExpiresAt}`,
    );
  }
  onProgress(
    config?.siteId
      ? `Site: ${config.siteId}`
      : `No site selected. Run '${CLI_BINARY_NAME} ${VERB_USE} <site>'.`,
  );
  // What the last exchange actually produced, when there has been one. That is
  // the honest answer to "what can this do", and it is recorded locally so this
  // stays offline. The ceiling is reported as the ceiling, never as the grant.
  const lastExchange = credential?.lastExchange;
  if (environmentOverride) {
    onProgress(
      `${PUBLISH_KEY_ENVIRONMENT_VARIABLE} supplies the site credential directly, so what it can do is whatever `
        + "it was issued with — this command cannot tell you.",
    );
  } else if (lastExchange === undefined) {
    onProgress(
      "No site credential has been exchanged yet. Each command mints one carrying only what that command "
        + `needs, never more than: ${SITE_AUTHORING_CAPABILITIES.join(", ")}.`,
    );
  } else {
    const lapsed = Date.parse(lastExchange.expiresAt) <= now;
    onProgress(`Last exchanged for site ${lastExchange.siteId}: ${lastExchange.capabilities.join(", ")}.`);
    onProgress(
      `That credential ${lapsed ? "expired" : "expires"} ${lastExchange.expiresAt}`
        + `${lapsed ? "; the next command mints another." : "."}`,
    );
    // The platform authoring switch as of that exchange, dated (TR00692). It is
    // reported as a recording rather than as the current state, because this
    // command is offline by design and an operator reading an undated flag
    // would take a snapshot from last week for a fact about right now.
    onProgress(platformLine(lastExchange));
    onProgress(cliReleaseLine(lastExchange));
  }

  return successResult(VERB_WHOAMI, config?.siteId, {
    apiOrigin,
    // Named as well as spelled out, so "am I on local right now" is answerable
    // without the reader knowing which origin is which.
    environment: environmentNameFor(apiBaseUrl),
    signedIn: credential !== undefined,
    environmentOverride,
    ...(credential === undefined ? {} : {
      accountId: credential.accountId,
      keyId: credential.keyId,
      keyPrefix: credential.keyPrefix,
      ...(credential.keyExpiresAt === undefined ? {} : { keyExpiresAt: credential.keyExpiresAt, expired }),
      credentialPath,
    }),
    ...(config?.configPath === undefined ? {} : { configPath: config.configPath }),
    // Named for what each is. `capabilities` alone would conflate the ceiling
    // with the grant, which are different numbers and differently trustworthy.
    capabilityCeiling: SITE_AUTHORING_CAPABILITIES,
    ...(environmentOverride || lastExchange === undefined ? {} : {
      lastExchange: {
        siteId: lastExchange.siteId,
        capabilities: lastExchange.capabilities,
        expiresAt: lastExchange.expiresAt,
        expired: Date.parse(lastExchange.expiresAt) <= now,
        // Both absent on a record written before TR00692, and
        // `externalWritesEnabled` also absent when the server that answered the
        // exchange predated the field. Absent means "not recorded", never
        // "enabled": an automation that wants a current answer reads
        // `platform` off `status`, which says which of the three states it is.
        ...(lastExchange.at === undefined ? {} : { at: lastExchange.at }),
        ...(lastExchange.externalWritesEnabled === undefined
          ? {}
          : { externalWritesEnabled: lastExchange.externalWritesEnabled }),
        // Absent on a record written before TR00703, and on one whose server
        // predated the field. Absent means "not recorded", never "current".
        ...(lastExchange.latestCliVersion === undefined
          ? {}
          : { latestCliVersion: lastExchange.latestCliVersion }),
      },
    }),
    ...(environmentOverride ? { capabilitiesKnown: false } : {}),
  });
}
