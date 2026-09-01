import {
  CLI_BINARY_NAME,
  DEFAULT_API_BASE_URL,
  ENVIRONMENT_LOCAL,
  ENVIRONMENT_PRODUCTION,
  VERB_ENV,
  VERB_LOGIN,
} from "../constants.js";
import { credentialApiOrigin, findCredential } from "../credentials.js";
import { SiteAuthoringError } from "../errors.js";
import {
  environmentNameFor,
  readStoredApiBaseUrl,
  resolveEnvironmentSelector,
  settingsPath,
  writeStoredApiBaseUrl,
} from "../settings.js";
import { successResult } from "../session.js";

/**
 * `taproot-site env [production|local|<url>]` — which Taproot to talk to.
 *
 * With no argument it reports; with one it switches. Switching writes nothing
 * but the endpoint: credentials are stored per origin, so moving between
 * environments and back finds the sign-in that was already there rather than
 * discarding it.
 */
export async function env(invocation) {
  const environment = invocation.environment ?? process.env;
  const selector = typeof invocation.environmentSelector === "string"
    ? invocation.environmentSelector.trim()
    : undefined;
  const onProgress = invocation.onProgress ?? (() => {});

  const current = (await readStoredApiBaseUrl(environment)) ?? DEFAULT_API_BASE_URL;
  const apiBaseUrl = selector === undefined ? current : resolveApiBaseUrl(selector);

  // The credential store is read *before* the switch is written, though it is
  // only needed for the report afterwards. A corrupt store refuses; if that
  // refusal came after the write, the command would exit non-zero having
  // silently repointed every later command at a different Taproot — the
  // worst combination, a failure that changed something. Read first, nothing
  // changes on failure.
  const { credential } = await findCredential(environment, credentialApiOrigin(apiBaseUrl));

  if (selector !== undefined && apiBaseUrl !== current) {
    await writeStoredApiBaseUrl(environment, apiBaseUrl);
  }

  // Reported for both forms, because "which Taproot am I pointed at, and am I
  // signed in to it" is the actual question behind running this at all — and
  // after a switch the answer usually changes.
  const name = environmentNameFor(apiBaseUrl);

  if (selector === undefined) {
    onProgress(`Talking to ${name} (${credentialApiOrigin(apiBaseUrl)}).`);
  } else if (apiBaseUrl === current) {
    onProgress(`Already talking to ${name} (${credentialApiOrigin(apiBaseUrl)}).`);
  } else {
    onProgress(`Now talking to ${name} (${credentialApiOrigin(apiBaseUrl)}).`);
  }
  onProgress(
    credential === undefined
      ? `Not signed in there yet — run '${CLI_BINARY_NAME} ${VERB_LOGIN}'.`
      : `Signed in there as account ${credential.accountId}.`,
  );

  return successResult(VERB_ENV, undefined, {
    environment: name,
    apiOrigin: credentialApiOrigin(apiBaseUrl),
    signedIn: credential !== undefined,
    settingsPath: settingsPath(environment),
    changed: selector !== undefined && apiBaseUrl !== current,
  });
}

function resolveApiBaseUrl(selector) {
  try {
    return resolveEnvironmentSelector(selector);
  } catch {
    throw new SiteAuthoringError(
      "env.unknown",
      `'${selector}' is not a Taproot this CLI talks to. `
        + `Use '${CLI_BINARY_NAME} ${VERB_ENV} ${ENVIRONMENT_PRODUCTION}', `
        + `'${CLI_BINARY_NAME} ${VERB_ENV} ${ENVIRONMENT_LOCAL}', or an explicit loopback URL ending in '/api'.`,
      { field: "environmentSelector", exitCode: 2 },
    );
  }
}
