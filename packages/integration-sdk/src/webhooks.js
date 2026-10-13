import { createHmac, timingSafeEqual } from "node:crypto";

import { asBytes, isPlainObject, MAX_WEBHOOK_BODY_BYTES, parseJsonBytes, readHeader, sha256Hex } from "./bytes.js";
import { DEFAULT_TIMESTAMP_TOLERANCE_SECONDS, WEBHOOK_VERSION } from "./constants.js";
import { IntegrationSdkError } from "./errors.js";
import { INTEGRATION_WEBHOOK_EVENTS } from "./openapi-contract.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMPTY_UUID = "00000000-0000-0000-0000-000000000000";
const SIGNATURE = /^t=([0-9]{1,16}),k=([0-9a-f-]{36}),v1=([0-9a-f]{64})$/i;
const EVENT_TYPES = new Set(Object.keys(INTEGRATION_WEBHOOK_EVENTS));

function uuid(value, code, allowEmpty = false) {
  if (typeof value !== "string" || !UUID.test(value) || (!allowEmpty && value === EMPTY_UUID)) {
    throw new IntegrationSdkError(code, "The webhook contains an invalid UUID.");
  }
  return value.toLowerCase();
}

function dateTime(value, code) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new IntegrationSdkError(code, "The webhook contains an invalid timestamp.");
  }
  return value;
}

function exactObject(value, required, code) {
  if (!isPlainObject(value) || Object.keys(value).length !== required.length ||
      required.some((key) => !Object.hasOwn(value, key))) {
    throw new IntegrationSdkError(code, "The webhook event does not match the v1 contract.");
  }
  return value;
}

function string(value, code) {
  if (typeof value !== "string" || value.length === 0) throw new IntegrationSdkError(code, "Expected a non-empty string.");
  return value;
}

function nonNegativeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) throw new IntegrationSdkError(code, "Expected a non-negative integer.");
  return value;
}

function installationState(value, code) {
  exactObject(value, [
    "status", "revision", "grantedCapabilities", "publishPolicy", "contractVersion",
    "sourceKind", "sourceEngagementId", "sourceTerminationReason",
  ], code);
  string(value.status, code);
  nonNegativeInteger(value.revision, code);
  if (!Array.isArray(value.grantedCapabilities) || value.grantedCapabilities.some((item) => typeof item !== "string")) {
    throw new IntegrationSdkError(code, "The installation capabilities are invalid.");
  }
  if (value.publishPolicy !== "auto" && value.publishPolicy !== "stage") throw new IntegrationSdkError(code, "The publish policy is invalid.");
  string(value.contractVersion, code);
  if (value.sourceKind !== "owner" && value.sourceKind !== "engagement") throw new IntegrationSdkError(code, "The source kind is invalid.");
  if (value.sourceEngagementId !== null) uuid(value.sourceEngagementId, code);
  if (value.sourceTerminationReason !== null && typeof value.sourceTerminationReason !== "string") {
    throw new IntegrationSdkError(code, "The source termination reason is invalid.");
  }
}

function publishedCandidate(value, code) {
  exactObject(value, ["candidateId", "revision"], code);
  uuid(value.candidateId, code);
  nonNegativeInteger(value.revision, code);
}

function validateEventData(type, data) {
  const code = "invalid_event";
  switch (type) {
    case "ping":
      exactObject(data, ["purpose"], code); string(data.purpose, code); return;
    case "installation.created":
      exactObject(data, ["installation", "claimCode", "claimExpiresAt"], code);
      installationState(data.installation, code); string(data.claimCode, code); dateTime(data.claimExpiresAt, code); return;
    case "installation.updated":
    case "installation.suspended":
    case "installation.resumed":
    case "installation.uninstalled":
      installationState(data, code); return;
    case "sync.requested":
      exactObject(data, ["reason", "syncId", "candidateIds"], code);
      string(data.reason, code); uuid(data.syncId, code);
      if (!Array.isArray(data.candidateIds)) throw new IntegrationSdkError(code, "Candidate IDs must be an array.");
      data.candidateIds.forEach((value) => uuid(value, code)); return;
    case "placement.created":
    case "placement.updated":
    case "placement.deleted":
      exactObject(data, ["placementId", "componentId", "placementRevision", "config"], code);
      uuid(data.placementId, code); string(data.componentId, code); nonNegativeInteger(data.placementRevision, code); return;
    case "publish.completed":
      exactObject(data, ["deploymentId", "candidates"], code); uuid(data.deploymentId, code);
      if (!Array.isArray(data.candidates)) throw new IntegrationSdkError(code, "Candidates must be an array.");
      data.candidates.forEach((value) => publishedCandidate(value, code)); return;
    case "publish.failed":
      exactObject(data, ["deploymentId", "candidateIds", "code"], code); uuid(data.deploymentId, code);
      if (!Array.isArray(data.candidateIds)) throw new IntegrationSdkError(code, "Candidate IDs must be an array.");
      data.candidateIds.forEach((value) => uuid(value, code)); string(data.code, code); return;
    case "page.published":
      exactObject(data, ["pageId", "externalId", "publishedRevision", "url"], code);
      uuid(data.pageId, code); string(data.externalId, code); nonNegativeInteger(data.publishedRevision, code); string(data.url, code); return;
    case "page.deleted":
      exactObject(data, ["pageId", "externalId", "revision", "url"], code);
      uuid(data.pageId, code); string(data.externalId, code); nonNegativeInteger(data.revision, code); string(data.url, code); return;
    default:
      throw new IntegrationSdkError(code, "The webhook event type is unsupported.");
  }
}

