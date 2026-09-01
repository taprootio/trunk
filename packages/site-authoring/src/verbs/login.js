import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
  claimCliAuthorization,
  CLI_AUTHORIZATION_CLAIM_STATUS_CONSUMED,
  CLI_AUTHORIZATION_CLAIM_STATUS_DENIED,
  CLI_AUTHORIZATION_CLAIM_STATUS_EXPIRED,
  CLI_AUTHORIZATION_CLAIM_STATUS_ISSUED,
  CLI_AUTHORIZATION_CLAIM_STATUS_PENDING,
  poll,
  startCliAuthorization,
} from "../api.js";
import {
  AUTHORIZE_CLI_PATH,
  CLI_BINARY_NAME,
  DEFAULT_LOGIN_KEY_NAME,
  LIMITS,
  LOGIN_KEY_NAME_MAXIMUM,
  REFUSAL_PLATFORM_PAUSED,
  REFUSAL_THROTTLED,
  VERB_LOGIN,
  VERB_LOGOUT,
  VERB_SITES,
} from "../constants.js";
import { assertCredentialCapacity, credentialApiOrigin, saveCredential } from "../credentials.js";
import { asSiteAuthoringError, hasControlCharacter, SiteAuthoringError } from "../errors.js";
import { openAnonymousSession, successResult } from "../session.js";
import { ApiError } from "../transport.js";

/**
 * `taproot-site login` — the CLI half of the device-authorization exchange.
 *
 * The shape of the flow is what keeps the secret out of every place it should
 * not be. The CLI starts an authorization with no credential of its own, prints
 * a URL the owner opens in a browser they already trust, and polls with a
 * high-entropy device code. The credential is minted at claim time and crosses
 * the wire exactly once, straight into a `0600` file the operator never has to
 * see. It reaches no clipboard, no shell history, no stdout, no stderr, and no
 * result — the success payload names the credential by id and display prefix
 * only.
 *
 * The approval URL is composed here from the already-reviewed API origin and
 * never taken from a response, so a compromised or misconfigured server cannot
 * steer an owner to somewhere else to approve a credential.
 *
 * **What TR00645 changed.** This used to authorize one site, named up front by
 * a configuration file the operator had to hand-write before they could log in
 * at all. It now authorizes the account, so it needs no site, no configuration,
 * and no prior knowledge of anything — `npm i -g` then `login` works in any
 * directory. What it mints is exchange-only: it lists sites and swaps itself
 * for short-lived site credentials, and authorizes no write anywhere.
 *
 * This is also the one remaining mint in the CLI whose response cannot be
 * recovered if it is lost, which is why the orphan-handling below survives here
 * and was removed from the exchange path. It happens once a day, in one place,
 * with a human watching.
 */

const CLAIM_THROTTLED = Symbol("cli authorization claim throttled");
const CLAIM_LOST = Symbol("cli authorization claim response lost");

/**
 * The claim failures that mean "the answer never usefully made it back", not
 * "the claim was refused": a connection that died *after the request was on
 * the wire*, a retry budget spent on dead connections, a 2xx body that could
 * not be read, parsed, or fit in the response bound; an ISSUED payload whose fields failed validation, where the
 * mint has definitely committed; or an answer this client's vocabulary cannot
 * read at all (`login.claim_contract` — a non-object envelope, an absent
 * status, a status value from a newer server). A serializer or version-skew
 * fault produces those AFTER the handler committed, so none of them may
 * abort behind a generic error. All of them keep the poll alive: the next
 * successful claim answers CONSUMED and names the exact credential to revoke,
 * and a deadline reached instead carries the MAY-have-been-issued guidance.
 * Server-side 5xx answers are the same shape of loss and are handled beside
 * these in the read's catch — they arrive as ApiError, not by code.
 */
const CLAIM_LOSS_CODES = new Set([
  "transport.mutation_ambiguous",
  "transport.retry_exhausted",
  "transport.invalid_json",
  "transport.response_read",
  "transport.response_too_large",
  "login.claim_unusable",
  "login.claim_contract",
]);

/**
 * A claim that provably never reached Taproot: the name did not resolve, the
 * connection was refused, the certificate was not trusted. The poll continues
 * exactly as for a lost answer — the approval may still be coming — but
 * nothing is armed, because nothing was sent and so nothing could have minted.
 * Treating this as a possible orphan sent operators to Settings to revoke a
 * credential that never existed, over a certificate their machine did not
 * trust.
 */
