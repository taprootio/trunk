import {
  CAPABILITY_REFUSAL_FIELD,
  CAPABILITY_REFUSAL_REASON,
  CLI_NAME,
  CLI_VERSION,
  CREDENTIAL_REFUSAL_FIELD,
  GRPC_RESOURCE_EXHAUSTED,
  GRPC_UNAUTHENTICATED,
  HTTP_TOO_MANY_REQUESTS,
  HTTP_UNAUTHORIZED,
  LIMITS,
  PLAN_LIMIT_REFUSAL_FIELD,
  PUBLISH_KEY_ENVIRONMENT_VARIABLE,
  REFUSAL_CAPABILITY_MISSING,
  REFUSAL_CREDENTIAL_REJECTED,
  REFUSAL_PLAN_LIMIT,
  REFUSAL_PLATFORM_PAUSED,
  REFUSAL_THROTTLED,
  REFUSAL_UNCLASSIFIED,
  ROLLOUT_REFUSAL_FIELD,
} from "./constants.js";
import { validateApiBaseUrl } from "./config.js";
import { hasControlCharacter, SiteAuthoringError } from "./errors.js";

// Every method the authoring verbs need. `pages push` updates with PATCH, page
// deletion is DELETE, and `nav push` replaces the whole tree with PUT.
const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

// Only GET may be replayed on the general API surface. None of the ordinary
// authoring mutations carry an idempotency key — TR00602 defined none — so a
// replayed POST duplicates a page, a replayed PATCH re-applies an update over an edit
// that landed in between, a replayed DELETE removes a resource the first
// attempt already removed, and a replayed navigation PUT re-asserts a tree
// after someone else changed it. An ambiguous mutation is reported as
// ambiguous, never guessed at. The one PUT that *is* replayed is the
// presigned whole-object upload in `upload()`, which writes immutable bytes
// to one key and is therefore genuinely idempotent. Two POSTs have their own
// narrow `replaceablePost()` entry point, each because its own server contract
// answers a replay rather than duplicating work: see
// `REPLACEABLE_POST_PATHS` below.
const IDEMPOTENT_METHODS = new Set(["GET"]);

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_RESPONSE_ERRORS = new Set([
  "transport.invalid_json",
  "transport.response_read",
]);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
/**
 * Error codes that prove a request never reached the server: the name did not
 * resolve, the connection was refused or never established, or the TLS
 * handshake failed. None of them can leave a mutation half-applied, because
 * none of them got as far as sending one.
 *
 * Deliberately a list of the provable cases rather than a guess at the rest. A
 * socket that dies mid-flight *is* ambiguous, and quietly reclassifying that as
 * "never happened" is the one mistake here with real consequences.
 */
const UNDELIVERED_CAUSE_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
]);

function transportCauseCode(error) {
  const code = error?.cause?.code ?? error?.code;
  return typeof code === "string" ? code : undefined;
}

function isUndelivered(error) {
  const code = transportCauseCode(error);
  return code !== undefined && UNDELIVERED_CAUSE_CODES.has(code);
}

/**
 * The underlying cause, named.
 *
 * `fetch` reports every one of these as "fetch failed", so discarding the cause
 * — which this did — left a certificate problem, a typo in a hostname, and a
 * server that is simply down producing one identical sentence. Only the code is
 * surfaced, never the message: codes are a fixed vocabulary, while messages can
 * carry a URL and this text reaches logs.
 */
function describeTransportCause(error) {
  const code = transportCauseCode(error);
  if (code === undefined || !SAFE_CAUSE_CODE.test(code)) return undefined;
  return code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" || code === "SELF_SIGNED_CERT_IN_CHAIN"
      || code === "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" || code === "DEPTH_ZERO_SELF_SIGNED_CERT"
    ? `${code}: the server's TLS certificate was not trusted`
    : code;
}

const SAFE_CAUSE_CODE = /^[A-Z0-9_]{1,64}$/u;

// Exported because the credential store's pre-mint size projection has to
// stand in for a key it has not been issued yet, and the only honest
// stand-in is the longest one this bound would accept.
export const MAXIMUM_TOKEN_LENGTH = 512;
const MAXIMUM_UPLOAD_URL_LENGTH = 16_384;
const MAXIMUM_UPLOAD_HEADERS = 64;
const MAXIMUM_HEADER_VALUE_LENGTH = 4_096;
const UUID_PATH = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