/** Parses an event only after its raw bytes have passed signature verification. */
export function parseWebhookEvent(body) {
  const event = parseJsonBytes(asBytes(body), "invalid_json");
  exactObject(event, ["id", "type", "version", "occurredAt", "integrationId", "installationId", "siteId", "data"], "invalid_event");
  if (!EVENT_TYPES.has(event.type) || event.version !== WEBHOOK_VERSION || !isPlainObject(event.data)) {
    throw new IntegrationSdkError("invalid_event", "The event is not a supported v1 webhook.");
  }
  event.id = uuid(event.id, "invalid_event");
  event.integrationId = uuid(event.integrationId, "invalid_event");
  const isPing = event.type === "ping";
  event.installationId = uuid(event.installationId, "invalid_event", isPing);
  event.siteId = uuid(event.siteId, "invalid_event", isPing);
  dateTime(event.occurredAt, "invalid_event");
  validateEventData(event.type, event.data);
  return event;
}

function strictBase64(value) {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new IntegrationSdkError("invalid_signing_key", "Signing secrets must be non-empty base64 strings.");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 0) throw new IntegrationSdkError("invalid_signing_key", "Signing secrets must not be empty.");
  return decoded;
}

function signingSecret(signingSecrets, keyId) {
  let value;
  if (signingSecrets instanceof Map) {
    for (const [candidate, secret] of signingSecrets) if (String(candidate).toLowerCase() === keyId) value = secret;
  } else if (isPlainObject(signingSecrets)) {
    for (const [candidate, secret] of Object.entries(signingSecrets)) if (candidate.toLowerCase() === keyId) value = secret;
  } else {
    throw new IntegrationSdkError("invalid_signing_keys", "Signing secrets must be a key-id map.");
  }
  if (value === undefined) throw new IntegrationSdkError("unknown_signing_key", "The signing key is not configured.");
  if (value instanceof Uint8Array) {
    if (value.length === 0) throw new IntegrationSdkError("invalid_signing_key", "Signing secrets must not be empty.");
    return value;
  }
  return strictBase64(value);
}

function parseSignature(value) {
  if (typeof value !== "string") throw new IntegrationSdkError("missing_signature", "Taproot-Signature is required.");
  const match = SIGNATURE.exec(value);
  if (!match) throw new IntegrationSdkError("invalid_signature", "Taproot-Signature is malformed.");
  const timestamp = Number(match[1]);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new IntegrationSdkError("invalid_signature", "The signature timestamp is invalid.");
  return { timestamp, keyId: uuid(match[2], "invalid_signature"), signature: match[3].toLowerCase() };
}

function asMilliseconds(now) {
  if (now instanceof Date) return now.getTime();
  if (typeof now === "number" && Number.isFinite(now)) return now;
  throw new IntegrationSdkError("invalid_now", "now must be a Date or Unix milliseconds.");
}

/**
 * Verifies Taproot's `t=<unix>,k=<key id>,v1=<hmac>` envelope over `ASCII(t + ".") + body`.
 * `body` must be the unmodified received request bytes. Parse or decode it only through the
 * returned event after this function succeeds.
 */
