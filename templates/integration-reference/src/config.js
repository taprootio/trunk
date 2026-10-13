const UUID = /^(?!00000000-0000-0000-0000-000000000000$)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function requireValue(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`Missing required environment variable ${name}.`);
  return value;
}

function boundedInteger(environment, name, fallback, minimum, maximum) {
  const raw = environment[name] ?? String(fallback);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function parseOrigin(value, name) {
  let origin;
  try {
    origin = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute HTTPS URL.`);
  }
  if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password) {
    throw new Error(`${name} must be an HTTPS origin without credentials, a path, query, or fragment.`);
  }
  return origin.origin;
}

function parseApiUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("TAPROOT_API_URL must be an absolute HTTPS URL.");
  }
  const loopbackHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !loopbackHttp) || url.search || url.hash || url.username || url.password) {
    throw new Error("TAPROOT_API_URL must be HTTPS (or loopback HTTP for a local fixture) without credentials, a query, or a fragment.");
  }
  return url.href.replace(/\/$/u, "");
}

function parseSigningKeys(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("TAPROOT_WEBHOOK_SIGNING_KEYS must be a JSON object.");
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("TAPROOT_WEBHOOK_SIGNING_KEYS must be a JSON object.");
  }
  const keys = new Map();
  for (const [keyId, secret] of Object.entries(parsed)) {
    if (!UUID.test(keyId) || typeof secret !== "string" || secret.length === 0 ||
        Buffer.from(secret, "base64").toString("base64") !== secret) {
      throw new Error("TAPROOT_WEBHOOK_SIGNING_KEYS contains an invalid key id or secret.");
    }
    keys.set(keyId.toLowerCase(), secret);
  }
  if (keys.size === 0) throw new Error("At least one webhook signing key is required.");
  return keys;
}

function parseJwksUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("TAPROOT_HANDOFF_JWKS_URL must be an absolute URL.");
  }
  const loopbackHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !loopbackHttp) || url.username || url.password || url.search || url.hash) {
    throw new Error("TAPROOT_HANDOFF_JWKS_URL must be HTTPS (or loopback HTTP) without credentials, a query, or a fragment.");
  }
  return url.href;
}

function parseEncryptionKey(value) {
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) throw new Error("CREDENTIAL_ENCRYPTION_KEY must decode to exactly 32 bytes.");
  return key;
}

function databaseCaCertificate(environment) {
  const value = environment.DATABASE_CA_CERT;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.includes("-----BEGIN CERTIFICATE-----") || !value.includes("-----END CERTIFICATE-----")) {
    throw new Error("DATABASE_CA_CERT must be a PEM certificate chain.");
  }
  return value;
}

function syncMode(environment) {
  const value = environment.REFERENCE_SYNC_MODE ?? "full";
  if (!["full", "incremental", "abort", "delete"].includes(value)) {
    throw new Error("REFERENCE_SYNC_MODE must be full, incremental, abort, or delete.");
  }
  return value;
}

function webhookLimits(environment) {
  const maxReceiptBytes = boundedInteger(environment, "WEBHOOK_MAX_RECEIPT_BYTES", 262_144, 1_024, 1_048_576);
  const maxRetainedReceipts = boundedInteger(environment, "WEBHOOK_MAX_RETAINED_RECEIPTS", 50_000, 100, 1_000_000);
  const maxOutstandingReceipts = boundedInteger(environment, "WEBHOOK_MAX_OUTSTANDING_RECEIPTS", 512, 1, 100_000);
  const maxOperationsPerReceipt = boundedInteger(environment, "WEBHOOK_MAX_OPERATIONS_PER_RECEIPT", 512, 1, 512);
  const maxOperationBytesPerReceipt = boundedInteger(environment, "WEBHOOK_MAX_OPERATION_BYTES_PER_RECEIPT", 2_097_152, 4_096, 4_194_304);
  const maxOperationResponseBytes = boundedInteger(environment, "WEBHOOK_MAX_OPERATION_RESPONSE_BYTES", 524_288, 1_024, 524_288);
  if (maxOperationResponseBytes > maxOperationBytesPerReceipt) {
    throw new Error("WEBHOOK_MAX_OPERATION_RESPONSE_BYTES cannot exceed WEBHOOK_MAX_OPERATION_BYTES_PER_RECEIPT.");
  }
  if (maxOutstandingReceipts > maxRetainedReceipts) {
    throw new Error("WEBHOOK_MAX_OUTSTANDING_RECEIPTS cannot exceed WEBHOOK_MAX_RETAINED_RECEIPTS.");
  }
  return Object.freeze({
    maxReceiptBytes,
    maxRetainedReceipts,
    maxOutstandingReceipts,
    maxOperationsPerReceipt,
    maxOperationBytesPerReceipt,
    maxOperationResponseBytes,
  });
}

function hostBinding(environment) {
  const host = environment.HOST ?? "0.0.0.0";
  if (!["127.0.0.1", "::1", "0.0.0.0"].includes(host)) {
    throw new Error("HOST must be one of 127.0.0.1, ::1, or 0.0.0.0.");
  }
  return host;
}

export function loadConfig(environment = process.env) {
  const bootstrapManifestOnly = environment.REFERENCE_BOOTSTRAP_MANIFEST_ONLY === "true";
  const publicOrigin = parseOrigin(requireValue(environment, "PUBLIC_ORIGIN"), "PUBLIC_ORIGIN");
  const host = hostBinding(environment);
  if (bootstrapManifestOnly) {
    return Object.freeze({
      bootstrapManifestOnly: true,
      publicOrigin,
      host,
      port: boundedInteger(environment, "PORT", 8080, 1, 65_535),
    });
  }
  const integrationId = requireValue(environment, "INTEGRATION_ID").toLowerCase();
  if (!UUID.test(integrationId)) throw new Error("INTEGRATION_ID must be a UUID.");

  const limits = webhookLimits(environment);
  return Object.freeze({
    bootstrapManifestOnly: false,
    databaseUrl: requireValue(environment, "DATABASE_URL"),
    databaseCaCertificate: databaseCaCertificate(environment),
    publicOrigin,
    taprootApiUrl: parseApiUrl(requireValue(environment, "TAPROOT_API_URL")),
    integrationId,
    publisherCredential: requireValue(environment, "PUBLISHER_CREDENTIAL"),
    signingKeys: parseSigningKeys(requireValue(environment, "TAPROOT_WEBHOOK_SIGNING_KEYS")),
    encryptionKey: parseEncryptionKey(requireValue(environment, "CREDENTIAL_ENCRYPTION_KEY")),
    handoffIssuer: parseOrigin(requireValue(environment, "TAPROOT_HANDOFF_ISSUER"), "TAPROOT_HANDOFF_ISSUER"),
    handoffJwksUrl: parseJwksUrl(requireValue(environment, "TAPROOT_HANDOFF_JWKS_URL")),
    host,
    port: boundedInteger(environment, "PORT", 8080, 1, 65_535),
    webhookMaxAttempts: boundedInteger(environment, "WEBHOOK_MAX_ATTEMPTS", 8, 1, 20),
    // The SDK can make three ten-second attempts with bounded retry jitter.
    // Leave a small scheduling margin beyond that longest single call.
    webhookLeaseSeconds: boundedInteger(environment, "WEBHOOK_LEASE_SECONDS", 60, 35, 300),
    webhookPollMilliseconds: boundedInteger(environment, "WEBHOOK_POLL_MILLISECONDS", 1000, 100, 30_000),
    webhookLimits: limits,
    referenceSyncMode: syncMode(environment),
  });
}

/** The bundle publisher needs no database, webhook, or handoff configuration. */
export function loadBundleUploadConfig(environment = process.env) {
  const integrationId = requireValue(environment, "INTEGRATION_ID").toLowerCase();
  if (!UUID.test(integrationId)) throw new Error("INTEGRATION_ID must be a UUID.");
  return Object.freeze({
    taprootApiUrl: parseApiUrl(requireValue(environment, "TAPROOT_API_URL")),
    integrationId,
    publisherCredential: requireValue(environment, "PUBLISHER_CREDENTIAL"),
  });
}