/**
 * The closed set of POSTs whose server contract makes a replay both safe and
 * necessary when the first response is lost. Membership is a reviewed property
 * of the server handler, never a caller's option — `request()` deliberately
 * exposes no `replayable` flag, so an ordinary mutation cannot opt in.
 *
 * - **Authoring-preview handoff mint** — its transaction atomically replaces
 *   any prior unconsumed handoff, so a second attempt yields the same single
 *   live handoff rather than a second one.
 * - **CLI authorization claim** — the claim is a guarded single-use status
 *   transition. A replay after a lost response does not mint a second key: the
 *   server answers `..._CONSUMED`, which `login` surfaces as an issued-but-
 *   unreceived credential the owner must revoke. Not replaying would leave that
 *   same orphan and report only a network error, which is strictly worse.
 */
const REPLACEABLE_POST_PATHS = Object.freeze([
  new RegExp(
    `^v1/sites/${UUID_PATH}/authoring-previews/pages/${UUID_PATH}/${UUID_PATH}:mint-handoff$`,
    "u",
  ),
  /^v1\/site-authoring\/cli-authorizations\/claim$/u,
]);

/**
 * The one shape a site-authoring credential may have before it is allowed near
 * an Authorization header. Exported because the credential store applies the
 * same check to a value it read from disk: a stored key reaches exactly the
 * same header the environment variable does, so it must clear exactly the same
 * bar, and a second, drifting copy of this rule is how that stops being true.
 */
export function isWellFormedCredential(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAXIMUM_TOKEN_LENGTH
    && !hasControlCharacter(value);
}

/**
 * The internal marker that selects the anonymous construction path. It is a
 * module-private symbol, so `SiteApiClient.anonymous()` is the only way to
 * reach that path and no caller can pass a "token" that turns into one — nor
 * can an anonymous client ever be handed a bearer, because the factory
 * overwrites whatever `token` it was given.
 */
const ANONYMOUS_CREDENTIAL = Symbol("anonymous site authoring API client");

function delayForAttempt(attempt) {
  return Math.min(250 * (2 ** attempt), 2_000);
}

