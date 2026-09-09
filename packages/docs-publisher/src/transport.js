import { ARCHIVE_CONTENT_TYPE, LIMITS, PUBLISHER_NAME, PUBLISHER_VERSION } from "./constants.js";
import { PublisherError } from "./errors.js";

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_RESPONSE_ERRORS = new Set([
  "transport.invalid_json",
  "transport.response_read",
]);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;

function delayForAttempt(attempt) {
  return Math.min(250 * (2 ** attempt), 2_000);
}

function operationSignal(parent, timeoutMilliseconds, timeoutSignal) {
  const timeout = timeoutSignal(timeoutMilliseconds);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

function cancelledError() {
  return new PublisherError("publisher.cancelled", "The Docs publish operation was cancelled.");
}

function deadlineError() {
  return new PublisherError("transport.deadline", "The Taproot API request exceeded its polling deadline.");
}

function remainingBudget(deadline, now) {
  return deadline === undefined ? Number.POSITIVE_INFINITY : deadline - now();
}

async function waitForRetry(client, attempt, deadline, now) {
  const remaining = remainingBudget(deadline, now);
  if (remaining <= 0) throw deadlineError();
  await client.sleep(Math.min(delayForAttempt(attempt), remaining), client.signal);
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
        throw new PublisherError("transport.response_too_large", "A Taproot API response exceeded its byte limit.");
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof PublisherError) throw error;
    throw new PublisherError("transport.response_read", "A Taproot API response could not be read.");
  }
  const body = Buffer.allocUnsafe(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function fieldViolations(value) {
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
      && !CONTROL_CHARACTER.test(current.value.field)
    ) {
      fields.add(current.value.field);
    }
    for (const child of Object.values(current.value)) {
      if (child !== null && typeof child === "object") queue.push({ value: child, depth: current.depth + 1 });
    }
  }
  return [...fields].sort();
}

export class ApiError extends PublisherError {
  constructor(httpStatus, body) {
    const grpcCode = Number.isSafeInteger(body?.code) ? body.code : undefined;
    const fields = fieldViolations(body);
    super(
      "api.request_rejected",
      fields.length > 0
        ? `Taproot rejected the request field '${fields[0]}'.`
        : `Taproot rejected the request with HTTP ${httpStatus}.`,
      { field: fields[0], status: grpcCode === undefined ? `http:${httpStatus}` : `grpc:${grpcCode}` },
    );
    this.httpStatus = httpStatus;
    this.grpcCode = grpcCode;
    this.fields = fields;
  }

  hasField(field) {
    return this.fields.some((candidate) => candidate.toLowerCase() === field.toLowerCase());
  }

  isRetryable() {
    return RETRYABLE_STATUS.has(this.httpStatus);
  }
}