const CLAIM_UNDELIVERED_CODES = new Set(["transport.network"]);

/**
 * Bidirectional embedding/override (U+202A–U+202E) and isolate (U+2066–U+2069)
 * code points — text carrying them can display other than as written. The
 * server refuses them on the same field; refusing here keeps the failure local
 * and immediate instead of a wire round trip.
 */
const BIDI_CONTROL = /[‪-‮⁦-⁩]/u;

/**
 * The name recorded on the issued credential, which the approval screen shows
 * the owner before they approve. Trimmed, bounded, and free of control and bidi
 * characters: it is authored on a command line and displayed in a browser.
 */
export function normalizeKeyName(value) {
  if (value === undefined) return DEFAULT_LOGIN_KEY_NAME;
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (
    trimmed.length === 0 || trimmed.length > LOGIN_KEY_NAME_MAXIMUM || hasControlCharacter(trimmed)
    || BIDI_CONTROL.test(trimmed)
  ) {
    throw new SiteAuthoringError(
      "login.key_name_invalid",
      `--name must be 1 to ${LOGIN_KEY_NAME_MAXIMUM} printable characters.`,
      { field: "keyName", exitCode: 2 },
    );
  }
  return trimmed;
}

/**
 * The browser page, on the application origin the API base URL already pins.
 * `apiBaseUrl` is the `/api` endpoint on that same origin, so the path prefix
 * is dropped deliberately: the approval screen is an application route.
 *
 * The URL carries no code, on purpose. The owner types the code from this
 * terminal into the page — that entry is the device flow's phishing defence,
 * proving the person at the browser can see the CLI that asked. A prefilled
 * link would reduce approval to one click on a URL anyone could have sent.
 */
