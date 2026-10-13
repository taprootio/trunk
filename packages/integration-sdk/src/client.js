import { randomUUID } from "node:crypto";
import { isIP } from "node:net";

import { asBytes, isPlainObject, MAX_API_REQUEST_BYTES, MAX_API_RESPONSE_BYTES } from "./bytes.js";
import { DEFAULT_RETRY_ATTEMPTS } from "./constants.js";
import { IntegrationApiError, IntegrationSdkError } from "./errors.js";
import { INTEGRATION_OPENAPI_OPERATIONS as API } from "./openapi-contract.js";

const RETRYABLE_STATUSES = new Set([408, 429, 502, 503, 504]);
const MAX_TIMEOUT_MS = 60_000;

function nonEmptyString(value, code) {
  if (typeof value !== "string" || value.trim().length === 0) throw new IntegrationSdkError(code, "A non-empty string is required.");
  return value;
}

function normalizeBaseUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new IntegrationSdkError("invalid_base_url", "baseUrl must be an absolute HTTPS URL."); }
  const loopback = parsed.hostname === "localhost" || parsed.hostname === "::1" || (isIP(parsed.hostname) === 4 && parsed.hostname.startsWith("127."));
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) throw new IntegrationSdkError("invalid_base_url", "baseUrl must use HTTPS (HTTP is allowed only for explicit loopback tests).");
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new IntegrationSdkError("invalid_base_url", "baseUrl must not include credentials, a query, or a fragment.");
  return parsed.toString().replace(/\/$/, "");
}

function presignedUploadUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new IntegrationSdkError("invalid_upload_url", "Presigned upload URL must be absolute."); }
  const loopback = parsed.hostname === "localhost" || parsed.hostname === "::1" || (isIP(parsed.hostname) === 4 && parsed.hostname.startsWith("127."));
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) throw new IntegrationSdkError("invalid_upload_url", "Presigned upload URL must use HTTPS.");
  if (parsed.username || parsed.password || parsed.hash) throw new IntegrationSdkError("invalid_upload_url", "Presigned upload URL must not contain credentials or a fragment.");
  return parsed.toString();
}

function uploadHeaders(value, bodyLength) {
  if (!isPlainObject(value) || Object.keys(value).length > 32) throw new IntegrationSdkError("invalid_upload_headers", "requiredHeaders must be a bounded object.");
  const headers = new Headers();
  for (const [name, headerValue] of Object.entries(value)) {
    const lowerName = name.toLowerCase();
    const contentLength = lowerName === "content-length";
    const canonicalLength = typeof headerValue === "string" && /^(?:0|[1-9][0-9]*)$/.test(headerValue) &&
      Number.isSafeInteger(Number(headerValue)) && Number(headerValue) === bodyLength;
    if (name.length > 256 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || typeof headerValue !== "string" || headerValue.length > 4096 || /[\r\n]/.test(headerValue) ||
        ["authorization", "cookie", "proxy-authorization", "host"].includes(lowerName) || (contentLength && !canonicalLength)) {
      throw new IntegrationSdkError("invalid_upload_headers", "Required upload headers contain a forbidden or invalid value.");
    }
    try { headers.set(name, headerValue); }
    catch { throw new IntegrationSdkError("invalid_upload_headers", "Required upload headers contain a forbidden or invalid value."); }
  }
  return headers;
}

function operationPath(operation, values) {
  return API[operation].path.replace(/\{([A-Za-z]+)\}/g, (_, name) => encodeURIComponent(nonEmptyString(values[name], `invalid_${name}`)));
}

