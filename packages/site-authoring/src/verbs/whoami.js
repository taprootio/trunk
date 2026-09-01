import { CLI_BINARY_NAME, PUBLISH_KEY_ENVIRONMENT_VARIABLE, VERB_LOGIN, VERB_USE, VERB_WHOAMI } from "../constants.js";
import { credentialApiOrigin, findCredential } from "../credentials.js";
import { SITE_AUTHORING_CAPABILITIES } from "../capabilities.js";
import { openAnonymousSession, successResult } from "../session.js";
import { environmentNameFor } from "../settings.js";

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
      },
    }),
    ...(environmentOverride ? { capabilitiesKnown: false } : {}),
  });
}