async function parseJsonResponse(response, signal) {
  const bytes = await readBoundedBody(response, signal);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new PublisherError("transport.invalid_json", "Taproot returned an invalid JSON response.");
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
      reject(new PublisherError("publisher.cancelled", "The Docs publish operation was cancelled."));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

export class DocsApiClient {
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
      throw new PublisherError("transport.fetch_missing", "This Node runtime does not provide fetch().");
    }
    if (typeof token !== "string" || token.length === 0 || token.length > 512 || CONTROL_CHARACTER.test(token)) {
      throw new PublisherError("auth.key_invalid", "TAPROOT_DOCS_PUBLISH_KEY is missing or malformed.");
    }
    this.apiBaseUrl = apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`;
    this.apiOrigin = new URL(this.apiBaseUrl).origin;
    this.token = token;
    this.fetch = fetch;
    this.sleep = sleep;
    this.signal = signal;
    this.now = now;
    this.timeoutSignal = timeoutSignal;
  }

  async request(path, {
    method = "GET",
    body,
    attempts = LIMITS.requestAttempts,
    deadline,
    now = this.now,
  } = {}) {
    const url = new URL(path, this.apiBaseUrl);
    if (
      url.origin !== this.apiOrigin
      || !url.pathname.startsWith(new URL(this.apiBaseUrl).pathname)
      || !["GET", "POST"].includes(method)
      || (deadline !== undefined && !Number.isFinite(deadline))
      || typeof now !== "function"
    ) {
      throw new PublisherError(
        "transport.request_contract",
        "The Taproot API request is outside the reviewed transport contract.",
      );
    }
    const serializedBody = body === undefined ? undefined : JSON.stringify(body);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (this.signal?.aborted) throw cancelledError();
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
              authorization: `Bearer ${this.token}`,
              "content-type": "application/json",
              "user-agent": `${PUBLISHER_NAME}/${PUBLISHER_VERSION}`,
            },
            body: serializedBody,
          }),
          attemptSignal,
        );
      } catch {
        if (this.signal?.aborted) throw cancelledError();
        if (remainingBudget(deadline, now) <= 0) throw deadlineError();
        if (attempt + 1 < attempts) {
          await waitForRetry(this, attempt, deadline, now);
          continue;
        }
        throw new PublisherError(
          "transport.network",
          "A Taproot API request failed before a response was received.",
        );
      }
      if (response.status >= 200 && response.status < 300 && !response.redirected) {
        try {
          const parsed = await parseJsonResponse(response, attemptSignal);
          if (remainingBudget(deadline, now) <= 0) throw deadlineError();
          return parsed;
        } catch (error) {
          if (this.signal?.aborted) throw cancelledError();
          if (remainingBudget(deadline, now) <= 0) throw deadlineError();
          if (
            error instanceof PublisherError
            && RETRYABLE_RESPONSE_ERRORS.has(error.code)
            && attempt + 1 < attempts
          ) {
            await waitForRetry(this, attempt, deadline, now);
            continue;
          }
          throw error;
        }
      }
      if (RETRYABLE_STATUS.has(response.status) && attempt + 1 < attempts) {
        await cancelBody(response, attemptSignal);
        await waitForRetry(this, attempt, deadline, now);
        continue;
      }
      let responseBody;
      try {
        responseBody = await parseJsonResponse(response, attemptSignal);
      } catch {
        if (this.signal?.aborted) throw cancelledError();
        if (remainingBudget(deadline, now) <= 0) throw deadlineError();
        responseBody = Object.create(null);
      }
      if (remainingBudget(deadline, now) <= 0) throw deadlineError();
      throw new ApiError(response.status, responseBody);
    }
    throw new PublisherError("transport.retry_exhausted", "The Taproot API request exhausted its retry budget.");
  }

  async upload(upload, archiveBytes) {
    if (
      !upload
      || upload.method !== "PUT"
      || typeof upload.url !== "string"
      || !Array.isArray(upload.requiredHeaders)
      || upload.contentLength !== archiveBytes.byteLength
    ) {
      throw new PublisherError("upload.contract_invalid", "Taproot returned an invalid upload capability.");
    }
    let url;
    if (upload.url.length > 16_384) {
      throw new PublisherError("upload.contract_invalid", "Taproot returned an oversized upload capability URL.");
    }
    try {
      url = new URL(upload.url);
    } catch {
      throw new PublisherError("upload.contract_invalid", "Taproot returned an invalid upload capability URL.");
    }
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (
      (url.protocol !== "https:" && !(loopback && url.protocol === "http:"))
      || url.username !== ""
      || url.password !== ""
      || url.hash !== ""
    ) {
      throw new PublisherError("upload.contract_invalid", "Taproot returned an unsupported upload capability URL.");
    }
    const headers = new Headers();
    const names = new Set();
    if (upload.requiredHeaders.length > 64) {
      throw new PublisherError("upload.headers_invalid", "Taproot returned too many signed upload headers.");
    }
    for (const header of upload.requiredHeaders) {
      const normalizedName = typeof header?.name === "string" ? header.name.toLowerCase() : "";
      if (
        !HEADER_NAME.test(header?.name ?? "")
        || typeof header?.value !== "string"
        || header.value.length === 0
        || header.value.length > 4_096
        || CONTROL_CHARACTER.test(header.value)
        || names.has(normalizedName)
      ) {
        throw new PublisherError("upload.headers_invalid", "Taproot returned invalid signed upload headers.");
      }
      names.add(normalizedName);
      headers.set(header.name, header.value);
    }
    if (
      !headers.has("content-type")
      || !headers.has("content-length")
    ) {
      throw new PublisherError(
        "upload.headers_invalid",
        "The signed upload capability is missing required content headers.",
      );
    }
    if (headers.get("content-type") !== ARCHIVE_CONTENT_TYPE) {
      throw new PublisherError(
        "upload.content_type_invalid",
        "The signed upload content type does not match the Docs archive contract.",
      );
    }
    if (headers.get("content-length") !== String(archiveBytes.byteLength)) {
      throw new PublisherError(
        "upload.content_length_invalid",
        "The signed upload content length does not match the Docs archive contract.",
      );
    }
    headers.set("content-length", String(archiveBytes.byteLength));

    for (let attempt = 0; attempt < LIMITS.requestAttempts; attempt += 1) {
      let response;
      try {
        response = await this.fetch(url, {
          method: "PUT",
          redirect: "error",
          signal: operationSignal(this.signal, LIMITS.uploadMilliseconds, this.timeoutSignal),
          headers,
          body: archiveBytes,
        });
      } catch {
        if (attempt + 1 < LIMITS.requestAttempts && !this.signal?.aborted) {
          await this.sleep(delayForAttempt(attempt), this.signal);
          continue;
        }
        throw new PublisherError(
          "upload.ambiguous",
          "The whole-object upload ended without an authoritative response.",
        );
      }
      await cancelBody(response);
      if (response.status >= 200 && response.status < 300 && !response.redirected) return;
      if (RETRYABLE_STATUS.has(response.status) && attempt + 1 < LIMITS.requestAttempts) {
        await this.sleep(delayForAttempt(attempt), this.signal);
        continue;
      }
      throw new PublisherError(
        RETRYABLE_STATUS.has(response.status) ? "upload.ambiguous" : "upload.rejected",
        `The whole-object upload was rejected with HTTP ${response.status}.`,
        { status: `http:${response.status}` },
      );
    }
  }
}