function withIdempotency(body, idempotencyKey) {
  nonEmptyString(idempotencyKey, "idempotency_key_required");
  if (idempotencyKey.length > 128 || idempotencyKey.trim() !== idempotencyKey || /[\u0000-\u001f\u007f]/.test(idempotencyKey)) {
    throw new IntegrationSdkError("invalid_idempotency_key", "Idempotency keys are limited to 128 non-control characters without surrounding whitespace.");
  }
  return { ...body, idempotencyKey };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retryDelay(attempt) {
  return Math.min(1_000, 100 * (2 ** (attempt - 1))) + Math.floor(Math.random() * 50);
}

function placementConflictCode(response, bytes) {
  if (response.status !== 400 || bytes.length === 0) return undefined;
  let value;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { return undefined; }
  if (!isPlainObject(value) || !Array.isArray(value.details) || value.details.length > 32) return undefined;
  for (const detail of value.details) {
    if (!isPlainObject(detail) || detail["@type"] !== "type.googleapis.com/google.rpc.BadRequest.FieldViolation") continue;
    if (detail.field === "ConfigurationRevision" && detail.description === "configuration_revision_conflict") {
      return "configuration_revision_conflict";
    }
    if (detail.field === "ExpectedFragmentRevision" && detail.description === "fragment_revision_conflict") {
      return "fragment_revision_conflict";
    }
  }
  return undefined;
}

function responseError(response, bytes) {
  // Error bodies are untrusted and may echo request values. Never promote them into an Error.
  return new IntegrationApiError(response.status, placementConflictCode(response, bytes) ?? `http_${response.status}`, "Taproot rejected the request.");
}

function readWithAbort(reader, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new IntegrationSdkError("request_timeout", "The request exceeded its timeout."));
      return;
    }
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      callback(value);
    };
    const abort = () => finish(reject, new IntegrationSdkError("request_timeout", "The request exceeded its timeout."));
    signal.addEventListener("abort", abort, { once: true });
    reader.read().then((result) => finish(resolve, result), (error) => finish(reject, error));
  });
}