function operationSignal(parent, timeoutMilliseconds, timeoutSignal) {
  const timeout = timeoutSignal(timeoutMilliseconds);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

/**
 * A cancellation, tagged with whether a mutation may already have run.
 *
 * Ctrl+C can land in five places inside one request: before an attempt is
 * sent, while it is on the wire, while its body is being read, during the
 * backoff between attempts, and while an error body is being read. Only some
 * of those mean the server may have acted — an abort during backoff after
 * nothing but certificate failures means no request ever left. `login` reads
 * this tag to decide whether to warn about a possible orphan, and without it
 * every cancellation warned, sending operators to revoke nothing.
 */
function cancelledError(ambiguousMutation = false) {
  const error = new SiteAuthoringError("site.cancelled", "The Taproot site authoring command was cancelled.");
  error.ambiguousMutation = ambiguousMutation;
  return error;
}

function deadlineError() {
  return new SiteAuthoringError("transport.deadline", "The Taproot API request exceeded its polling deadline.");
}

function remainingBudget(deadline, now) {
  return deadline === undefined ? Number.POSITIVE_INFINITY : deadline - now();
}

async function waitForRetry(client, attempt, deadline, now, ambiguousMutation) {
  const remaining = remainingBudget(deadline, now);
  if (remaining <= 0) throw deadlineError();
  try {
    await client.sleep(Math.min(delayForAttempt(attempt), remaining), client.signal);
  } catch (error) {
    // The sleep — default or injected — raises a bare cancellation. Re-raise
    // it carrying what the loop knows: whether any attempt so far left a
    // mutation possibly applied. During backoff nothing is in flight, so that
    // history is the whole answer.
    if (error instanceof SiteAuthoringError && error.code === "site.cancelled") {
      throw cancelledError(ambiguousMutation);
    }
    throw error;
  }
  if (remainingBudget(deadline, now) <= 0) throw deadlineError();
}

async function awaitWithSignal(promise, signal) {
  if (signal.aborted) throw new Error("The operation was aborted.");
  return await new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(new Error("The operation was aborted."));
    };
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

async function cancelBody(response, signal) {
  const cancellation = response.body?.cancel();
  if (!cancellation) return;
  if (signal) await awaitWithSignal(cancellation, signal).catch(() => {});
  else await cancellation.catch(() => {});
}

async function readBoundedBody(response, signal, maximumBytes = LIMITS.apiResponseBytes) {
  if (response.body === null) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const next = await awaitWithSignal(reader.read(), signal);
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new SiteAuthoringError(
          "transport.response_too_large",
          "A Taproot API response exceeded its byte limit.",
        );
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof SiteAuthoringError) throw error;
    throw new SiteAuthoringError("transport.response_read", "A Taproot API response could not be read.");
  }
  const body = Buffer.allocUnsafe(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/**
 * Breadth-first collection of every `field` a rejection names. The API nests
 * validation failures under `details[].fieldViolations[]` and, for some
 * refusals, one level deeper still, so the extraction walks the whole bounded
 * shape rather than pinning one path that a contract change would silently
 * empty.
 */
export function fieldViolations(value) {
  const fields = new Set();
  const queue = [{ value, depth: 0 }];
  let work = 0;
  while (queue.length > 0 && work < 1_000) {
    const current = queue.shift();
    work += 1;
    if (!current || current.depth > 8 || current.value === null || typeof current.value !== "object") continue;
    if (
      typeof current.value.field === "string"
      && current.value.field.length > 0
      && current.value.field.length <= 200
      && !hasControlCharacter(current.value.field)
    ) {
      fields.add(current.value.field);
    }
    for (const child of Object.values(current.value)) {
      if (child !== null && typeof child === "object") queue.push({ value: child, depth: current.depth + 1 });
    }
  }
  return [...fields].sort();
}

/**
 * The bounded walk again, keeping each named field's `description`. Kept
 * separate from `fieldViolations` so its sorted-string contract stays put.
 * Descriptions are operator-authored copy (the plan-limit message names the
 * remedy), so refusing to carry them would leave the caller guessing at
 * server policy — but they are still untrusted text: length-capped and
 * control-character-refused before they can reach an output stream.
 */
function fieldDescriptions(value) {
  const descriptions = new Map();
  const queue = [{ value, depth: 0 }];
  let work = 0;
  while (queue.length > 0 && work < 1_000) {
    const current = queue.shift();
    work += 1;
    if (!current || current.depth > 8 || current.value === null || typeof current.value !== "object") continue;
    if (
      typeof current.value.field === "string"
      && current.value.field.length > 0
      && current.value.field.length <= 200
      && !hasControlCharacter(current.value.field)
      && typeof current.value.description === "string"
      && current.value.description.length > 0
      && current.value.description.length <= LIMITS.diagnosticScalars
      && !hasControlCharacter(current.value.description)
      && !descriptions.has(current.value.field)
    ) {
      descriptions.set(current.value.field, current.value.description);
    }
    for (const child of Object.values(current.value)) {
      if (child !== null && typeof child === "object") queue.push({ value: child, depth: current.depth + 1 });
    }
  }
  return descriptions;
}

/**
 * A delegation capability or permission key as the server spells it. Anything
 * outside this shape is dropped rather than repaired: these values reach a
 * terminal and a machine-readable result, and a name the CLI cannot vouch for
 * is worse than a name it does not print.
 */
const CAPABILITY_NAME = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u;
const MAXIMUM_CAPABILITY_NAMES = 16;

function capabilityNames(value) {
  if (typeof value !== "string" || value === "") return [];
  return value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length <= 200 && CAPABILITY_NAME.test(name))
    .slice(0, MAXIMUM_CAPABILITY_NAMES);
}

/**
 * The key-mode capability denial the authoring API attaches as a
 * `google.rpc.ErrorInfo` detail (TR00691), or undefined.
 *
 * The same bounded breadth-first walk the field extractors use, for the same
 * reason: transcoded `details[]` entries are `Any`-packed, and pinning one path
 * through them is how a contract change silently empties an extractor. The
 * `reason` is the contract — a stable, namespaced classifier — so the walk
 * keys on it rather than on `@type`, which a future packing could reshape.
 */
