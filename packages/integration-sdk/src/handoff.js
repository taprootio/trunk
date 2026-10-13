import { webcrypto } from "node:crypto";
import { isIP } from "node:net";

import { HANDOFF_JWKS_PATH, HANDOFF_LIFETIME_SECONDS } from "./constants.js";
import { IntegrationSdkError } from "./errors.js";
import { isPlainObject } from "./bytes.js";
import { DuplicateJsonKeyError, parseJsonWithoutDuplicateKeys } from "./json.js";

const MAX_TOKEN_LENGTH = 8 * 1024;
const MAX_JWKS_BYTES = 64 * 1024;
const MAX_JWKS_KEYS = 16;
const MAX_JWKS_CACHE_SECONDS = 300;
const MIN_UNKNOWN_KID_REFRESH_MILLISECONDS = 30_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMPTY_UUID = "00000000-0000-0000-0000-000000000000";
const cache = new Map();
const refreshes = new Map();

function invalid(message = "The settings handoff is invalid.") {
  return new IntegrationSdkError("invalid_handoff", message);
}

function canonicalUuid(value) {
  if (typeof value !== "string" || !UUID.test(value) || value.toLowerCase() === EMPTY_UUID) throw invalid();
  return value.toLowerCase();
}

function epochMilliseconds(now) {
  if (now instanceof Date) return now.getTime();
  if (typeof now === "number" && Number.isFinite(now)) return now;
  throw new IntegrationSdkError("invalid_now", "now must be a Date or Unix milliseconds.");
}

function decodeBase64Url(value) {
  if (typeof value !== "string" || value.length === 0 || !/^[A-Za-z0-9_-]+$/.test(value)) throw invalid();
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length === 0 || bytes.toString("base64url") !== value) throw invalid();
  return bytes;
}

function parseJson(bytes) {
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return parseJsonWithoutDuplicateKeys(source);
  } catch (error) {
    if (error instanceof DuplicateJsonKeyError) throw invalid("The settings handoff contains duplicate JSON claims.");
    if (error instanceof IntegrationSdkError) throw error;
    throw invalid();
  }
}

function exactKeys(value, keys) {
  return isPlainObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function parseToken(token) {
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) throw invalid();
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) throw invalid();
  return {
    header: parseJson(decodeBase64Url(parts[0])),
    payload: parseJson(decodeBase64Url(parts[1])),
    signature: decodeBase64Url(parts[2]),
    signed: new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  };
}

function jwksCacheSeconds(value) {
  const match = /(?:^|,)\s*max-age=(\d+)/i.exec(value ?? "");
  return match ? Math.min(Number(match[1]), MAX_JWKS_CACHE_SECONDS) : MAX_JWKS_CACHE_SECONDS;
}