async function readBoundedResponse(response, signal) {
  const contentLength = response.headers.get("content-length");
  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_API_RESPONSE_BYTES)) {
    throw new IntegrationSdkError("response_too_large", "Taproot response exceeds the SDK response limit.", { status: response.status });
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await readWithAbort(reader, signal);
      if (done) break;
      length += value.length;
      if (length > MAX_API_RESPONSE_BYTES) {
        await reader.cancel();
        throw new IntegrationSdkError("response_too_large", "Taproot response exceeds the SDK response limit.", { status: response.status });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

function parseResponse(bytes, response) {
  if (bytes.length === 0) return undefined;
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new IntegrationApiError(response.status, "invalid_api_response", "Taproot returned invalid JSON."); }
}

function serializeRequest(body) {
  let value;
  try { value = JSON.stringify(body); } catch { throw new IntegrationSdkError("invalid_request", "Request body must be JSON serializable."); }
  if (typeof value !== "string" || new TextEncoder().encode(value).length > MAX_API_REQUEST_BYTES) {
    throw new IntegrationSdkError("request_too_large", "Request exceeds the SDK request limit.");
  }
  return value;
}

function isRetryableFailure(error) {
  return error instanceof IntegrationApiError
    ? RETRYABLE_STATUSES.has(error.status)
    : error instanceof IntegrationSdkError && (error.code === "request_timeout" || error.code === "request_failed");
}

class BoundedSemaphore {
  #active = 0;
  #waiting = [];
  constructor(limit, maximumWaiting) { this.limit = limit; this.maximumWaiting = maximumWaiting; }
  async run(action) {
    if (this.#active >= this.limit) {
      if (this.#waiting.length >= this.maximumWaiting) throw new IntegrationSdkError("concurrency_queue_full", "The SDK request queue is full.");
      await new Promise((resolve) => this.#waiting.push(resolve));
    }
    this.#active++;
    try { return await action(); }
    finally {
      this.#active--;
      this.#waiting.shift()?.();
    }
  }
}

/** Creates a UUID that identifies one logical mutation across retries and process recovery. */
export function createIdempotencyKey() {
  return randomUUID();
}

/**
 * Typed, integration-facing REST client. `baseUrl` is the canonical API base (for example
 * `https://app.example/api`); all methods add the reviewed `/v1` contract path. Credentials are
 * provided once at construction and are used only by methods with their matching authority.
 */
export class TaprootIntegrationClient {
  #baseUrl;
  #fetch;
  #installationCredential;
  #publisherCredential;
  #timeoutMs;
  #attempts;
  #semaphore;

  constructor({
    baseUrl,
    fetch: fetchImplementation = globalThis.fetch,
    installationCredential,
    publisherCredential,
    timeoutMs = 10_000,
    maxAttempts = DEFAULT_RETRY_ATTEMPTS,
    maxConcurrentRequests = 4,
    maxQueuedRequests = 32,
  }) {
    this.#baseUrl = normalizeBaseUrl(baseUrl);
    if (typeof fetchImplementation !== "function") throw new IntegrationSdkError("fetch_required", "A Fetch-compatible implementation is required.");
    this.#fetch = fetchImplementation;
    if (installationCredential !== undefined) this.#installationCredential = nonEmptyString(installationCredential, "invalid_installation_credential");
    if (publisherCredential !== undefined) this.#publisherCredential = nonEmptyString(publisherCredential, "invalid_publisher_credential");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_TIMEOUT_MS) throw new IntegrationSdkError("invalid_timeout", "timeoutMs must be an integer from 100 through 60000.");
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) throw new IntegrationSdkError("invalid_retry_attempts", "maxAttempts must be an integer from one through three.");
    if (!Number.isSafeInteger(maxConcurrentRequests) || maxConcurrentRequests < 1 || maxConcurrentRequests > 8) throw new IntegrationSdkError("invalid_concurrency", "maxConcurrentRequests must be an integer from one through eight.");
    if (!Number.isSafeInteger(maxQueuedRequests) || maxQueuedRequests < 0 || maxQueuedRequests > 64) throw new IntegrationSdkError("invalid_queue_limit", "maxQueuedRequests must be an integer from zero through 64.");
    this.#timeoutMs = timeoutMs;
    this.#attempts = maxAttempts;
    this.#semaphore = new BoundedSemaphore(maxConcurrentRequests, maxQueuedRequests);
  }

  #url(path) { return new URL(path.replace(/^\//, ""), `${this.#baseUrl}/`).toString(); }

  #credential(kind) {
    const credential = kind === "installation" ? this.#installationCredential : this.#publisherCredential;
    if (!credential) throw new IntegrationSdkError(`missing_${kind}_credential`, `This operation requires an ${kind} credential.`);
    return credential;
  }

  async #request({ path, method = "POST", body, credential, idempotencyKey, retry = false }) {
    const headers = new Headers({ accept: "application/json" });
    if (credential) headers.set("authorization", `Bearer ${this.#credential(credential)}`);
    if (body !== undefined) headers.set("content-type", "application/json");
    if (idempotencyKey) headers.set("idempotency-key", idempotencyKey);
    const encodedBody = body === undefined ? undefined : serializeRequest(body);
    return this.#semaphore.run(async () => {
      let lastError;
      const attempts = retry ? this.#attempts : 1;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        const signal = AbortSignal.timeout(this.#timeoutMs);
        try {
          const response = await this.#fetch(this.#url(path), { method, headers, body: encodedBody, redirect: "manual", credentials: "omit", referrerPolicy: "no-referrer", signal });
          if (response.redirected || response.status >= 300 && response.status < 400) throw new IntegrationSdkError("redirect_rejected", "Taproot responses must not redirect.");
          const bytes = await readBoundedResponse(response, signal);
          if (response.ok) return parseResponse(bytes, response);
          lastError = responseError(response, bytes);
          if (!retry || !RETRYABLE_STATUSES.has(response.status) || attempt === attempts) throw lastError;
        } catch (error) {
          if (error instanceof IntegrationSdkError || error instanceof IntegrationApiError) {
            lastError = error;
            if (!retry || !isRetryableFailure(error) || attempt === attempts) throw error;
          } else {
            lastError = signal.aborted
              ? new IntegrationSdkError("request_timeout", "The request exceeded its timeout.")
              : new IntegrationSdkError("request_failed", "The request did not receive a usable response.");
            if (!retry || attempt === attempts) throw lastError;
          }
        }
        await delay(retryDelay(attempt));
      }
      throw lastError;
    });
  }

  /** Claim responses are deliberately never retried: a lost successful response cannot reveal the one-time secret again. */
  async claimInstallation({ installationId, claimCode }) {
    try {
      return await this.#request({
        path: operationPath("claimInstallation", { installationId }),
        body: { installationId, claimCode: nonEmptyString(claimCode, "invalid_claim_code") }, credential: "publisher",
      });
    } catch (error) {
      const successfulResponseWasUnreadable = error instanceof IntegrationSdkError && error.status >= 200 && error.status < 300 &&
        (error.code === "response_too_large" || error.code === "invalid_api_response");
      if (error instanceof IntegrationSdkError && (error.code === "request_failed" || error.code === "request_timeout" || successfulResponseWasUnreadable)) {
        throw new IntegrationSdkError("claim_response_unknown", "Claim response was lost. Do not retry blindly; validate the installation and use the owner reissue flow if no secret was stored.", { status: error.status });
      }
      throw error;
    }
  }

  validateInstallation({ installationId }) {
    return this.#request({ path: operationPath("validateInstallation", { installationId }), method: "GET", credential: "installation", retry: true });
  }

  createSync({ installationId, mode, requestedSyncId, idempotencyKey }) {
    return this.#request({ path: operationPath("createSync", { installationId }), credential: "installation", idempotencyKey,
      body: withIdempotency({ installationId, mode: nonEmptyString(mode, "invalid_sync_mode"), requestedSyncId: requestedSyncId ?? "" }, idempotencyKey), retry: true });
  }

  completeSync({ installationId, syncId, summary = "", idempotencyKey }) {
    return this.#finishSync("complete", { installationId, syncId, summary, idempotencyKey });
  }

  abortSync({ installationId, syncId, summary = "", idempotencyKey }) {
    return this.#finishSync("abort", { installationId, syncId, summary, idempotencyKey });
  }

  #finishSync(action, { installationId, syncId, summary, idempotencyKey }) {
    const id = nonEmptyString(installationId, "invalid_installation_id");
    const operation = action === "complete" ? "completeSync" : "abortSync";
    return this.#request({ path: operationPath(operation, { installationId: id, syncId }), credential: "installation", idempotencyKey,
      body: withIdempotency({ installationId: id, syncId, summary }, idempotencyKey), retry: true });
  }

  putManagedPage({ installationId, syncId = "", page, idempotencyKey }) {
    const id = nonEmptyString(installationId, "invalid_installation_id");
    if (!isPlainObject(page)) throw new IntegrationSdkError("invalid_page", "page must be an object matching IntegrationManagedPageContent.");
    return this.#request({ path: operationPath("putManagedPage", { installationId: id }), credential: "installation", idempotencyKey,
      body: withIdempotency({ installationId: id, syncId, page }, idempotencyKey), retry: true });
  }

  deleteManagedPage({ installationId, syncId = "", externalId, idempotencyKey }) {
    return this.#deleteContent("deleteManagedPage", { installationId, syncId, key: externalId, idempotencyKey });
  }

  putDataDocument({ installationId, syncId = "", key, json, idempotencyKey }) {
    const id = nonEmptyString(installationId, "invalid_installation_id");
    return this.#request({ path: operationPath("putDataDocument", { installationId: id }), credential: "installation", idempotencyKey,
      body: withIdempotency({ installationId: id, syncId, key: nonEmptyString(key, "invalid_data_key"), json: nonEmptyString(json, "invalid_data_json") }, idempotencyKey), retry: true });
  }

  deleteDataDocument({ installationId, syncId = "", key, idempotencyKey }) {
    return this.#deleteContent("deleteDataDocument", { installationId, syncId, key, idempotencyKey });
  }

  #deleteContent(operation, { installationId, syncId, key, idempotencyKey }) {
    const id = nonEmptyString(installationId, "invalid_installation_id");
    return this.#request({ path: operationPath(operation, { installationId: id }), credential: "installation", idempotencyKey,
      body: withIdempotency({ installationId: id, syncId, key: nonEmptyString(key, "invalid_content_key") }, idempotencyKey), retry: true });
  }

  requestMediaUpload({ installationId, fileName, contentType, fileSize, contentHash, width, height }) {
    const id = nonEmptyString(installationId, "invalid_installation_id");
    return this.#request({ path: operationPath("requestMediaUpload", { installationId: id }), credential: "installation",
      body: { installationId: id, fileName: nonEmptyString(fileName, "invalid_file_name"), contentType: nonEmptyString(contentType, "invalid_content_type"), fileSize, contentHash: nonEmptyString(contentHash, "invalid_content_hash"), width, height } });
  }

  confirmMediaUpload({ installationId, uploadId }) {
    const id = nonEmptyString(installationId, "invalid_installation_id");
    return this.#request({ path: operationPath("confirmMediaUpload", { installationId: id }), credential: "installation", body: { installationId: id, uploadId: nonEmptyString(uploadId, "invalid_upload_id") } });
  }

  async putMedia({ installationId, fileName, contentType, fileSize, contentHash, width, height, body }) {
    const requested = await this.requestMediaUpload({ installationId, fileName, contentType, fileSize, contentHash, width, height });
    if (requested.isDuplicate) return requested.image;
    await this.uploadPresigned({ url: requested.presignedUrl, requiredHeaders: requested.requiredHeaders, body });
    return (await this.confirmMediaUpload({ installationId, uploadId: requested.uploadId })).image;
  }

  async uploadPresigned({ url, requiredHeaders = {}, body }) {
    const bytes = asBytes(body, "invalid_upload_body");
    const endpoint = presignedUploadUrl(url);
    const headers = uploadHeaders(requiredHeaders, bytes.length);
    return this.#semaphore.run(async () => {
      let response;
      try {
        response = await this.#fetch(endpoint, { method: "PUT", headers, body: bytes, redirect: "manual", credentials: "omit", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(this.#timeoutMs) });
      } catch (error) {
        throw new IntegrationSdkError("upload_response_unknown", "Upload response was lost. Retry the same upload bytes only when the caller can prove the upload remains pending.");
      }
      if (response.redirected || response.status >= 300 && response.status < 400) throw new IntegrationSdkError("redirect_rejected", "Object-store upload responses must not redirect.");
      if (!response.ok) throw new IntegrationApiError(response.status, `upload_http_${response.status}`, "The object-store upload failed.");
    });
  }

  listPlacements({ installationId }) {
    return this.#request({ path: operationPath("listPlacements", { installationId }), method: "GET", credential: "installation", retry: true });
  }

  putFragment({ installationId, placementId, configurationRevision, expectedFragmentRevision, html, structuredData = [], syncId = "", idempotencyKey }) {
    return this.#fragment("put", { installationId, placementId, configurationRevision, expectedFragmentRevision, html, structuredData, syncId, idempotencyKey });
  }

  deleteFragment({ installationId, placementId, configurationRevision, expectedFragmentRevision, syncId = "", idempotencyKey }) {
    return this.#fragment("delete", { installationId, placementId, configurationRevision, expectedFragmentRevision, syncId, idempotencyKey });
  }

  #fragment(action, { installationId, placementId, configurationRevision, expectedFragmentRevision, html, structuredData, syncId, idempotencyKey }) {
    const id = nonEmptyString(installationId, "invalid_installation_id");
    const placement = nonEmptyString(placementId, "invalid_placement_id");
    if (!Number.isSafeInteger(configurationRevision) || configurationRevision < 0) throw new IntegrationSdkError("invalid_configuration_revision", "configurationRevision must be a non-negative integer.");
    const common = { installationId: id, placementId: placement, configurationRevision, syncId };
    const operation = action === "put" ? { ...common, html: nonEmptyString(html, "invalid_fragment_html"), structuredData } : common;
    if (expectedFragmentRevision !== undefined) operation.expectedFragmentRevision = expectedFragmentRevision;
    return this.#request({ path: operationPath(action === "put" ? "putFragment" : "deleteFragment", { installationId: id, placementId: placement }), credential: "installation", idempotencyKey,
      body: withIdempotency(operation, idempotencyKey), retry: true });
  }

  requestBundleUpload({ integrationId, contentHash, byteLength, runtimeMajor }) {
    const id = nonEmptyString(integrationId, "invalid_integration_id");
    return this.#request({ path: operationPath("requestBundleUpload", { integrationId: id }), credential: "publisher",
      body: { integrationId: id, contentHash: nonEmptyString(contentHash, "invalid_content_hash"), byteLength, runtimeMajor } });
  }

  confirmBundleUpload({ integrationId, uploadId }) {
    const id = nonEmptyString(integrationId, "invalid_integration_id");
    return this.#request({ path: operationPath("confirmBundleUpload", { integrationId: id, uploadId }), credential: "publisher", body: { integrationId: id, uploadId } });
  }

  confirmHandoff({ installationId, token }) {
    const id = nonEmptyString(installationId, "invalid_installation_id");
    return this.#request({ path: operationPath("confirmHandoff", { installationId: id }), credential: "installation", body: { installationId: id, token: nonEmptyString(token, "invalid_handoff_token") } });
  }
}