export function capabilityRefusal(value) {
  const queue = [{ value, depth: 0 }];
  let work = 0;
  while (queue.length > 0 && work < 1_000) {
    const current = queue.shift();
    work += 1;
    if (!current || current.depth > 8 || current.value === null || typeof current.value !== "object") continue;
    const metadata = current.value.metadata;
    if (
      current.value.reason === CAPABILITY_REFUSAL_REASON
      && metadata !== null
      && typeof metadata === "object"
      && !Array.isArray(metadata)
    ) {
      const permission = capabilityNames(metadata.permission)[0];
      // A detail naming no permission is not this refusal, whatever it says:
      // the guidance is built entirely out of these three values, and half of
      // one would be a message nobody could act on.
      if (permission !== undefined) {
        return Object.freeze({
          permission,
          granted: Object.freeze(capabilityNames(metadata.granted)),
          required: Object.freeze(capabilityNames(metadata.required)),
        });
      }
    }
    for (const child of Object.values(current.value)) {
      if (child !== null && typeof child === "object") queue.push({ value: child, depth: current.depth + 1 });
    }
  }
  return undefined;
}

export class ApiError extends SiteAuthoringError {
  constructor(httpStatus, body) {
    const grpcCode = Number.isSafeInteger(body?.code) ? body.code : undefined;
    const fields = fieldViolations(body);
    const capability = capabilityRefusal(body);
    super(
      "api.request_rejected",
      fields.length > 0
        ? `Taproot rejected the request field '${fields[0]}'.`
        : capability !== undefined
        ? `Taproot refused the request: this credential does not carry a capability granting '${
          capability.permission
        }'.`
        : `Taproot rejected the request with HTTP ${httpStatus}.`,
      {
        // `fields` stays exactly what the wire named. The capability field is
        // the CLI's own label for a refusal that carries no field violation at
        // all, so it lands on the error without joining the wire-derived set
        // that `hasField()` classifies on.
        field: fields[0] ?? (capability === undefined ? undefined : CAPABILITY_REFUSAL_FIELD),
        status: grpcCode === undefined ? `http:${httpStatus}` : `grpc:${grpcCode}`,
      },
    );
    this.httpStatus = httpStatus;
    this.grpcCode = grpcCode;
    this.fields = fields;
    this.violationDescriptions = fieldDescriptions(body);
    this.capability = capability;
  }

  hasField(field) {
    return this.fields.some((candidate) => candidate.toLowerCase() === field.toLowerCase());
  }

  /**
   * The server's own wording for one violated field, or undefined. The
   * deploy-time plan-limit refusal is the canonical consumer: its description
   * names the remedy ("Upgrade to publish another page"), which the CLI must
   * surface rather than paraphrase away.
   */
  descriptionFor(field) {
    for (const [candidate, description] of this.violationDescriptions) {
      if (candidate.toLowerCase() === field.toLowerCase()) return description;
    }
    return undefined;
  }

