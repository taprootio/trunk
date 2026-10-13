import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { verifyWebhookSignature } from "@taprootio/integration-sdk";
import { loadBundleUploadConfig, loadConfig } from "../src/config.js";
import { databasePoolOptions } from "../src/database.js";

const vectorUrl = new URL(import.meta.resolve("@taprootio/integration-sdk/fixtures/webhooks/v1/signature-vector.json"));
const vector = JSON.parse(readFileSync(vectorUrl, "utf8"));
const body = readFileSync(new URL(vector.bodyFile, vectorUrl));
const event = JSON.parse(body);

function environment(overrides = {}) {
  return {
    PUBLIC_ORIGIN: "https://reference.example.test",
    INTEGRATION_ID: "80000000-0000-4000-8000-000000000001",
    DATABASE_URL: "postgresql://localhost/reference",
    TAPROOT_API_URL: "https://app.example.test/api",
    PUBLISHER_CREDENTIAL: "configuration-test-placeholder",
    TAPROOT_WEBHOOK_SIGNING_KEYS: JSON.stringify({ [vector.keyId]: vector.signingSecretBase64 }),
    CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    TAPROOT_HANDOFF_ISSUER: "https://app.example.test",
    TAPROOT_HANDOFF_JWKS_URL: "https://app.example.test/api/.well-known/taproot-integrations-jwks.json",
    ...overrides,
  };
}

test("startup accepts a canonical signing key that verifies the published SDK vector", () => {
  const config = loadConfig(environment());
  const verified = verifyWebhookSignature({
    headers: {
      "Taproot-Signature": vector.header,
      "Taproot-Delivery-Id": event.id,
      "Taproot-Event": event.type,
      "Taproot-Installation-Id": event.installationId,
    },
    body, signingSecrets: config.signingKeys, now: new Date(vector.timestamp * 1000),
  });
  assert.equal(verified.bodySha256, vector.bodySha256);
});

test("startup rejects signing keys the webhook verifier cannot use", () => {
  for (const secret of ["", "!" + vector.signingSecretBase64, vector.signingSecretBase64.replace(/=+$/u, ""),
    vector.signingSecretBase64 + "\n", "____", null, 17]) {
    assert.throws(() => loadConfig(environment({
      TAPROOT_WEBHOOK_SIGNING_KEYS: JSON.stringify({ [vector.keyId]: secret }),
    })));
  }
  assert.throws(() => loadConfig(environment({
    TAPROOT_WEBHOOK_SIGNING_KEYS: JSON.stringify({ "00000000-0000-0000-0000-000000000000": vector.signingSecretBase64 }),
  })));
});

test("startup enforces the handoff verifier's JWKS transport boundary", () => {
  for (const url of ["not-a-url", "http://keys.example.test/jwks", "https://user:password@keys.example.test/jwks",
    "https://keys.example.test/jwks?key=secret", "https://keys.example.test/jwks#fragment"]) {
    assert.throws(() => loadConfig(environment({ TAPROOT_HANDOFF_JWKS_URL: url })));
  }
  for (const url of ["https://keys.example.test/jwks", "http://127.0.0.1:8123/jwks", "http://[::1]:8123/jwks"]) {
    assert.equal(loadConfig(environment({ TAPROOT_HANDOFF_JWKS_URL: url })).handoffJwksUrl, url);
  }
});

test("managed PostgreSQL CA configuration cannot be overridden by URL SSL parameters", () => {
  const certificate = "-----BEGIN CERTIFICATE-----\nreference-ca\n-----END CERTIFICATE-----";
  const config = loadConfig(environment({ DATABASE_CA_CERT: certificate, DATABASE_URL: "postgres://db.example.test/reference?ssl=false&sslmode=require&sslrootcert=ignored&application_name=reference" }));
  const options = databasePoolOptions(config.databaseUrl, config.databaseCaCertificate);
  const url = new URL(options.connectionString);
  assert.equal(url.searchParams.get("ssl"), null);
  assert.equal(url.searchParams.get("sslmode"), null);
  assert.equal(url.searchParams.get("sslrootcert"), null);
  assert.equal(url.searchParams.get("application_name"), "reference");
  assert.deepEqual(options.ssl, { ca: certificate, rejectUnauthorized: true });
  assert.throws(() => loadConfig(environment({ DATABASE_CA_CERT: "not-a-certificate" })));
});

test("bundle upload reads only its publisher authority configuration", () => {
  const config = loadBundleUploadConfig({
    TAPROOT_API_URL: "https://app.example.test/api",
    INTEGRATION_ID: "80000000-0000-4000-8000-000000000001",
    PUBLISHER_CREDENTIAL: "publisher-credential",
  });
  assert.deepEqual(config, {
    taprootApiUrl: "https://app.example.test/api",
    integrationId: "80000000-0000-4000-8000-000000000001",
    publisherCredential: "publisher-credential",
  });
  assert.throws(() => loadBundleUploadConfig({ TAPROOT_API_URL: "https://app.example.test/api" }));
});

test("webhook lease configuration reserves more than the SDK worst-case call", () => {
  assert.throws(() => loadConfig(environment({ WEBHOOK_LEASE_SECONDS: "34" })));
  assert.equal(loadConfig(environment({ WEBHOOK_LEASE_SECONDS: "35" })).webhookLeaseSeconds, 35);
});
