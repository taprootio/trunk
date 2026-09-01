import { CLI_BINARY_NAME, VERB_LOGOUT } from "../constants.js";
import { credentialApiOrigin, removeCredential } from "../credentials.js";
import { openAnonymousSession, successResult } from "../session.js";

/**
 * `taproot-site logout` — local discard, and nothing more.
 *
 * It removes the stored sign-in for this Taproot origin. It does not revoke
 * anything: the credential remains valid on the server until an owner revokes
 * it in Account -> Settings -> API keys, and saying otherwise would leave a
 * live credential someone believes is dead.
 *
 * Removing a credential that was never stored is a success, not a failure —
 * the state the caller asked for is the state they end up in — so the result
 * reports `removed: false` and exits 0. The credential is never read into a
 * message, a progress line, or the result.
 *
 * Like `login`, this needs no configuration and no site: the sign-in it
 * discards is addressed by API origin.
 */
export async function logout(invocation) {
  const { apiBaseUrl, onProgress } = await openAnonymousSession(invocation);
  const { path: credentialPath, removed } = await removeCredential(
    invocation.environment ?? process.env,
    credentialApiOrigin(apiBaseUrl),
  );
  onProgress(
    removed
      ? `Discarded the stored Taproot sign-in from ${credentialPath}.`
      : `No stored Taproot sign-in was found in ${credentialPath}.`,
  );
  if (removed) {
    onProgress(
      `This was a local discard only. The credential stays valid until it is revoked in `
        + `Account -> Settings -> API keys; '${CLI_BINARY_NAME} ${VERB_LOGOUT}' cannot revoke it.`,
    );
  }
  return successResult(VERB_LOGOUT, undefined, { removed, credentialPath });
}