  /**
   * Classifies a refusal into the one thing the caller should do next. The
   * five kinds are genuinely different behaviors, and collapsing them into
   * "the request failed" is what makes an agent retry a revoked credential
   * forever or treat a plan ceiling as a transient outage:
   *
   * - `platform_paused` (field `SiteAuthoringRollout`) — external authoring is
   *   switched off platform-wide. **Retry later** or ask the operator; the
   *   credential and the request are both fine.
   * - `credential_rejected` (gRPC `Unauthenticated` / HTTP 401, or field
   *   `ExternalApiKey`) — the key is invalid, revoked, expired, or bound to a
   *   different site. **Stop and re-issue**; retrying cannot succeed and
   *   repeated attempts look like credential stuffing.
   *
   *   Two shapes reach this, and only one of them carries a field.
   *   `SiteAuthoringAuthorityResolver` refuses at the boundary with a bare
   *   `RpcException(Unauthenticated)` and no details — deliberately, so the
   *   public surface cannot be used to enumerate key, site, or account state —
   *   which transcodes to `401 {"code":16,...}`. That is the *most likely*
   *   refusal this CLI will ever see, and classifying it on the field alone
   *   left it unclassified: no `refusal` in the JSON result, and nothing said
   *   on the human channel. The field arrives only from the in-transaction
   *   re-validation, which does attach `ExternalApiKey`.
   * - `plan_limit` (field `UpgradePrompt`) — a commercial ceiling, surfaced at
   *   deploy time because no pre-flight read of the published-page quota
   *   exists on the contract. **Upgrade** (or publish fewer pages); the CLI
   *   never invents the numeric limit.
   * - `throttled` (gRPC `ResourceExhausted` / HTTP 429) — the per-key
   *   throttle. **Back off** and retry with delay.
   * - `capability_missing` (`ErrorInfo` reason `SITE_AUTHORING_CAPABILITY_MISSING`)
   *   — the credential is valid and correctly scoped, and simply was not
   *   exchanged for a capability this request needs. **Fix the verb table**,
   *   not the credential: the exchange minted exactly what the verb asked for,
   *   so a verb whose declared set is short of the requests it makes is the
   *   defect. Distinguished from `credential_rejected` precisely because
   *   re-issuing the same credential cannot help (TR00691).
   *
   * Anything else is `unclassified`, which is a signal to surface the raw
   * status rather than to guess.
   */
  refusalKind() {
    // Fields first: they are the specific statement, and a named refusal
    // outranks whatever status happens to carry it.
    if (this.hasField(ROLLOUT_REFUSAL_FIELD)) return REFUSAL_PLATFORM_PAUSED;
    if (this.hasField(CREDENTIAL_REFUSAL_FIELD)) return REFUSAL_CREDENTIAL_REJECTED;
    if (this.hasField(PLAN_LIMIT_REFUSAL_FIELD)) return REFUSAL_PLAN_LIMIT;
    // The named detail ranks with the fields and above the status mappings, for
    // the same reason: it is the specific statement about this refusal.
    if (this.capability !== undefined) return REFUSAL_CAPABILITY_MISSING;
    if (this.grpcCode === GRPC_RESOURCE_EXHAUSTED || this.httpStatus === HTTP_TOO_MANY_REQUESTS) {
      return REFUSAL_THROTTLED;
    }
    if (this.grpcCode === GRPC_UNAUTHENTICATED || this.httpStatus === HTTP_UNAUTHORIZED) {
      return REFUSAL_CREDENTIAL_REJECTED;
    }
    return REFUSAL_UNCLASSIFIED;
  }
}

async function parseJsonResponse(response, signal) {
  const bytes = await readBoundedBody(response, signal);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new SiteAuthoringError("transport.invalid_json", "Taproot returned an invalid JSON response.");
  }
}

