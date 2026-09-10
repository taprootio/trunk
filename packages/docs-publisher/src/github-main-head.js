import { awaitWithSignal } from "./abort.js";
import { PublisherError } from "./errors.js";

const GITHUB_API_BASE_URL = "https://api.github.com";
const GITHUB_SERVER_URL = "https://github.com";
const GITHUB_MAIN_REF = "refs/heads/main";
const GITHUB_API_VERSION = "2022-11-28";
const GITHUB_MAIN_HEAD_TIMEOUT_MILLISECONDS = 10_000;
const GITHUB_MAIN_HEAD_RESPONSE_BYTES = 16 * 1024;
const CANONICAL_REPOSITORY_ID = /^[1-9][0-9]{0,18}$/u;
const CANONICAL_REVISION = /^[0-9a-f]{40}$/u;
const GITHUB_LOCATOR = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/u;
const SAFE_TOKEN = /^[\x21-\x7e]{1,4096}$/u;

function contextFailure() {
  return new PublisherError(
    "github_main_head.context_invalid",
    "GitHub main-branch verification requires a trusted push workflow on main.",
  );
}

function provenanceFailure() {
  return new PublisherError(
    "github_main_head.provenance_invalid",
    "Artifact source provenance does not match the trusted GitHub workflow.",
  );
}

function tokenFailure() {
  return new PublisherError(
    "github_main_head.token_invalid",
    "GitHub main-branch verification requires a valid workflow token.",
  );
}

function isObject(value) {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}

function isAbortSignal(value) {
  return value === undefined || value instanceof AbortSignal;
}

function validateSource(source) {
  if (
    !isObject(source)
    || source.provider !== "github"
    || source.ref !== GITHUB_MAIN_REF
    || typeof source.repositoryId !== "string"
    || !CANONICAL_REPOSITORY_ID.test(source.repositoryId)
    || typeof source.repository !== "string"
    || !GITHUB_LOCATOR.test(source.repository)
    || source.repositoryUrl !== `${GITHUB_SERVER_URL}/${source.repository}`
    || typeof source.revision !== "string"
    || !CANONICAL_REVISION.test(source.revision)
  ) {
    throw provenanceFailure();
  }
  return source;
}

function validateContext(environment, source, fetch, signal) {
  if (
    !isObject(environment)
    || environment.GITHUB_ACTIONS !== "true"
    || environment.GITHUB_EVENT_NAME !== "push"
    || environment.GITHUB_REF !== GITHUB_MAIN_REF
    || environment.GITHUB_SERVER_URL !== GITHUB_SERVER_URL
    || environment.GITHUB_API_URL !== GITHUB_API_BASE_URL
  ) {
    throw contextFailure();
  }
  if (typeof fetch !== "function") {
    throw new PublisherError(
      "github_main_head.fetch_unavailable",
      "GitHub main-branch verification requires an HTTP client.",
    );
  }
  if (!isAbortSignal(signal)) {
    throw new PublisherError(
      "github_main_head.signal_invalid",
      "GitHub main-branch verification received an invalid cancellation signal.",
    );
  }
  const validatedSource = validateSource(source);
  if (
    environment.GITHUB_REPOSITORY_ID !== validatedSource.repositoryId
    || environment.GITHUB_REPOSITORY !== validatedSource.repository
    || environment.GITHUB_SHA !== validatedSource.revision
  ) {
    throw provenanceFailure();
  }
  const token = environment.GITHUB_TOKEN;
  if (
    typeof token !== "string"
    || !SAFE_TOKEN.test(token)
  ) {
    throw tokenFailure();
  }
  return { source: validatedSource, token };
}

function cancelledFailure() {
  return new PublisherError("publisher.cancelled", "The Docs publish operation was cancelled.");
}

function timeoutFailure() {
  return new PublisherError(
    "github_main_head.timeout",
    "GitHub main-branch verification exceeded its time limit.",
  );
}

function interruptedFailure(parentSignal, timeoutSignal, code, message) {
  if (parentSignal?.aborted) return cancelledFailure();
  if (timeoutSignal.aborted) return timeoutFailure();
  return new PublisherError(code, message);
}