export function verifyWebhookSignature({
  headers,
  body,
  signingSecrets,
  now = new Date(),
  timestampToleranceSeconds = DEFAULT_TIMESTAMP_TOLERANCE_SECONDS,
}) {
  const bytes = asBytes(body);
  if (bytes.length > MAX_WEBHOOK_BODY_BYTES) throw new IntegrationSdkError("body_too_large", "Webhook body exceeds 1 MiB.");
  if (!Number.isSafeInteger(timestampToleranceSeconds) || timestampToleranceSeconds < 0 || timestampToleranceSeconds > 3600) {
    throw new IntegrationSdkError("invalid_timestamp_tolerance", "Timestamp tolerance must be an integer from zero through 3600 seconds.");
  }
  const parsed = parseSignature(readHeader(headers, "Taproot-Signature"));
  if (Math.abs(Math.floor(asMilliseconds(now) / 1000) - parsed.timestamp) > timestampToleranceSeconds) {
    throw new IntegrationSdkError("timestamp_out_of_range", "Webhook timestamp is outside the permitted tolerance.");
  }
  let expected;
  try {
    expected = createHmac("sha256", signingSecret(signingSecrets, parsed.keyId))
      .update(Buffer.from(`${parsed.timestamp}.`, "ascii"))
      .update(bytes)
      .digest();
  } catch (error) {
    if (error instanceof IntegrationSdkError) throw error;
    throw new IntegrationSdkError("unknown_signing_key", "The signing key is not configured.");
  }
  const received = Buffer.from(parsed.signature, "hex");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new IntegrationSdkError("invalid_signature", "Webhook HMAC verification failed.");
  }
  const event = parseWebhookEvent(bytes);
  const deliveryId = uuid(readHeader(headers, "Taproot-Delivery-Id"), "invalid_delivery_header");
  const headerInstallationId = uuid(readHeader(headers, "Taproot-Installation-Id"), "invalid_installation_header", event.type === "ping");
  const headerEvent = readHeader(headers, "Taproot-Event");
  if (deliveryId !== event.id || headerInstallationId !== event.installationId || headerEvent !== event.type) {
    throw new IntegrationSdkError("header_body_mismatch", "Signed webhook headers do not match the event body.");
  }
  return Object.freeze({
    event: Object.freeze(event),
    deliveryId,
    eventType: event.type,
    installationId: event.installationId,
    keyId: parsed.keyId,
    timestamp: parsed.timestamp,
    body: bytes,
    bodySha256: sha256Hex(bytes),
  });
}

function validReceiptClaim(value) {
  return isPlainObject(value) && ["claimed", "duplicate", "in_progress", "conflict"].includes(value.state) &&
    (value.state !== "claimed" || typeof value.token === "string");
}

/**
 * Claims an already-verified delivery in caller-provided durable storage. A receipt store must
 * make this operation atomic across restarts. Return `duplicate` only for the same immutable
 * receipt that has already been delivered; return `conflict` when a delivery id is reused with
 * different signed metadata. A failed receipt or expired processing lease must return `claimed`
 * with a fresh token so the delivery is processed again, never `duplicate` or `in_progress`.
 */
export async function claimWebhookReceipt({ store, verified, now = new Date() }) {
  if (!store || typeof store.claim !== "function") {
    throw new IntegrationSdkError("receipt_store_required", "A durable WebhookReceiptStore with claim() is required before acknowledgement.");
  }
  const receipt = Object.freeze({
    deliveryId: verified.deliveryId,
    eventType: verified.eventType,
    installationId: verified.event.installationId,
    integrationId: verified.event.integrationId,
    occurredAt: verified.event.occurredAt,
    keyId: verified.keyId,
    bodySha256: verified.bodySha256,
    receivedAt: new Date(asMilliseconds(now)).toISOString(),
  });
  const claim = await store.claim(receipt);
  if (!validReceiptClaim(claim)) throw new IntegrationSdkError("invalid_receipt_claim", "Receipt storage returned an invalid claim result.");
  return Object.freeze({ receipt, ...claim });
}

/** Marks a claimed durable receipt after processing. It does not imply exactly-once external work. */
export async function finishWebhookReceipt({ store, verified, token, status, failureCode, now = new Date() }) {
  if (!store || typeof store.finish !== "function") throw new IntegrationSdkError("receipt_store_required", "A durable WebhookReceiptStore with finish() is required.");
  if (typeof token !== "string" || token.length === 0 || !["delivered", "failed"].includes(status)) {
    throw new IntegrationSdkError("invalid_receipt_completion", "Receipt completion is invalid.");
  }
  await store.finish({
    deliveryId: verified.deliveryId,
    bodySha256: verified.bodySha256,
    token,
    status,
    failureCode: status === "failed" ? failureCode ?? "processing_failed" : undefined,
    completedAt: new Date(asMilliseconds(now)).toISOString(),
  });
}