async function defaultSleep(milliseconds, signal) {
  await new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(cancelledError());
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

export class SiteApiClient {
  /**
   * The bearer header, or `undefined` for an anonymous client. Private so the
   * credential is not an enumerable property of an object that travels through
   * verbs, and so no later assignment can give an anonymous client a bearer.
   */
  #authorization;

  constructor({
    apiBaseUrl,
    token,
    fetch = globalThis.fetch,
    sleep = defaultSleep,
    signal,
    now = Date.now,
    timeoutSignal = AbortSignal.timeout,
  } = {}) {
    if (typeof fetch !== "function") {
      throw new SiteAuthoringError("transport.fetch_missing", "This Node runtime does not provide fetch().");
    }
    // The allowlist runs first, and on purpose: after this line the
    // constructor may hold a bearer token, and nothing may reach that state for
    // an origin outside the reviewed set. config.js already checked the same
    // value; this repeats it so no future caller can assemble a client — and
    // therefore an Authorization header — around the check. It runs for the
    // anonymous path too: the device and claim exchanges carry the site id and
    // mint a credential, so they are no more free to leave the reviewed set.
    const reviewedBaseUrl = validateApiBaseUrl(apiBaseUrl);
    const anonymous = token === ANONYMOUS_CREDENTIAL;
    if (!anonymous && !isWellFormedCredential(token)) {
      throw new SiteAuthoringError(
        "auth.key_invalid",
        `${PUBLISH_KEY_ENVIRONMENT_VARIABLE} is missing or malformed.`,
      );
    }
    this.apiBaseUrl = `${reviewedBaseUrl}/`;
    this.apiOrigin = new URL(this.apiBaseUrl).origin;
    this.apiPathPrefix = new URL(this.apiBaseUrl).pathname;
    this.anonymous = anonymous;
    this.#authorization = anonymous ? undefined : `Bearer ${token}`;
    this.fetch = fetch;
    this.sleep = sleep;
    this.signal = signal;
    this.now = now;
    this.timeoutSignal = timeoutSignal;
  }

  /**
   * A client for the two unauthenticated CLI-authorization endpoints. It is
   * identical in every other respect — the same reviewed-origin allowlist, the
   * same bounded responses, the same `ApiError`, the same retry discipline —
   * and it can never acquire a bearer: there is no token to hold, and the
   * header is only ever emitted from the private field this path leaves unset.
   */
  static anonymous(options = {}) {
    return new SiteApiClient({ ...options, token: ANONYMOUS_CREDENTIAL });
  }

  async request(path, options = {}) {
    return await this.#request(path, options, false);
  }

  /**
   * Replays only the POST shapes whose server contract answers a replay instead
   * of duplicating work — see `REPLACEABLE_POST_PATHS`. This is deliberately not
   * a caller-supplied `replayable` option on `request()`: ordinary mutations
   * must remain impossible to opt into replay.
   */
  async replaceablePost(path, options = {}) {
    if (typeof path !== "string" || !REPLACEABLE_POST_PATHS.some((pattern) => pattern.test(path))) {
      throw new SiteAuthoringError(
        "transport.request_contract",
        "That path is not one of the reviewed replayable POST operations.",
      );
    }
    return await this.#request(path, { ...options, method: "POST" }, true);
  }

  async #request(path, {
    method = "GET",
    body,
    attempts = LIMITS.requestAttempts,
    deadline,
    now = this.now,
  } = {}, replaceableMutation) {
    const url = new URL(path, this.apiBaseUrl);
    if (
      url.origin !== this.apiOrigin
      || !url.pathname.startsWith(this.apiPathPrefix)
      || !ALLOWED_METHODS.has(method)
      || (deadline !== undefined && !Number.isFinite(deadline))
      || typeof now !== "function"
    ) {
      throw new SiteAuthoringError(
        "transport.request_contract",
        "The Taproot API request is outside the reviewed transport contract.",
      );
    }
    const replayable = IDEMPOTENT_METHODS.has(method) || replaceableMutation;
    const serializedBody = body === undefined ? undefined : JSON.stringify(body);
    // Whether any attempt of a mutation has ended without an authoritative
    // outcome. Accumulated, not read off the final attempt: a claim whose first
    // send committed the mint and died on the reply, and whose retry then failed
    // a TLS handshake, is still a claim that may have minted. Classifying only
    // the last error would call that "undelivered" and tell login nothing was
    // issued.
    let anyAttemptAmbiguous = false;
    const mutation = !IDEMPOTENT_METHODS.has(method);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      // Before sending: only what earlier attempts did can be ambiguous.
      if (this.signal?.aborted) throw cancelledError(anyAttemptAmbiguous && mutation);
      const remaining = remainingBudget(deadline, now);
      if (remaining <= 0) throw deadlineError();
      const timeoutMilliseconds = Math.max(1, Math.ceil(Math.min(LIMITS.requestMilliseconds, remaining)));
      const attemptSignal = operationSignal(this.signal, timeoutMilliseconds, this.timeoutSignal);
      let response;
      try {
        response = await awaitWithSignal(
          this.fetch(url, {
            method,
            redirect: "error",
            signal: attemptSignal,
            headers: {
              accept: "application/json",
              // Absent entirely for an anonymous client: the start and claim
              // endpoints are unauthenticated, and an empty or placeholder
              // bearer is a credential-shaped value on the wire for no reason.
              ...(this.#authorization === undefined ? {} : { authorization: this.#authorization }),
              "content-type": "application/json",
              "user-agent": `${CLI_NAME}/${CLI_VERSION}`,
            },
            body: serializedBody,
          }),
          attemptSignal,
        );
      } catch (error) {
        // An abort that interrupted the fetch itself: for a mutation the
        // request may have been on the wire, so this attempt is ambiguous on
        // its own, whatever came before.
        if (this.signal?.aborted) throw cancelledError(mutation);
        if (remainingBudget(deadline, now) <= 0) throw deadlineError();
        if (!isUndelivered(error)) anyAttemptAmbiguous = true;
        if (replayable && attempt + 1 < attempts) {
          await waitForRetry(this, attempt, deadline, now, anyAttemptAmbiguous && mutation);
          continue;
        }
        // Three outcomes, and the line between them is whether the server may
        // have acted. A failure that provably happened before delivery — DNS,
        // refused, a TLS handshake — means it did not, whatever the method. A
        // read that died in flight means nothing either: there was nothing to
        // apply. A mutation that died in flight may have landed, and that is
        // true whether or not the transport replayed it first: replaying
        // bounds how many times it was *sent*, not whether the last send
        // arrived. So a replayable claim that exhausts its retries on reset
        // connections is still ambiguous, and `login` needs to hear that —
        // it arms its possible-orphan warning on ambiguity and must not on a
        // certificate error, and "network" was carrying both.
        const ambiguous = anyAttemptAmbiguous && !IDEMPOTENT_METHODS.has(method);
        const cause = describeTransportCause(error);
        throw new SiteAuthoringError(
          ambiguous ? "transport.mutation_ambiguous" : "transport.network",
          (ambiguous
            ? "A Taproot API mutation ended without an authoritative response."
            : "A Taproot API request failed before a response was received.")
            + (cause === undefined ? "" : ` (${cause})`),
        );
      }
      if (response.status >= 200 && response.status < 300 && !response.redirected) {
        try {
          const parsed = await parseJsonResponse(response, attemptSignal);
          if (remainingBudget(deadline, now) <= 0) throw deadlineError();
          return parsed;
        } catch (error) {
          // A 2xx arrived. Whatever the body turned out to be, the server
          // answered success — so for a mutation this attempt did not merely
          // lack an authoritative outcome, it had one this side could not
          // read. The accumulator must know before any retry: a claim that
          // minted, returned an unreadable body, and then had every retry fail
          // a TLS handshake is the strongest orphan case there is, and it was
          // being reported as "never sent".
          anyAttemptAmbiguous = true;
          if (this.signal?.aborted) throw cancelledError(mutation);
          if (remainingBudget(deadline, now) <= 0) throw deadlineError();
          if (
            replayable
            && error instanceof SiteAuthoringError
            && RETRYABLE_RESPONSE_ERRORS.has(error.code)
            && attempt + 1 < attempts
          ) {
            await waitForRetry(this, attempt, deadline, now, mutation);
            continue;
          }
          throw error;
        }
      }
      if (replayable && RETRYABLE_STATUS.has(response.status) && attempt + 1 < attempts) {
        if (response.status >= 500) anyAttemptAmbiguous = true;
        await cancelBody(response, attemptSignal);
        await waitForRetry(this, attempt, deadline, now, anyAttemptAmbiguous && mutation);
        continue;
      }
      let responseBody;
      try {
        responseBody = await parseJsonResponse(response, attemptSignal);
      } catch {
        // A response arrived, so the mutation's fate is whatever its status
        // says: a 4xx refused it, a 5xx may have committed it first.
        if (this.signal?.aborted) {
          throw cancelledError((anyAttemptAmbiguous || response.status >= 500) && mutation);
        }
        if (remainingBudget(deadline, now) <= 0) throw deadlineError();
        responseBody = Object.create(null);
      }
      if (remainingBudget(deadline, now) <= 0) throw deadlineError();
      throw new ApiError(response.status, responseBody);
    }
    throw new SiteAuthoringError("transport.retry_exhausted", "The Taproot API request exhausted its retry budget.");
  }

  /**
   * Performs one presigned whole-object PUT. The signed headers are echoed
   * exactly as the server returned them and are never recomputed: the values
   * are covered by the SigV4 signature, so a "helpfully" regenerated
   * Content-Type or an added header turns into an opaque S3 403. The bearer is
   * never forwarded — the signature is the authorization, and sending the
   * site key to an object store would leak it outside the reviewed origin.
   *
   * The PUT of an immutable object is idempotent, so this is the one mutation
   * shape that may be replayed.
   */
  async upload({ url: uploadUrl, requiredHeaders } = {}, bodyBytes) {
    if (
      typeof uploadUrl !== "string"
      || uploadUrl.length === 0
      || !ArrayBuffer.isView(bodyBytes)
    ) {
      throw new SiteAuthoringError("upload.contract_invalid", "Taproot returned an invalid upload capability.");
    }
    if (uploadUrl.length > MAXIMUM_UPLOAD_URL_LENGTH) {
      throw new SiteAuthoringError("upload.contract_invalid", "Taproot returned an oversized upload capability URL.");
    }
    let url;
    try {
      url = new URL(uploadUrl);
    } catch {
      throw new SiteAuthoringError("upload.contract_invalid", "Taproot returned an invalid upload capability URL.");
    }
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (
      (url.protocol !== "https:" && !(loopback && url.protocol === "http:"))
      || url.username !== ""
      || url.password !== ""
      || url.hash !== ""
    ) {
      throw new SiteAuthoringError("upload.contract_invalid", "Taproot returned an unsupported upload capability URL.");
    }

    // `RequestImageUpload` returns the signed set as a map, not a list.
    const entries = requiredHeaders !== null
        && typeof requiredHeaders === "object"
        && !Array.isArray(requiredHeaders)
      ? Object.entries(requiredHeaders)
      : undefined;
    if (entries === undefined) {
      throw new SiteAuthoringError("upload.headers_invalid", "Taproot returned an invalid signed upload header map.");
    }
    if (entries.length > MAXIMUM_UPLOAD_HEADERS) {
      throw new SiteAuthoringError("upload.headers_invalid", "Taproot returned too many signed upload headers.");
    }
    const headers = new Headers();
    const names = new Set();
    for (const [name, value] of entries) {
      const normalizedName = typeof name === "string" ? name.toLowerCase() : "";
      if (
        !HEADER_NAME.test(name ?? "")
        || typeof value !== "string"
        || value.length === 0
        || value.length > MAXIMUM_HEADER_VALUE_LENGTH
        || hasControlCharacter(value)
        || names.has(normalizedName)
      ) {
        throw new SiteAuthoringError("upload.headers_invalid", "Taproot returned invalid signed upload headers.");
      }
      names.add(normalizedName);
      headers.set(name, value);
    }
    if (!headers.has("content-type") || !headers.has("content-length")) {
      throw new SiteAuthoringError(
        "upload.headers_invalid",
        "The signed upload capability is missing required content headers.",
      );
    }
    // The declared length is bound into the signature, so a body of any other
    // size cannot succeed. Failing here names the real problem instead of
    // surfacing an S3 signature error.
    if (headers.get("content-length") !== String(bodyBytes.byteLength)) {
      throw new SiteAuthoringError(
        "upload.content_length_invalid",
        "The signed upload content length does not match the bytes being uploaded.",
      );
    }

    for (let attempt = 0; attempt < LIMITS.uploadAttempts; attempt += 1) {
      let response;
      try {
        response = await this.fetch(url, {
          method: "PUT",
          redirect: "error",
          signal: operationSignal(this.signal, LIMITS.uploadMilliseconds, this.timeoutSignal),
          headers,
          body: bodyBytes,
        });
      } catch {
        if (attempt + 1 < LIMITS.uploadAttempts && !this.signal?.aborted) {
          await this.sleep(delayForAttempt(attempt), this.signal);
          continue;
        }
        throw new SiteAuthoringError(
          "upload.ambiguous",
          "The whole-object upload ended without an authoritative response.",
        );
      }
      await cancelBody(response);
      if (response.status >= 200 && response.status < 300 && !response.redirected) return;
      if (RETRYABLE_STATUS.has(response.status) && attempt + 1 < LIMITS.uploadAttempts) {
        await this.sleep(delayForAttempt(attempt), this.signal);
        continue;
      }
      throw new SiteAuthoringError(
        RETRYABLE_STATUS.has(response.status) ? "upload.ambiguous" : "upload.rejected",
        `The whole-object upload was rejected with HTTP ${response.status}.`,
        { status: `http:${response.status}` },
      );
    }
  }
}