function cancelReader(reader) {
  try {
    void Promise.resolve(reader.cancel?.()).catch(() => {});
  } catch {
    // Cleanup is best effort. A malformed reader must not extend the bounded
    // GitHub request after the response has already been rejected.
  }
}

async function readBoundedBody(response, signal, parentSignal, timeoutSignal) {
  const reader = response?.body?.getReader?.();
  if (!reader || typeof reader.read !== "function") {
    throw new PublisherError(
      "github_main_head.response_invalid",
      "GitHub returned an invalid main-branch response.",
    );
  }
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const next = await awaitWithSignal(reader.read(), signal);
      if (!isObject(next) || typeof next.done !== "boolean") {
        throw new PublisherError(
          "github_main_head.response_invalid",
          "GitHub returned an invalid main-branch response.",
        );
      }
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) {
        throw new PublisherError(
          "github_main_head.response_invalid",
          "GitHub returned an invalid main-branch response.",
        );
      }
      total += next.value.byteLength;
      if (total > GITHUB_MAIN_HEAD_RESPONSE_BYTES) {
        throw new PublisherError(
          "github_main_head.response_too_large",
          "GitHub returned an oversized main-branch response.",
        );
      }
      chunks.push(next.value);
    }
  } catch (error) {
    cancelReader(reader);
    if (error instanceof PublisherError) throw error;
    throw interruptedFailure(
      parentSignal,
      timeoutSignal,
      "github_main_head.response_read",
      "GitHub main-branch response could not be read.",
    );
  }
  return Buffer.concat(chunks, total);
}

function parseMainRef(bytes) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new PublisherError(
      "github_main_head.response_invalid",
      "GitHub returned an invalid main-branch response.",
    );
  }
  if (
    !isObject(value)
    || value.ref !== GITHUB_MAIN_REF
    || !isObject(value.object)
    || value.object.type !== "commit"
    || typeof value.object.sha !== "string"
    || !CANONICAL_REVISION.test(value.object.sha)
  ) {
    throw new PublisherError(
      "github_main_head.response_invalid",
      "GitHub returned an invalid main-branch response.",
    );
  }
  return value.object.sha;
}

/**
 * Creates the opt-in freshness check that is run directly before Docs staging.
 * Context validation is synchronous and the returned function is the only path
 * that performs the GitHub API read.
 */
export function createGitHubMainHeadGuard({
  environment,
  source,
  fetch = globalThis.fetch,
  signal,
} = {}) {
  const { source: validatedSource, token } = validateContext(environment, source, fetch, signal);
  const repositoryId = validatedSource.repositoryId;
  const sourceRevision = validatedSource.revision;
  const endpoint = `${GITHUB_API_BASE_URL}/repositories/${repositoryId}/git/ref/heads/main`;

  return async () => {
    const timeoutSignal = AbortSignal.timeout(GITHUB_MAIN_HEAD_TIMEOUT_MILLISECONDS);
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    if (signal?.aborted) throw cancelledFailure();

    let response;
    try {
      response = await awaitWithSignal(
        fetch(endpoint, {
          method: "GET",
          headers: new Headers({
            authorization: `Bearer ${token}`,
            accept: "application/vnd.github+json",
            "x-github-api-version": GITHUB_API_VERSION,
          }),
          redirect: "error",
          credentials: "omit",
          signal: requestSignal,
        }),
        requestSignal,
      );
    } catch {
      throw interruptedFailure(
        signal,
        timeoutSignal,
        "github_main_head.request_failed",
        "GitHub main-branch verification could not be completed.",
      );
    }
    if (requestSignal.aborted) {
      throw interruptedFailure(
        signal,
        timeoutSignal,
        "github_main_head.request_failed",
        "GitHub main-branch verification could not be completed.",
      );
    }
    if (response?.redirected === true) {
      throw new PublisherError(
        "github_main_head.redirect_rejected",
        "GitHub main-branch verification rejected a redirect response.",
      );
    }
    if (response?.status !== 200) {
      throw new PublisherError(
        "github_main_head.response_status",
        "GitHub did not return the main-branch reference.",
      );
    }
    const currentRevision = parseMainRef(await readBoundedBody(response, requestSignal, signal, timeoutSignal));
    return Object.freeze({
      currentRevision,
      superseded: currentRevision !== sourceRevision,
    });
  };
}
