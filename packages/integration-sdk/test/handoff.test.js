import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import { clearHandoffJwksCache, confirmHandoff, verifyHandoff } from "../src/index.js";

const identifiers = Object.freeze({
  integration: "10000000-0000-4000-8000-000000000001",
  installation: "20000000-0000-4000-8000-000000000001",
  site: "30000000-0000-4000-8000-000000000001",
  user: "40000000-0000-4000-8000-000000000001",
  credential: "50000000-0000-4000-8000-000000000001",
  jti: "60000000-0000-4000-8000-000000000001",
});
const now = Date.UTC(2025, 0, 1);

function tokenFor(privateKey, kid, overrides = {}) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: "https://app.example/api", aud: identifiers.integration, sub: identifiers.user,
    site_id: identifiers.site, installation_id: identifiers.installation, credential_id: identifiers.credential,
    role: "owner", engagement_id: null, jti: identifiers.jti, iat: now / 1000, exp: now / 1000 + 300,
    ...overrides,
  })).toString("base64url");
  const signed = `${header}.${payload}`;
  return `${signed}.${sign("RSA-SHA256", Buffer.from(signed), privateKey).toString("base64url")}`;
}

test("handoff checks RS256, issuer, audience, expiry, selected key, and installation binding", async () => {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicJwk = keys.publicKey.export({ format: "jwk" });
  const token = tokenFor(keys.privateKey, "handoff-1");
  const claims = await verifyHandoff({
    token, issuer: "https://app.example/api", audience: identifiers.integration, installationId: identifiers.installation,
    jwks: { keys: [{ kty: "RSA", use: "sig", alg: "RS256", kid: "handoff-1", n: publicJwk.n, e: publicJwk.e }] }, now,
  });
  assert.equal(claims.credentialId, identifiers.credential);
  await assert.rejects(() => verifyHandoff({
    token, issuer: "https://app.example/api", audience: identifiers.integration, installationId: identifiers.site,
    jwks: { keys: [{ kty: "RSA", use: "sig", alg: "RS256", kid: "handoff-1", n: publicJwk.n, e: publicJwk.e }] }, now,
  }), { code: "invalid_handoff" });
});

test("handoff accepts an overlapping rotated JWK only when its selected kid verifies the token", async () => {
  const retired = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const active = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const retiredJwk = retired.publicKey.export({ format: "jwk" });
  const activeJwk = active.publicKey.export({ format: "jwk" });
  const keys = {
    keys: [
      { kty: "RSA", use: "sig", alg: "RS256", kid: "active", n: activeJwk.n, e: activeJwk.e },
      { kty: "RSA", use: "sig", alg: "RS256", kid: "retired-overlap", n: retiredJwk.n, e: retiredJwk.e },
    ],
  };
  const token = tokenFor(retired.privateKey, "retired-overlap");
  const claims = await verifyHandoff({
    token, issuer: "https://app.example/api", audience: identifiers.integration, installationId: identifiers.installation, jwks: keys, now,
  });
  assert.equal(claims.jti, identifiers.jti);
  await assert.rejects(() => verifyHandoff({
    token: tokenFor(retired.privateKey, "not-in-jwks"), issuer: "https://app.example/api", audience: identifiers.integration,
    installationId: identifiers.installation, jwks: keys, now,
  }), { code: "invalid_handoff" });
});

test("a fresh JWKS miss for an unknown key is shared and does not refetch per token", async () => {
  clearHandoffJwksCache();
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicJwk = keys.publicKey.export({ format: "jwk" });
  const token = tokenFor(keys.privateKey, "unknown-kid");
  let fetches = 0;
  let release;
  const started = new Promise((resolve) => { release = resolve; });
  const fetch = async () => {
    fetches++;
    await started;
    return new Response(JSON.stringify({ keys: [{ kty: "RSA", use: "sig", alg: "RS256", kid: "current-kid", n: publicJwk.n, e: publicJwk.e }] }), {
      headers: { "cache-control": "max-age=300" },
    });
  };
  const options = {
    token,
    issuer: "https://app.example",
    audience: identifiers.integration,
    installationId: identifiers.installation,
    fetch,
    now,
  };
  const first = verifyHandoff(options);
  const second = verifyHandoff(options);
  await Promise.resolve();
  assert.equal(fetches, 1);
  release();
  await assert.rejects(() => first, { code: "invalid_handoff" });
  await assert.rejects(() => second, { code: "invalid_handoff" });
  await assert.rejects(() => verifyHandoff(options), { code: "invalid_handoff" });
  assert.equal(fetches, 1);
});

test("confirmation requires Taproot's single-use response to bind to the verified handoff", async () => {
  const claims = {
    userId: identifiers.user, siteId: identifiers.site, installationId: identifiers.installation,
    integrationId: identifiers.integration, credentialId: identifiers.credential, jti: identifiers.jti,
    role: "owner", engagementId: null, issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 300_000).toISOString(),
  };
  const session = await confirmHandoff({
    client: { confirmHandoff: async (input) => ({ ...claims, expiresAt: new Date(now + 3_600_000).toISOString(), input }) },
    claims, token: "verified-token", now,
  });
  assert.equal(session.sessionExpiresAt, new Date(now + 3_600_000).toISOString());
  await assert.rejects(() => confirmHandoff({
    client: { confirmHandoff: async () => ({ ...claims, siteId: identifiers.integration, expiresAt: new Date(now + 3_600_000).toISOString() }) },
    claims, token: "verified-token", now,
  }), { code: "handoff_confirmation_mismatch" });
});