async function readJwks(response) {
  const contentLength = response.headers.get("content-length");
  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_JWKS_BYTES)) throw new IntegrationSdkError("jwks_unavailable", "JWKS exceeds the public handoff limit.");
  const reader = response.body?.getReader();
  if (!reader) throw new IntegrationSdkError("jwks_unavailable", "JWKS response has no body.");
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > MAX_JWKS_BYTES) throw new IntegrationSdkError("jwks_unavailable", "JWKS exceeds the public handoff limit.");
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const document = parseJson(bytes);
  if (!exactKeys(document, ["keys"]) || !Array.isArray(document.keys) || document.keys.length > MAX_JWKS_KEYS) {
    throw new IntegrationSdkError("jwks_unavailable", "JWKS does not match the Taproot handoff contract.");
  }
  const keys = new Map();
  for (const key of document.keys) {
    if (!exactKeys(key, ["kty", "use", "alg", "kid", "n", "e"]) || key.kty !== "RSA" || key.use !== "sig" || key.alg !== "RS256" ||
        typeof key.kid !== "string" || key.kid.length === 0 || key.kid.length > 128 || typeof key.n !== "string" || typeof key.e !== "string" || keys.has(key.kid)) {
      throw new IntegrationSdkError("jwks_unavailable", "JWKS does not contain valid handoff signing keys.");
    }
    try {
      keys.set(key.kid, await webcrypto.subtle.importKey("jwk", key, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
    } catch { throw new IntegrationSdkError("jwks_unavailable", "JWKS contains an invalid RSA key."); }
  }
  return keys;
}

function resolveJwksUrl(issuer, supplied) {
  let base;
  try { base = new URL(issuer); } catch { throw new IntegrationSdkError("invalid_issuer", "issuer must be an absolute URL."); }
  const validOrigin = (url) => {
    const loopback = url.hostname === "localhost" || url.hostname === "::1" || (isIP(url.hostname) === 4 && url.hostname.startsWith("127."));
    return url.protocol === "https:" || (url.protocol === "http:" && loopback);
  };
  if (!validOrigin(base) || base.username || base.password || base.search || base.hash) throw new IntegrationSdkError("invalid_issuer", "issuer must be HTTPS (or loopback HTTP) without credentials, a query, or a fragment.");
  if (supplied === undefined) return new URL(HANDOFF_JWKS_PATH, `${base.toString().replace(/\/$/, "")}/`).toString();
  let configured;
  try { configured = new URL(supplied); } catch { throw new IntegrationSdkError("invalid_jwks_url", "jwksUrl must be an absolute URL."); }
  if (!validOrigin(configured) || configured.username || configured.password || configured.search || configured.hash) {
    throw new IntegrationSdkError("invalid_jwks_url", "jwksUrl must be HTTPS (or loopback HTTP) without credentials, a query, or a fragment.");
  }
  return configured.toString();
}

async function refreshJwks(url, fetchImplementation, now) {
  const existingRefresh = refreshes.get(url);
  if (existingRefresh) return existingRefresh;
  const refresh = (async () => {
    let response;
    try {
      response = await fetchImplementation(url, { method: "GET", redirect: "manual", cache: "no-store", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(10_000) });
    } catch { throw new IntegrationSdkError("jwks_unavailable", "The handoff JWKS could not be loaded."); }
    if (response.redirected || response.status >= 300 && response.status < 400 || !response.ok) throw new IntegrationSdkError("jwks_unavailable", "The handoff JWKS could not be loaded.");
    const keys = await readJwks(response);
    cache.set(url, {
      keys,
      fetchedAt: now,
      expiresAt: now + jwksCacheSeconds(response.headers.get("cache-control")) * 1_000,
    });
    return keys;
  })();
  refreshes.set(url, refresh);
  try { return await refresh; }
  finally {
    if (refreshes.get(url) === refresh) refreshes.delete(url);
  }
}

async function keyFor({ issuer, jwksUrl, fetch: fetchImplementation, now, jwks }, kid) {
  if (jwks !== undefined) {
    const response = new Response(JSON.stringify(jwks), { headers: { "content-type": "application/jwk-set+json" } });
    return (await readJwks(response)).get(kid);
  }
  if (typeof fetchImplementation !== "function") throw new IntegrationSdkError("fetch_required", "Fetching JWKS requires a Fetch-compatible implementation.");
  const url = resolveJwksUrl(issuer, jwksUrl);
  const existing = cache.get(url);
  if (existing && existing.expiresAt > now && existing.keys.has(kid)) return existing.keys.get(kid);
  if (existing && !existing.keys.has(kid) && existing.fetchedAt + MIN_UNKNOWN_KID_REFRESH_MILLISECONDS > now) return undefined;
  const keys = await refreshJwks(url, fetchImplementation, now);
  return keys.get(kid);
}

/**
 * Verifies the five-minute RS256 settings handoff against the dedicated Taproot JWK set. A valid
 * token is still only an invitation: call `confirmHandoff` once before creating a local session.
 */
export async function verifyHandoff({ token, issuer, audience, installationId, jwksUrl, jwks, fetch: fetchImplementation = globalThis.fetch, now = new Date() }) {
  const parsed = parseToken(token);
  if (!exactKeys(parsed.header, ["alg", "typ", "kid"]) || parsed.header.alg !== "RS256" || parsed.header.typ !== "JWT" ||
      typeof parsed.header.kid !== "string" || parsed.header.kid.length === 0 || parsed.header.kid.length > 128) throw invalid();
  const nowMilliseconds = epochMilliseconds(now);
  const key = await keyFor({ issuer, jwksUrl, jwks, fetch: fetchImplementation, now: nowMilliseconds }, parsed.header.kid);
  if (!key || !await webcrypto.subtle.verify("RSASSA-PKCS1-v1_5", key, parsed.signature, parsed.signed)) throw invalid();
  const payload = parsed.payload;
  const fields = ["iss", "aud", "sub", "site_id", "installation_id", "credential_id", "role", "engagement_id", "jti", "iat", "exp"];
  if (!exactKeys(payload, fields) || payload.iss !== issuer || canonicalUuid(payload.aud) !== canonicalUuid(audience) ||
      canonicalUuid(payload.installation_id) !== canonicalUuid(installationId) || !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp)) throw invalid();
  const issuedAt = payload.iat * 1_000;
  const expiresAt = payload.exp * 1_000;
  if (payload.iat <= 0 || payload.exp <= 0 || issuedAt > nowMilliseconds + 60_000 || expiresAt <= nowMilliseconds || expiresAt - issuedAt !== HANDOFF_LIFETIME_SECONDS * 1_000) throw invalid();
  const role = payload.role;
  const engagementId = payload.engagement_id === null ? null : canonicalUuid(payload.engagement_id);
  if ((role !== "owner" && role !== "engagement") || (role === "owner") !== (engagementId === null)) throw invalid();
  return Object.freeze({
    userId: canonicalUuid(payload.sub),
    siteId: canonicalUuid(payload.site_id),
    installationId: canonicalUuid(payload.installation_id),
    integrationId: canonicalUuid(payload.aud),
    credentialId: canonicalUuid(payload.credential_id),
    jti: canonicalUuid(payload.jti),
    role,
    engagementId,
    issuedAt: new Date(issuedAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
  });
}

/**
 * Consumes the authoritative, single-use Taproot handoff after local verification. The caller
 * must discard the URL token before this call and, if the response is lost, begin a new handoff.
 */
export async function confirmHandoff({ client, claims, token, now = new Date(), maximumSessionLifetimeSeconds = 24 * 60 * 60 }) {
  if (!client || typeof client.confirmHandoff !== "function" || !isPlainObject(claims)) throw new IntegrationSdkError("invalid_handoff_confirmation", "A client and verified claims are required.");
  if (!Number.isSafeInteger(maximumSessionLifetimeSeconds) || maximumSessionLifetimeSeconds < 1 || maximumSessionLifetimeSeconds > 24 * 60 * 60) throw new IntegrationSdkError("invalid_session_lifetime", "maximumSessionLifetimeSeconds must be from one through 86400.");
  const confirmed = await client.confirmHandoff({ installationId: claims.installationId, token });
  for (const field of ["userId", "siteId", "installationId", "integrationId", "credentialId", "role", "engagementId"]) {
    if ((confirmed[field] || null) !== (claims[field] || null)) throw new IntegrationSdkError("handoff_confirmation_mismatch", "Taproot confirmation did not match the verified handoff.");
  }
  const expiresAt = Date.parse(confirmed.expiresAt);
  const nowMilliseconds = epochMilliseconds(now);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= nowMilliseconds || expiresAt > nowMilliseconds + maximumSessionLifetimeSeconds * 1_000) {
    throw new IntegrationSdkError("invalid_handoff_confirmation", "Taproot returned an invalid settings session expiry.");
  }
  return Object.freeze({ ...claims, sessionExpiresAt: new Date(expiresAt).toISOString() });
}

/** Clears process-local public-key cache entries, primarily for controlled test or key-rollover recovery. */
export function clearHandoffJwksCache(jwksUrl) {
  if (jwksUrl === undefined) return cache.clear();
  cache.delete(new URL(jwksUrl).toString());
}