export function verificationUrlFor(apiBaseUrl) {
  return new URL(AUTHORIZE_CLI_PATH, credentialApiOrigin(apiBaseUrl)).toString();
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function describeMinutes(milliseconds) {
  const minutes = Math.round(milliseconds / 60_000);
  return minutes <= 1 ? "about a minute" : `about ${minutes} minutes`;
}

/**
 * The terminal refusals, each with the one thing the owner should do next.
 * `consumed` is the loudest because it is the only outcome that leaves a live
 * credential nobody holds: the claim minted one and its response was lost, so
 * the credential exists, this CLI never received it, and it can only be
 * revoked — named by its exact id and display prefix when the server supplied
 * them, and by its display name otherwise.
 */
function terminalFailure(answer, keyName) {
  const status = answer.status;
  switch (status) {
    case CLI_AUTHORIZATION_CLAIM_STATUS_DENIED:
      return new SiteAuthoringError(
        "login.denied",
        "The authorization was denied in the browser. No credential was issued and nothing was stored.",
        { status },
      );
    case CLI_AUTHORIZATION_CLAIM_STATUS_EXPIRED:
      return new SiteAuthoringError(
        "login.expired",
        `The authorization expired before it was approved. Run '${CLI_BINARY_NAME} ${VERB_LOGIN}' again.`,
        { status },
      );
    case CLI_AUTHORIZATION_CLAIM_STATUS_CONSUMED:
      return new SiteAuthoringError(
        "login.consumed",
        "This authorization was already claimed, so a credential WAS issued but this command never received it. "
          + (answer.keyId !== undefined
            ? `Revoke the credential with id ${answer.keyId}`
            + (answer.keyPrefix === undefined ? "" : ` (display prefix ${answer.keyPrefix})`)
            : `Revoke the credential named '${keyName}'`)
          + ` under Account -> Settings -> API keys, then run '${CLI_BINARY_NAME} ${VERB_LOGIN}' again.`,
        { status },
      );
    default:
      return new SiteAuthoringError(
        "login.claim_contract",
        "Taproot returned an unsupported CLI authorization claim status.",
        { field: "status", status },
      );
  }
}

function translateClaimApiError(error) {
  if (!(error instanceof ApiError) || error.httpStatus !== 404) return error;
  return new SiteAuthoringError(
    "login.unknown",
    `Taproot does not recognize this authorization. Run '${CLI_BINARY_NAME} ${VERB_LOGIN}' to start a new one.`,
    { status: error.status },
  );
}

/**
 * The start endpoint is unauthenticated and rate-limited by network address, so
 * its throttle is not a statement about any credential. The shared refusal
 * guidance would say "this credential exceeded its request budget", which is
 * both wrong and misleading here — there is no credential yet.
 */
function translateStartApiError(error) {
  if (!(error instanceof ApiError) || error.refusalKind() !== REFUSAL_THROTTLED) return error;
  return new SiteAuthoringError(
    "login.throttled",
    "Taproot is rate limiting CLI authorization requests from this network. Wait a moment and try again.",
    { status: error.status },
  );
}

/**
 * A storage failure after the claim is the one local outcome that leaves a
 * live credential nobody holds: the server minted it and the CLI could not keep
 * it. The refusal must say exactly that — naming the credential by id and
 * display prefix, never by value — and direct the owner to revoke it, because
 * silence here is a live credential the owner does not know exists.
 */
function unstoredCredentialFailure(error, claimed) {
  const cause = asSiteAuthoringError(error);
  return new SiteAuthoringError(
    "login.credential_unstored",
    `A credential WAS issued (id ${claimed.keyId}, display prefix ${claimed.keyPrefix}) but could not `
      + `be stored: ${cause.message} Revoke it under Account -> Settings -> API keys, then run `
      + `'${CLI_BINARY_NAME} ${VERB_LOGIN}' again.`,
    { ...(cause.status === undefined ? {} : { status: cause.status }) },
  );
}

/**
 * Opens the approval page in the operator's browser.
 *
 * Spawned detached with its streams ignored, because the opener is a launcher
 * rather than a program to wait on: `open` returns immediately, but a desktop
 * environment's `xdg-open` can outlive the shell that started it, and inheriting
 * stdio would let it scribble over the code the operator is reading.
 *
 * The URL is the one this CLI composed from the reviewed origin. Nothing from a
 * response reaches a command line here.
 */
async function openInBrowser(url) {
  const [command, arguments_] = process.platform === "darwin"
    ? ["open", [url]]
    : process.platform === "win32"
    ? ["cmd", ["/c", "start", "", url]]
    : ["xdg-open", [url]];
  await new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, { stdio: "ignore", detached: true });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

/**
 * Waits for Enter on a terminal, and never anywhere else.
 *
 * Returns false when stdin is not a TTY — a CI job, a pipe, an agent harness —
 * so the prompt degrades to a printed URL instead of a command that hangs
 * forever on input nobody is there to give.
 */
async function awaitEnterOnTty(input = process.stdin) {
  if (!input.isTTY) return false;
  await new Promise((resolve) => {
    const readline = createInterface({ input, terminal: false });
    readline.once("line", () => {
      readline.close();
      resolve();
    });
    readline.once("close", resolve);
  });
  return true;
}

/**
 * The interactive hand-off, in the order the operator has to act in.
 *
 * The code comes first and alone, because copying it is the step that has to
 * happen before the browser takes the foreground — the gh-style ordering. The
 * page still accepts no code from the URL: what is opened is the bare approval
 * page, so the typed entry that proves the approver can see this terminal is
 * intact.
 *
 * Every path prints the URL somewhere. An opener that is missing or refuses
 * must not strand someone with a code and nowhere to type it.
 */
async function handOffToBrowser({ verificationUrl, userCode, onProgress, awaitEnter, openUrl }) {
  onProgress(`First, copy this code: ${userCode}`);

  if (!await awaitEnter()) {
    // Not a terminal: no one is going to press anything.
    onProgress(`Then open this URL in a browser signed in to Taproot: ${verificationUrl}`);
    return;
  }

  try {
    await openUrl(verificationUrl);
    onProgress(`Opened ${verificationUrl}`);
  } catch {
    onProgress(`Could not open a browser. Open this URL yourself: ${verificationUrl}`);
  }
}

export async function login(invocation) {
  const keyName = normalizeKeyName(invocation.keyName);
  const { apiBaseUrl, client, now, onProgress } = await openAnonymousSession(invocation);
  const environment = invocation.environment ?? process.env;
  const apiOrigin = credentialApiOrigin(apiBaseUrl);

  // Preflight the store before anything is minted: an unreadable, corrupt, or
  // symlinked store refuses here, where no credential exists yet, instead of
  // after the claim, where the same refusal would orphan a live credential the
  // operator then has to revoke by hand. The projection covers the size bound
  // too, pessimistically — a store with no room left for this record refuses
  // now rather than at the write, which is the same failure arriving after the
  // damage. A residual write failure can still happen (the disk can fill during
  // the poll), which is what `unstoredCredentialFailure` below is for.
  await assertCredentialCapacity(environment, apiOrigin);

  let authorization;
  try {
    authorization = await startCliAuthorization(client, { keyName });
  } catch (error) {
    throw translateStartApiError(error);
  }

  const verificationUrl = verificationUrlFor(apiBaseUrl);
  const deadlineMilliseconds = Math.min(authorization.expiresInSeconds * 1_000, LIMITS.loginMaximumMilliseconds);
  const intervalMilliseconds = clamp(
    authorization.pollIntervalSeconds * 1_000,
    LIMITS.loginPollIntervalMinimumMilliseconds,
    LIMITS.loginPollIntervalMaximumMilliseconds,
  );

  // The interactive hand-off. Every line here is load bearing — the URL and
  // code reach the operator only through these progress lines, which is why
  // the CLI refuses `--quiet` for this verb outright rather than silencing
  // the one thing the command cannot complete without.
  onProgress(`Authorizing this CLI as '${keyName}'.`);
  await handOffToBrowser({
    verificationUrl,
    userCode: authorization.userCode,
    onProgress,
    awaitEnter: invocation.awaitEnter
      ?? (async () => {
        // Asked only once it is known someone can answer: printing "press
        // Enter" into a CI log is an instruction nobody can follow.
        if (!process.stdin.isTTY) return false;
        onProgress("Press Enter to open the authorization URL.");
        return await awaitEnterOnTty();
      }),
    openUrl: invocation.openUrl ?? openInBrowser,
  });
  onProgress(
    `Waiting for approval. This request expires in ${describeMinutes(deadlineMilliseconds)}; press Ctrl+C to stop.`,
  );

  let claimResponseLost = false;
  let claimed;
  try {
    claimed = await poll({
      client,
      now,
      onProgress,
      timeoutMilliseconds: deadlineMilliseconds,
      intervalMilliseconds,
      // Deliberately NOT forwarding poll()'s {deadline} into the claim: the
      // claim is the one read whose success mints a credential server-side, and
      // a final-window claim squeezed into the remaining wall budget could
      // consume the authorization while this side aborts or discards the
      // response — a silently orphaned credential. Each claim gets the
      // transport's full per-request budget; poll()'s own loop still bounds
      // total wall time.
      read: async () => {
        try {
          return await claimCliAuthorization(client, authorization.deviceCode);
        } catch (error) {
          // A throttle is the endpoint doing its job, not a verdict on this
          // authorization. Back off within the same deadline instead of
          // abandoning an approval the owner may already be looking at.
          if (error instanceof ApiError && error.refusalKind() === REFUSAL_THROTTLED) return CLAIM_THROTTLED;
          // A 5xx — even one that survived the transport's own retries — is the
          // server or a proxy failing to answer, not refusing. The handler may
          // have committed the mint before its response pipeline fell over, so
          // this too is a lost answer, never a generic abort. Classified
          // refusals are handled around it: the collapsed 404 and throttles
          // above, and a platform-paused 503 — the one deliberate 5xx this
          // codebase speaks — falls through to abort as the authoritative
          // refusal it is.
          if (
            error instanceof ApiError
            && error.refusalKind() !== REFUSAL_PLATFORM_PAUSED
            && typeof error.httpStatus === "number" && error.httpStatus >= 500
          ) {
            claimResponseLost = true;
            return CLAIM_LOST;
          }
          // An answer lost between the server and this process is not a verdict
          // either — and it is the one failure that may have committed a mint
          // this side never saw. Aborting here would hide that credential
          // behind a generic transport error; continuing lets the next
          // successful claim answer CONSUMED, which carries the revoke guidance
          // the owner needs.
          if (error instanceof SiteAuthoringError && CLAIM_LOSS_CODES.has(error.code)) {
            claimResponseLost = true;
            return CLAIM_LOST;
          }
          // Undelivered is the one loss that does not arm: the request never
          // left, so the flag that says "a mint may have happened" would be
          // a lie, and a lie in the direction of sending someone to revoke.
          if (error instanceof SiteAuthoringError && CLAIM_UNDELIVERED_CODES.has(error.code)) {
            return CLAIM_LOST;
          }
          // A Ctrl+C inside a claim is ambiguous only when the transport says
          // so. It tags each cancellation with whether a mutation may already
          // have run — an abort mid-flight or after a lost answer, yes; an
          // abort during backoff after nothing but certificate failures, no,
          // because no request ever left. Arming on every cancellation sent
          // operators to Settings to revoke a credential that provably did not
          // exist. The single upgrade to the orphan-naming message happens
          // where the poll is awaited, which also covers a cancellation
          // between polls after an earlier answer was lost.
          if (error instanceof SiteAuthoringError && error.code === "site.cancelled") {
            if (error.ambiguousMutation === true) claimResponseLost = true;
            throw error;
          }
          throw translateClaimApiError(error);
        }
      },
      evaluate: (value) => {
        if (value === CLAIM_THROTTLED) {
          return { done: false, progress: "Taproot is rate limiting the check; waiting before the next one." };
        }
        if (value === CLAIM_LOST) {
          return { done: false, progress: "A check's answer was lost; retrying." };
        }
        if (value.status === CLI_AUTHORIZATION_CLAIM_STATUS_ISSUED) return { done: true, value: value.credential };
        if (value.status === CLI_AUTHORIZATION_CLAIM_STATUS_PENDING) {
          // A readable PENDING is authoritative proof that no earlier claim
          // consumed the authorization: a consumed record can never answer
          // PENDING again. Whatever answer was lost before this, it minted
          // nothing — so the ambiguity flag resets, and a later timeout or
          // cancellation speaks plainly instead of warning about a credential
          // that provably does not exist. A loss after this sets it again.
          claimResponseLost = false;
          // Silent: this fires every few seconds for up to fifteen minutes, and
          // each line pushes the code the operator is still reading off screen.
          return { done: false };
        }
        throw terminalFailure(value, keyName);
      },
      // A deadline reached after a lost answer cannot honestly say nothing was
      // issued: one of those lost checks may have consumed the approval and
      // minted. The message must send the owner to look, the way every other
      // possible-orphan path here does.
      timeoutError: () =>
        claimResponseLost
          ? new SiteAuthoringError(
            "login.timeout",
            "The polling deadline passed, and at least one check's answer was lost in transit — a credential "
              + `MAY have been issued without this command receiving it. Nothing was stored locally; check `
              + `Account -> Settings -> API keys for a credential named '${keyName}' and revoke it before running `
              + `'${CLI_BINARY_NAME} ${VERB_LOGIN}' again.`,
          )
          : new SiteAuthoringError(
            "login.timeout",
            "The approval was not completed before this command's polling deadline. Nothing was stored; "
              + `run '${CLI_BINARY_NAME} ${VERB_LOGIN}' again.`,
          ),
    });
  } catch (error) {
    // The one upgrade site for an ambiguous cancellation. It catches both a
    // Ctrl+C that interrupted an in-flight claim (the read marks the loss and
    // rethrows) and one that landed between polls after an earlier answer was
    // lost — including poll()'s own inter-poll sleep, which rejects with the
    // generic cancellation and never passes through the read at all. A
    // cancellation with no lost answer keeps the generic sentence: nothing
    // ambiguous happened.
    if (error instanceof SiteAuthoringError && error.code === "site.cancelled" && claimResponseLost) {
      throw new SiteAuthoringError(
        "site.cancelled",
        "The login was cancelled after a claim's answer was lost — a credential MAY have been issued without "
          + `this command receiving it. Check Account -> Settings -> API keys for a credential named '${keyName}' `
          + `and revoke it before running '${CLI_BINARY_NAME} ${VERB_LOGIN}' again.`,
      );
    }
    throw error;
  }

  let credentialPath;
  try {
    credentialPath = await saveCredential(
      environment,
      {
        apiOrigin,
        accountId: claimed.accountId,
        key: claimed.key,
        keyId: claimed.keyId,
        keyPrefix: claimed.keyPrefix,
        ...(claimed.keyExpiresAt === undefined ? {} : { keyExpiresAt: claimed.keyExpiresAt }),
      },
      { now },
    );
  } catch (error) {
    throw unstoredCredentialFailure(error, claimed);
  }
  onProgress(`Stored the sign-in in ${credentialPath}. The credential itself is never displayed.`);
  onProgress(`Run '${CLI_BINARY_NAME} ${VERB_SITES}' to see the sites you can author.`);
  onProgress(
    `Discard it locally with '${CLI_BINARY_NAME} ${VERB_LOGOUT}'; revoke it in Account -> Settings -> API keys.`,
  );

  return successResult(VERB_LOGIN, undefined, {
    accountId: claimed.accountId,
    keyId: claimed.keyId,
    keyPrefix: claimed.keyPrefix,
    ...(claimed.keyExpiresAt === undefined ? {} : { keyExpiresAt: claimed.keyExpiresAt }),
    userCode: authorization.userCode,
    verificationUrl,
    credentialPath,
  });
}
